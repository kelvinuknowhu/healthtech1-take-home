import { z } from "zod";
import { PermanentError } from "../errors";
import type { IngestedFormSchema } from "./schemas/ingested_schema";

const nonEmpty = (field: string) => z.string().trim().min(1, `${field} must not be empty`);

/**
 * Runtime enforcement of the schema we've agreed with the external provider.
 *
 * Unknown keys are *stripped rather than rejected* (zod's default for
 * z.object). The provider adds fields without telling us; refusing healthcare
 * data over a field we simply don't need would be the wrong trade. We still
 * surface the drift - see `findUnknownFields` - so nobody finds out months
 * later. Missing or type-changed fields, by contrast, fail hard: those we
 * genuinely cannot process.
 */
export const ingestedFormSchema = z.object({
	session_id: nonEmpty("session_id"),
	application_reference: nonEmpty("application_reference"),
	name: nonEmpty("name"),
	// A syntactically broken email means the patient cannot be contacted, so
	// this is worth failing on rather than passing downstream.
	email: z.email("email must be a valid email address"),
	gender: z.enum(["male", "female", "other"]),
	// Shape only. Whether the string is a *real* calendar date is checked in
	// the transform, so it can raise a distinct INVALID_DATE_OF_BIRTH code
	// rather than being lumped in with generic schema drift in /stats.
	date_of_birth: nonEmpty("date_of_birth"),
	phone_number: z.string().optional(),
	mobile_number: nonEmpty("mobile_number"),
	address: z.object({
		address_line_1: nonEmpty("address_line_1"),
		address_line_2: nonEmpty("address_line_2"),
		address_line_3: z.string().optional(),
		postcode: nonEmpty("postcode"),
		country: nonEmpty("country"),
	}),
});

export type ValidatedForm = z.infer<typeof ingestedFormSchema>;

/**
 * Compile-time proof that the zod schema and the agreed contract type in
 * ingested_schema.ts cannot silently drift apart. If someone edits one without
 * the other, `npm run typecheck` fails.
 *
 * The normalisation exists because zod infers `phone_number?: string` where the
 * hand-written contract says `phone_number: string | undefined`. Those describe
 * the same data; only the key optionality differs. Indexing through
 * `keyof Required<T>` equalises that without the `-?` modifier's side effect of
 * also stripping `undefined` out of the value type.
 */
type DeepRequiredKeys<T> = T extends object ? { [K in keyof Required<T>]: DeepRequiredKeys<T[K]> } : T;
const _zodSatisfiesContract = (x: DeepRequiredKeys<ValidatedForm>): DeepRequiredKeys<IngestedFormSchema> => x;
const _contractSatisfiesZod = (x: DeepRequiredKeys<IngestedFormSchema>): DeepRequiredKeys<ValidatedForm> => x;

export type FieldIssue = {
	field: string;
	message: string;
	code: string;
};

/** Flattens zod issues into a log/JSON-friendly shape with the failing field path. */
export const toFieldIssues = (error: z.ZodError): FieldIssue[] =>
	error.issues.map((issue) => ({
		field: issue.path.length > 0 ? issue.path.join(".") : "(root)",
		message: issue.message,
		code: issue.code,
	}));

const KNOWN_TOP_LEVEL = new Set(Object.keys(ingestedFormSchema.shape));
const KNOWN_ADDRESS = new Set(Object.keys(ingestedFormSchema.shape.address.shape));

/**
 * Reports fields the provider sent that aren't in the agreed contract.
 *
 * Non-fatal by design, but recorded - undetected schema drift is exactly how
 * you discover six months later that a field you needed was arriving all along
 * under a different name.
 */
export const findUnknownFields = (raw: unknown): string[] => {
	if (typeof raw !== "object" || raw === null) return [];
	const record = raw as Record<string, unknown>;

	const unknown = Object.keys(record).filter((key) => !KNOWN_TOP_LEVEL.has(key));

	const address = record.address;
	if (typeof address === "object" && address !== null) {
		for (const key of Object.keys(address as Record<string, unknown>)) {
			if (!KNOWN_ADDRESS.has(key)) unknown.push(`address.${key}`);
		}
	}

	return unknown;
};

/**
 * Validates a raw payload against the agreed schema.
 *
 * Throws PermanentError, never TransientError: a payload that doesn't match the
 * contract will not start matching it on its own. It needs a code change, then
 * a /retry.
 */
export const validateIngestedForm = (raw: unknown): ValidatedForm => {
	const result = ingestedFormSchema.safeParse(raw);

	if (!result.success) {
		const issues = toFieldIssues(result.error);
		throw new PermanentError(
			"SCHEMA_VALIDATION_FAILED",
			`Payload does not match the agreed schema: ${issues.map((i) => `${i.field} ${i.message}`).join("; ")}`,
			{ issues },
		);
	}

	return result.data;
};
