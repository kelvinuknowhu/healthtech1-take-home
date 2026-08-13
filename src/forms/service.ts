import { config } from "../config";
import { db } from "../db/client";
import type { FormEventType, FormRow } from "../db/schema";
import { PermanentError, classifyHttpFailure, toPipelineError } from "../errors";
import { logger } from "../logger";
import { lookupPostcode } from "../providers/idealpostcodes";
import { nextAttemptAt } from "../backoff";
import { hashPayload } from "./payloadHash";
import * as repo from "./repository";
import { normalisePostcode, transformForm, type Coordinates } from "./transform";
import { findUnknownFields, validateIngestedForm } from "./validation";

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export type IngestOutcome = "created" | "duplicate" | "conflict";

export type IngestResult = {
	outcome: IngestOutcome;
	form: FormRow;
};

const asRecord = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const asNonEmptyString = (value: unknown): string | null =>
	typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

/**
 * Accepts a raw payload and makes it durable, doing as little as possible first.
 *
 * Deliberately does NOT validate the body. If the provider changes the schema
 * overnight, we still want the payload safely on disk - a form we can't parse
 * yet is recoverable, a form we rejected at the door is gone. Parsing happens
 * later, in the worker, where a failure can be captured and replayed.
 */
export const ingestForm = async (rawPayload: unknown): Promise<IngestResult> => {
	const record = asRecord(rawPayload);
	const payloadHash = hashPayload(rawPayload);

	/**
	 * A payload with no session_id has no natural idempotency key. Rather than
	 * reject it (losing healthcare data because the provider misbehaved), we key
	 * it by its own content hash: replays of the identical body still dedupe,
	 * and the form remains visible and replayable.
	 */
	const sessionId = asNonEmptyString(record.session_id) ?? `unkeyed:${payloadHash}`;

	const { form, created } = await repo.insertForm({
		sessionId,
		applicationReference: asNonEmptyString(record.application_reference),
		rawPayload,
		payloadHash,
	});

	if (created) {
		await repo.recordEvent(db, {
			formId: form.id,
			eventType: "RECEIVED",
			detail: { sessionId, synthesisedKey: sessionId.startsWith("unkeyed:") },
		});
		logger.info({ formId: form.id, sessionId }, "form received");
		return { outcome: "created", form };
	}

	if (form.payloadHash === payloadHash) {
		// The expected case: the provider does not guarantee exactly-once
		// delivery, so re-sends are routine and cost us nothing.
		await repo.recordEvent(db, { formId: form.id, eventType: "DUPLICATE_IGNORED" });
		logger.info({ formId: form.id, sessionId }, "duplicate form ignored");
		return { outcome: "duplicate", form };
	}

	/**
	 * Same session_id, different body. We keep the original: the form may
	 * already be with the FORM-BOT, and silently overwriting a patient record
	 * with a conflicting one is far worse than surfacing the conflict for a
	 * human to resolve.
	 */
	await repo.recordEvent(db, {
		formId: form.id,
		eventType: "PAYLOAD_CONFLICT",
		errorCode: "SESSION_ID_REUSED",
		detail: { storedHash: form.payloadHash, incomingHash: payloadHash },
	});
	logger.warn({ formId: form.id, sessionId }, "conflicting payload for existing session_id");
	return { outcome: "conflict", form };
};

// ---------------------------------------------------------------------------
// Geocoding
// ---------------------------------------------------------------------------

const geocode = async (postcode: string): Promise<Coordinates> => {
	const response = await lookupPostcode(postcode);

	if (response.statusCode !== 200 || !response.body) {
		throw classifyHttpFailure(response.statusCode, "GEOCODE_UNAVAILABLE", "GEOCODE_REJECTED", { postcode });
	}

	return { longitude: response.body.longitude, latitude: response.body.latitude };
};

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

export type ProcessOutcome = "ready" | "retry_scheduled" | "failed_validation" | "dead_lettered";

const eventTypeForError = (code: string): FormEventType => {
	if (code === "SCHEMA_VALIDATION_FAILED" || code === "NAME_UNSPLITTABLE" || code === "INVALID_DATE_OF_BIRTH") {
		return "VALIDATION_FAILED";
	}
	if (code.startsWith("GEOCODE")) return "GEOCODE_FAILED";
	return "PROCESSING_FAILED";
};

/**
 * Runs one form through the pipeline: validate, geocode, transform, commit.
 *
 * Exposed as a plain async function rather than being buried inside the worker
 * loop so tests can drive it deterministically, with no timers involved.
 */
export const processForm = async (form: FormRow): Promise<ProcessOutcome> => {
	const log = logger.child({ formId: form.id, sessionId: form.sessionId });

	try {
		/**
		 * Recorded before validation, not after. Unknown fields are most
		 * diagnostically useful precisely when the form goes on to fail - the
		 * provider renaming `date_of_birth` to `dob` shows up here as both a
		 * missing field and an unexpected one, which is the whole story in a
		 * single timeline. Deferring this to the success path would hide it in
		 * exactly the case that matters.
		 */
		const unknownFields = findUnknownFields(form.rawPayload);
		if (unknownFields.length > 0) {
			log.warn({ unknownFields }, "payload contained fields outside the agreed schema");
			await repo.recordEvent(db, {
				formId: form.id,
				eventType: "UNKNOWN_FIELDS",
				errorCode: "SCHEMA_DRIFT",
				detail: { unknownFields },
			});
		}

		const validated = validateIngestedForm(form.rawPayload);

		// Geocode outside the transaction: never hold a database transaction
		// open across a network call that can hang for a second (or forever).
		// Normalised first so the lookup key matches what we go on to store.
		const coordinates = await geocode(normalisePostcode(validated.address.postcode));

		const { transformed, warnings } = transformForm(validated, coordinates);

		const events: repo.EventInput[] = [];

		for (const warning of warnings) {
			log.warn({ code: warning.code }, "transform warning");
			events.push({
				formId: form.id,
				eventType: warning.type,
				errorCode: warning.code,
				detail: warning.detail,
			});
		}

		events.push({ formId: form.id, eventType: "TRANSFORMED" });

		await repo.completeForm({
			form,
			transformed: {
				sessionId: transformed.sessionId,
				applicationReference: transformed.applicationReference,
				firstName: transformed.firstName,
				lastName: transformed.lastName,
				email: transformed.email,
				gender: transformed.gender,
				dateOfBirth: transformed.dateOfBirth,
				phoneNumber: transformed.phoneNumber ?? null,
				mobileNumber: transformed.mobileNumber,
				addressLine1: transformed.addressLine1,
				addressLine2: transformed.addressLine2,
				addressLine3: transformed.addressLine3 ?? null,
				postcode: transformed.postcode,
				country: transformed.country,
				longitude: transformed.longitude,
				latitude: transformed.latitude,
			},
			email: {
				to: config.email.to,
				from: config.email.from,
				subject: `Form ingested: ${transformed.applicationReference}`,
				// Deliberately free of patient identifiers. This is an internal
				// "a form arrived" ping; anyone who needs the detail can look it
				// up by reference, and email is a poor place to keep PII.
				body: [
					`A registration form has been ingested and transformed.`,
					``,
					`Application reference: ${transformed.applicationReference}`,
					`Session id: ${transformed.sessionId}`,
					`Form id: ${form.id}`,
					`Ingested at: ${form.receivedAt.toISOString()}`,
				].join("\n"),
			},
			events,
		});

		log.info("form transformed and ready for FORM-BOT");
		return "ready";
	} catch (error) {
		return handleProcessingFailure(form, error);
	}
};

const handleProcessingFailure = async (form: FormRow, error: unknown): Promise<ProcessOutcome> => {
	const log = logger.child({ formId: form.id, sessionId: form.sessionId });
	const pipelineError = toPipelineError(error);
	const attempts = form.attempts + 1;
	const detail = { message: pipelineError.message, ...(pipelineError.detail as object | undefined) };

	if (pipelineError instanceof PermanentError) {
		// Will fail identically forever. Park it and wait for a human.
		await repo.parkForm(form.id, "FAILED_VALIDATION", {
			attempts,
			errorCode: pipelineError.code,
			detail,
		});
		await repo.recordEvent(db, {
			formId: form.id,
			eventType: eventTypeForError(pipelineError.code),
			errorCode: pipelineError.code,
			detail,
		});
		log.error({ errorCode: pipelineError.code, detail }, "form failed validation - awaiting code fix and /retry");
		return "failed_validation";
	}

	const exhausted = attempts >= config.worker.maxAttempts;

	if (exhausted) {
		await repo.parkForm(form.id, "DEAD_LETTER", { attempts, errorCode: pipelineError.code, detail });
		await repo.recordEvent(db, {
			formId: form.id,
			eventType: "DEAD_LETTERED",
			errorCode: pipelineError.code,
			detail: { ...detail, attempts },
		});
		log.error({ errorCode: pipelineError.code, attempts }, "form dead-lettered after exhausting retries");
		return "dead_lettered";
	}

	const retryAt = nextAttemptAt(attempts);
	await repo.rescheduleForm(form.id, {
		attempts,
		nextAttemptAt: retryAt,
		errorCode: pipelineError.code,
		detail,
	});
	await repo.recordEvent(db, {
		formId: form.id,
		eventType: eventTypeForError(pipelineError.code),
		errorCode: pipelineError.code,
		detail: { ...detail, attempts, retryAt: retryAt.toISOString() },
	});
	log.warn(
		{ errorCode: pipelineError.code, attempts, retryAt: retryAt.toISOString() },
		"transient failure - retry scheduled",
	);
	return "retry_scheduled";
};

/** Convenience for tests and the /retry flow: claim nothing, just run this row. */
export const processFormById = async (formId: string): Promise<ProcessOutcome | "not_found"> => {
	const form = await repo.getFormById(formId);
	if (!form) return "not_found";
	return processForm(form);
};
