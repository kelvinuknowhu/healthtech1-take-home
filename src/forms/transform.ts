import { PermanentError } from "../errors";
import type { FormEventType } from "../db/schema";
import { parseDateOfBirth } from "./dateOfBirth";
import type { TransformedFormSchema } from "./schemas/transformed_schema";
import type { ValidatedForm } from "./validation";

/**
 * Something worth recording that is deliberately *not* fatal.
 *
 * The alternative - failing the form - would reject real patient data over a
 * cosmetic problem. The alternative to *that* - staying silent - loses
 * information. Warnings are the middle path: the form proceeds, and the
 * observation is written to form_events where a human can find it.
 */
export type TransformWarning = {
	type: FormEventType;
	code: string;
	detail: Record<string, unknown>;
};

export type TransformResult = {
	transformed: TransformedFormSchema;
	warnings: TransformWarning[];
};

export type Coordinates = { longitude: number; latitude: number };

const GENDER_MAP: Record<ValidatedForm["gender"], TransformedFormSchema["gender"]> = {
	male: "male",
	female: "female",
	// The target schema has no "other"; "prefer-not-to-say" is its closest
	// equivalent. Worth flagging to the provider - these are not synonyms, and
	// conflating them loses meaning the patient may have intended.
	other: "prefer-not-to-say",
};

/**
 * UK numbers, loosely: 10-11 digits, or international +44 form.
 * Deliberately permissive - this only decides whether to raise a warning,
 * never whether to reject a form.
 */
const isPlausiblePhoneNumber = (value: string): boolean => {
	const digits = value.replace(/[\s()-]/g, "");
	if (/^\+44\d{9,10}$/.test(digits)) return true;
	return /^0\d{9,10}$/.test(digits);
};

/**
 * Shared by the transform and by the geocode call in service.ts, so the
 * postcode we look up is always the same string we store. Without this the
 * provider gets whatever casing the third party happened to send.
 */
export const normalisePostcode = (postcode: string): string => postcode.trim().toUpperCase();

type SplitName = { firstName: string; lastName: string; middleNames: string[]; isMononym: boolean };

/**
 * Splits a single `name` field into the target schema's firstName/lastName.
 *
 * There is no correct answer for a 3+ token name: "Andy James Smith-Jones"
 * could be a middle name or a double-barrelled first name. Rather than
 * discard the ambiguous tokens, we fold them into firstName - the last token
 * becomes lastName, everything before it becomes firstName - so no part of
 * the patient's name is ever lost, only assumed to belong on one side of the
 * split. What was folded in is still recorded, so the assumption is
 * auditable.
 *
 * A single-token name is a mononym, not an error. Legal single names are
 * ordinary across Indonesian, Tamil, Burmese and Icelandic naming conventions,
 * and rejecting those patients would be both wrong and unfixable: no code
 * change makes a one-word name into two, so the form could never be resolved
 * by /retry and would simply be re-failed by the sweeper every night. The name
 * goes in firstName and lastName is left empty, so anything addressing the
 * patient by first name still works.
 */
export const splitName = (fullName: string): SplitName => {
	const tokens = fullName.trim().split(/\s+/).filter(Boolean);

	if (tokens.length === 0) {
		// Defensive: validation already rejects a blank name, so this is
		// unreachable unless the schema is loosened.
		throw new PermanentError("NAME_UNSPLITTABLE", `Cannot derive a name from "${fullName}"`, {
			field: "name",
			tokenCount: 0,
		});
	}

	if (tokens.length === 1) {
		return { firstName: tokens[0], lastName: "", middleNames: [], isMononym: true };
	}

	return {
		firstName: tokens.slice(0, -1).join(" "),
		lastName: tokens[tokens.length - 1],
		middleNames: tokens.slice(1, -1),
		isMononym: false,
	};
};

/**
 * Maps a validated ingested form plus its geocoded coordinates onto the
 * transformed schema. Pure: no I/O, no database, no clock beyond `now`, so it
 * is trivially unit-testable and safe to re-run during a replay.
 */
export const transformForm = (
	input: ValidatedForm,
	coordinates: Coordinates,
	now: Date = new Date(),
): TransformResult => {
	const warnings: TransformWarning[] = [];

	const { firstName, lastName, middleNames, isMononym } = splitName(input.name);
	if (isMononym) {
		// Recorded, not fatal: the form is complete and usable, but a consumer
		// expecting a surname should know there genuinely isn't one.
		warnings.push({
			type: "DATA_QUALITY_WARNING",
			code: "MONONYM",
			detail: { field: "name", rawName: input.name, firstName, lastName },
		});
	}
	if (middleNames.length > 0) {
		warnings.push({
			type: "DATA_QUALITY_WARNING",
			code: "MIDDLE_NAME_MERGED",
			detail: {
				rawName: input.name,
				firstName,
				lastName,
				middleNames,
			},
		});
	}

	const dob = parseDateOfBirth(input.date_of_birth, now);
	if (!dob.ok) {
		throw new PermanentError("INVALID_DATE_OF_BIRTH", `date_of_birth ${dob.reason}`, {
			field: "date_of_birth",
			value: input.date_of_birth,
			reason: dob.reason,
		});
	}

	// Phone quality is reported, never enforced. The agreed contract types these
	// as plain strings, and dropping a healthcare form because an optional
	// landline reads "0001" would be a far worse outcome than a noisy warning.
	for (const [field, value] of [
		["phone_number", input.phone_number],
		["mobile_number", input.mobile_number],
	] as const) {
		if (value !== undefined && !isPlausiblePhoneNumber(value)) {
			warnings.push({
				type: "DATA_QUALITY_WARNING",
				code: "IMPLAUSIBLE_PHONE_NUMBER",
				detail: { field, value },
			});
		}
	}

	const transformed: TransformedFormSchema = {
		sessionId: input.session_id,
		applicationReference: input.application_reference,
		firstName,
		lastName,
		email: input.email,
		gender: GENDER_MAP[input.gender],
		dateOfBirth: dob.value,
		phoneNumber: input.phone_number,
		mobileNumber: input.mobile_number,
		addressLine1: input.address.address_line_1,
		addressLine2: input.address.address_line_2,
		addressLine3: input.address.address_line_3,
		postcode: normalisePostcode(input.address.postcode),
		country: input.address.country,
		longitude: coordinates.longitude,
		latitude: coordinates.latitude,
	};

	return { transformed, warnings };
};
