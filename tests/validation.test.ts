import { PermanentError } from "../src/errors";
import { findUnknownFields, validateIngestedForm } from "../src/forms/validation";
import { hashPayload } from "../src/forms/payloadHash";
import { clone, personOne } from "./helpers/fixtures";

describe("validateIngestedForm", () => {
	it("accepts each provided example payload", () => {
		expect(() => validateIngestedForm(personOne)).not.toThrow();
	});

	it("throws a PermanentError naming the missing field", () => {
		const input = clone(personOne) as Record<string, any>;
		delete input.date_of_birth;

		expect(() => validateIngestedForm(input)).toThrow(PermanentError);

		try {
			validateIngestedForm(input);
		} catch (error) {
			const detail = (error as PermanentError).detail as { issues: { field: string }[] };
			expect((error as PermanentError).code).toBe("SCHEMA_VALIDATION_FAILED");
			expect(detail.issues.map((i) => i.field)).toContain("date_of_birth");
		}
	});

	it("reports the field path for a nested failure", () => {
		const input = clone(personOne) as Record<string, any>;
		delete input.address.postcode;

		try {
			validateIngestedForm(input);
			throw new Error("expected validation to fail");
		} catch (error) {
			const detail = (error as PermanentError).detail as { issues: { field: string }[] };
			expect(detail.issues.map((i) => i.field)).toContain("address.postcode");
		}
	});

	it("rejects a gender value outside the agreed enum", () => {
		const input = clone(personOne) as Record<string, any>;
		input.gender = "unknown";
		expect(() => validateIngestedForm(input)).toThrow(PermanentError);
	});

	it("rejects a malformed email, which would leave the patient uncontactable", () => {
		const input = clone(personOne) as Record<string, any>;
		input.email = "not-an-email";
		expect(() => validateIngestedForm(input)).toThrow(PermanentError);
	});

	it("tolerates unknown fields rather than rejecting the form", () => {
		const input = clone(personOne) as Record<string, any>;
		input.patient_nhs_number = "943 476 5919";

		// The provider adds fields without telling us. That must not stop
		// healthcare data from flowing.
		expect(() => validateIngestedForm(input)).not.toThrow();
	});

	it("strips unknown fields from the validated output", () => {
		const input = clone(personOne) as Record<string, any>;
		input.patient_nhs_number = "943 476 5919";
		expect(validateIngestedForm(input)).not.toHaveProperty("patient_nhs_number");
	});
});

describe("findUnknownFields", () => {
	it("finds nothing in a conforming payload", () => {
		expect(findUnknownFields(personOne)).toEqual([]);
	});

	it("detects a new top-level field", () => {
		const input = clone(personOne) as Record<string, any>;
		input.patient_nhs_number = "943 476 5919";
		expect(findUnknownFields(input)).toEqual(["patient_nhs_number"]);
	});

	it("detects a new nested address field", () => {
		const input = clone(personOne) as Record<string, any>;
		input.address.what3words = "filled.count.soap";
		expect(findUnknownFields(input)).toEqual(["address.what3words"]);
	});

	it("surfaces a renamed field as both unknown and (via validation) missing", () => {
		const input = clone(personOne) as Record<string, any>;
		input.dob = input.date_of_birth;
		delete input.date_of_birth;

		expect(findUnknownFields(input)).toEqual(["dob"]);
		expect(() => validateIngestedForm(input)).toThrow(PermanentError);
	});
});

describe("hashPayload", () => {
	it("is stable across key reordering", () => {
		expect(hashPayload({ a: 1, b: { c: 2, d: 3 } })).toBe(hashPayload({ b: { d: 3, c: 2 }, a: 1 }));
	});

	it("changes when a value changes", () => {
		expect(hashPayload({ a: 1 })).not.toBe(hashPayload({ a: 2 }));
	});

	it("distinguishes a re-sent form from an edited one", () => {
		const edited = clone(personOne) as Record<string, any>;
		edited.email = "someone.else@example.com";
		expect(hashPayload(personOne)).not.toBe(hashPayload(edited));
	});
});
