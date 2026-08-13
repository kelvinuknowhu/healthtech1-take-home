import { PermanentError } from "../src/errors";
import { parseDateOfBirth } from "../src/forms/dateOfBirth";
import { splitName, transformForm } from "../src/forms/transform";
import { validateIngestedForm } from "../src/forms/validation";
import { personOne, personTwo, personThree, clone } from "./helpers/fixtures";

const coordinates = { longitude: 50.05, latitude: -5.05 };

describe("splitName", () => {
	it("splits a simple two-part name", () => {
		expect(splitName("John Doe")).toEqual({
			firstName: "John",
			lastName: "Doe",
			middleNames: [],
			isMononym: false,
		});
	});

	it("folds a middle name into firstName rather than dropping it", () => {
		expect(splitName("Andy James Smith-Jones")).toEqual({
			firstName: "Andy James",
			lastName: "Smith-Jones",
			middleNames: ["James"],
			isMononym: false,
		});
	});

	it("reports every folded-in middle name", () => {
		expect(splitName("Ana Maria Sofia Rodriguez").middleNames).toEqual(["Maria", "Sofia"]);
	});

	it("tolerates extra whitespace", () => {
		expect(splitName("  Jane   Doe  ")).toMatchObject({ firstName: "Jane", lastName: "Doe" });
	});

	it("treats a mononym as a first name with no surname, not an error", () => {
		// Legal single names are ordinary in many naming conventions. Rejecting
		// them would also be unfixable: no code change makes "Cher" two words, so
		// the form could never be resolved by /retry.
		expect(splitName("Cher")).toEqual({
			firstName: "Cher",
			lastName: "",
			middleNames: [],
			isMononym: true,
		});
	});

	it("flags a two-part name as not a mononym", () => {
		expect(splitName("John Doe").isMononym).toBe(false);
	});
});

describe("parseDateOfBirth", () => {
	it("parses a valid ISO date in UTC", () => {
		const result = parseDateOfBirth("1990-01-01");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.toISOString()).toBe("1990-01-01T00:00:00.000Z");
	});

	it("rejects a non-ISO format", () => {
		expect(parseDateOfBirth("01/01/1990")).toMatchObject({ ok: false });
	});

	it("rejects a date that does not exist rather than rolling it over", () => {
		// Plain `new Date("2023-02-30")` would silently become March 2nd.
		expect(parseDateOfBirth("2023-02-30")).toMatchObject({ ok: false, reason: expect.stringMatching(/real calendar/) });
	});

	it("rejects a future date of birth", () => {
		expect(parseDateOfBirth("2999-01-01")).toMatchObject({ ok: false, reason: expect.stringMatching(/future/) });
	});

	it("rejects sentinel junk dates", () => {
		expect(parseDateOfBirth("0001-01-01")).toMatchObject({ ok: false });
	});

	it("accepts a very old but plausible date of birth", () => {
		expect(parseDateOfBirth("1921-03-14").ok).toBe(true);
	});
});

describe("transformForm", () => {
	it("maps the happy path onto the transformed schema", () => {
		const { transformed, warnings } = transformForm(validateIngestedForm(personOne), coordinates);

		expect(warnings).toEqual([]);
		expect(transformed).toMatchObject({
			sessionId: "c8267b77-d796-451e-9948-e82f56412b56",
			applicationReference: "GRU-123089-2026",
			firstName: "John",
			lastName: "Doe",
			gender: "male",
			mobileNumber: "07123456789",
			addressLine1: "Stratford Village Surgery",
			addressLine2: "50C Romford Road",
			addressLine3: "London",
			postcode: "E15 4BZ",
			country: "United Kingdom",
			longitude: 50.05,
			latitude: -5.05,
		});
		expect(transformed.dateOfBirth.toISOString()).toBe("1990-01-01T00:00:00.000Z");
	});

	it('maps gender "other" to "prefer-not-to-say"', () => {
		const { transformed } = transformForm(validateIngestedForm(personTwo), coordinates);
		expect(transformed.gender).toBe("prefer-not-to-say");
	});

	it("warns about an assumed name split instead of failing or silently discarding", () => {
		const { transformed, warnings } = transformForm(validateIngestedForm(personTwo), coordinates);

		expect(transformed.firstName).toBe("Andy James");
		expect(transformed.lastName).toBe("Smith-Jones");
		expect(warnings).toContainEqual(
			expect.objectContaining({
				type: "DATA_QUALITY_WARNING",
				code: "MIDDLE_NAME_MERGED",
				detail: expect.objectContaining({ middleNames: ["James"], rawName: "Andy James Smith-Jones" }),
			}),
		);
	});

	it("warns about an implausible phone number but keeps the value and the form", () => {
		const { transformed, warnings } = transformForm(validateIngestedForm(personTwo), coordinates);

		// "0001" is junk, but the agreed contract types it as a string and
		// rejecting healthcare data over an optional landline is the worse error.
		expect(transformed.phoneNumber).toBe("0001");
		expect(warnings).toContainEqual(
			expect.objectContaining({
				code: "IMPLAUSIBLE_PHONE_NUMBER",
				detail: expect.objectContaining({ field: "phone_number", value: "0001" }),
			}),
		);
	});

	it("handles an absent optional phone_number without warning", () => {
		const { transformed, warnings } = transformForm(validateIngestedForm(personThree), coordinates);

		expect(transformed.phoneNumber).toBeUndefined();
		expect(warnings.filter((w) => w.code === "IMPLAUSIBLE_PHONE_NUMBER")).toEqual([]);
	});

	it("leaves address_line_3 undefined when the provider omits it", () => {
		const { transformed } = transformForm(validateIngestedForm(personThree), coordinates);
		expect(transformed.addressLine3).toBeUndefined();
	});

	it("normalises the postcode for the geocoder", () => {
		const input = clone(personOne) as Record<string, any>;
		input.address.postcode = "  e15 4bz  ";
		const { transformed } = transformForm(validateIngestedForm(input), coordinates);
		expect(transformed.postcode).toBe("E15 4BZ");
	});

	it("transforms a mononym and records why the surname is blank", () => {
		const input = clone(personOne) as Record<string, any>;
		input.name = "Madonna";

		const { transformed, warnings } = transformForm(validateIngestedForm(input), coordinates);

		expect(transformed.firstName).toBe("Madonna");
		expect(transformed.lastName).toBe("");
		expect(warnings).toContainEqual(
			expect.objectContaining({
				code: "MONONYM",
				detail: expect.objectContaining({ rawName: "Madonna" }),
			}),
		);
	});

	it("fails permanently on an impossible date of birth", () => {
		const input = clone(personOne) as Record<string, any>;
		input.date_of_birth = "2023-02-30";
		expect(() => transformForm(validateIngestedForm(input), coordinates)).toThrow(PermanentError);
	});
});
