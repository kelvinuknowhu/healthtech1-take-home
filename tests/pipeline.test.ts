/**
 * Integration tests for the four guarantees the README asks for:
 * idempotent ingest, exactly-once handoff, guaranteed email, replayable failure.
 *
 * The provider mocks are jest-mocked throughout so their built-in 5% failure
 * rate can never make this suite flaky - failures happen when a test asks for
 * them, and not otherwise.
 */
import { eq } from "drizzle-orm";
import request from "supertest";
import app from "../src/app";
import { db } from "../src/db/client";
import { emailOutbox, forms, transformedForms } from "../src/db/schema";
import * as repo from "../src/forms/repository";
import { ingestForm, processForm, processFormById } from "../src/forms/service";
import { lookupPostcode } from "../src/providers/idealpostcodes";
import { sendEmail } from "../src/providers/sendgrid";
import { sendPendingEmails, type EmailOutcome } from "../src/workers/emailRelay";
import { processDueForms } from "../src/workers/formProcessor";
import { sweepParkedWork } from "../src/workers/sweeper";
import { resetDatabase, teardownDatabase } from "./helpers/db";
import { clone, emailFail, emailOk, geocodeFail, geocodeOk, personTwo, validForm } from "./helpers/fixtures";

jest.mock("../src/providers/idealpostcodes");
jest.mock("../src/providers/sendgrid");

const mockLookupPostcode = lookupPostcode as jest.MockedFunction<typeof lookupPostcode>;
const mockSendEmail = sendEmail as jest.MockedFunction<typeof sendEmail>;

beforeEach(async () => {
	await resetDatabase();
	jest.clearAllMocks();
	mockLookupPostcode.mockResolvedValue(geocodeOk);
	mockSendEmail.mockResolvedValue(emailOk);
});

afterAll(teardownDatabase);

/** Ingest a payload and run it through the pipeline once. */
const ingestAndProcess = async (payload: Record<string, unknown>) => {
	const { form } = await ingestForm(payload);
	const outcome = await processFormById(form.id);
	return { formId: form.id, outcome };
};

// ---------------------------------------------------------------------------

describe("POST /ingest", () => {
	it("accepts a form with 202 and persists it before any processing", async () => {
		const payload = validForm();
		const response = await request(app).post("/ingest").send(payload);

		expect(response.status).toBe(202);
		expect(response.body).toMatchObject({ sessionId: payload.session_id, status: "PENDING" });

		const stored = await repo.getFormById(response.body.formId);
		expect(stored?.rawPayload).toEqual(payload);
	});

	it("stores a payload it cannot parse, rather than rejecting it at the door", async () => {
		// A form we can't parse yet is recoverable; a form we refused is gone.
		const response = await request(app).post("/ingest").send({ session_id: "junk-1", nonsense: true });

		expect(response.status).toBe(202);
		const stored = await repo.getFormById(response.body.formId);
		expect(stored?.rawPayload).toEqual({ session_id: "junk-1", nonsense: true });
	});

	it("keys a payload with no session_id by its content hash so it is still replayable", async () => {
		const response = await request(app).post("/ingest").send({ name: "No Session Id", email: "a@b.com" });

		expect(response.status).toBe(202);
		expect(response.body.sessionId).toMatch(/^unkeyed:[0-9a-f]{64}$/);
	});

	it("rejects a non-object body with 400", async () => {
		const response = await request(app).post("/ingest").send([1, 2, 3]);
		expect(response.status).toBe(400);
	});

	it("returns 400 for malformed JSON instead of an opaque 500", async () => {
		const response = await request(app)
			.post("/ingest")
			.set("Content-Type", "application/json")
			.send('{"session_id": broken}');

		expect(response.status).toBe(400);
		expect(response.body.error).toMatch(/valid JSON/i);
	});
});

describe("idempotency (the provider does not guarantee exactly-once delivery)", () => {
	it("ignores an identical re-delivery and creates no second form", async () => {
		const payload = validForm();

		const first = await request(app).post("/ingest").send(payload);
		const second = await request(app).post("/ingest").send(payload);

		expect(first.status).toBe(202);
		expect(second.status).toBe(200);
		expect(second.body.duplicate).toBe(true);
		expect(second.body.formId).toBe(first.body.formId);

		expect(await db.select().from(forms)).toHaveLength(1);
	});

	it("dedupes even when the provider reorders the JSON keys", async () => {
		const payload = validForm();
		const reordered = Object.fromEntries(Object.entries(payload).reverse());

		await request(app).post("/ingest").send(payload);
		const second = await request(app).post("/ingest").send(reordered);

		expect(second.body.duplicate).toBe(true);
		expect(await db.select().from(forms)).toHaveLength(1);
	});

	it("survives concurrent duplicate deliveries without creating two rows", async () => {
		const payload = validForm();

		const responses = await Promise.all(
			Array.from({ length: 5 }, () => request(app).post("/ingest").send(payload)),
		);

		// Exactly one caller should be told it created the form.
		expect(responses.filter((r) => r.status === 202)).toHaveLength(1);
		expect(responses.filter((r) => r.status === 200)).toHaveLength(4);
		expect(await db.select().from(forms)).toHaveLength(1);
	});

	it("produces exactly one transformed row and one email for a duplicated form", async () => {
		const payload = validForm();
		await request(app).post("/ingest").send(payload);
		await request(app).post("/ingest").send(payload);

		await processDueForms();
		// One outcome, not two: the duplicate never became a second notification.
		expect(await sendPendingEmails()).toEqual(["sent"]);

		expect(await db.select().from(transformedForms)).toHaveLength(1);
		expect(await db.select().from(emailOutbox)).toHaveLength(1);
		expect(mockSendEmail).toHaveBeenCalledTimes(1);
	});

	it("returns 409 and keeps the original when a session_id is reused with a different body", async () => {
		const payload = validForm();
		const first = await request(app).post("/ingest").send(payload);

		const conflicting = { ...clone(payload), email: "someone.else@example.com" };
		const second = await request(app).post("/ingest").send(conflicting);

		expect(second.status).toBe(409);

		// The originally ingested payload is untouched.
		const stored = await repo.getFormById(first.body.formId);
		expect((stored?.rawPayload as Record<string, unknown>).email).toBe(payload.email);

		const events = await repo.getFormEvents(first.body.formId);
		expect(events.map((e) => e.eventType)).toContain("PAYLOAD_CONFLICT");
	});
});

describe("the happy path", () => {
	it("transforms, geocodes and queues exactly one notification email", async () => {
		const { formId, outcome } = await ingestAndProcess(validForm());

		expect(outcome).toBe("ready");

		const form = await repo.getFormById(formId);
		expect(form?.status).toBe("READY");

		const transformed = await repo.getTransformedFormByFormId(formId);
		expect(transformed).toMatchObject({ firstName: "John", lastName: "Doe", longitude: 50.05, latitude: -5.05 });

		const email = await repo.getEmailOutboxByFormId(formId);
		expect(email).toMatchObject({ status: "PENDING", toAddress: "happyforms@bots.com" });
	});

	it("geocodes using the normalised postcode", async () => {
		const payload = validForm();
		(payload.address as Record<string, unknown>).postcode = "e15 4bz";

		await ingestAndProcess(payload);

		expect(mockLookupPostcode).toHaveBeenCalledWith("E15 4BZ");
	});

	it("persists every warning event for a form that exercises all of them", async () => {
		// person_two is the awkward one: an ambiguous 3-token name, gender
		// "other", and a junk phone number. Running it end-to-end (rather than
		// only through the pure transform tests) is what proves every event type
		// the transform can emit is actually writable to the database - a
		// mismatch between the TypeScript enum and the Postgres enum is invisible
		// to a unit test and dead-letters a perfectly valid form in production.
		const payload = { ...clone(personTwo as Record<string, unknown>), session_id: `two-${Date.now()}` };

		const { formId, outcome } = await ingestAndProcess(payload);

		expect(outcome).toBe("ready");

		const events = await repo.getFormEvents(formId);
		const types = events.map((e) => e.eventType);

		expect(types).toContain("DATA_QUALITY_WARNING");
		expect(types).toContain("TRANSFORMED");

		// Both quality observations land under the one event type and are told
		// apart by their code, so assert on the codes rather than the types.
		const codes = events.map((e) => e.errorCode);
		expect(codes).toContain("MIDDLE_NAME_MERGED");
		expect(codes).toContain("IMPLAUSIBLE_PHONE_NUMBER");

		const nameEvent = events.find((e) => e.errorCode === "MIDDLE_NAME_MERGED");
		expect(nameEvent?.eventType).toBe("DATA_QUALITY_WARNING");
		expect(nameEvent?.detail).toMatchObject({ rawName: "Andy James Smith-Jones" });

		const transformed = await repo.getTransformedFormByFormId(formId);
		expect(transformed).toMatchObject({ lastName: "Smith-Jones", gender: "prefer-not-to-say" });
	});

	it("keeps patient identifiers out of the notification email", async () => {
		const { formId } = await ingestAndProcess(validForm());
		const email = await repo.getEmailOutboxByFormId(formId);

		// Internal "a form arrived" ping - email is a poor place to keep PII.
		expect(email?.body).not.toContain("John Doe");
		expect(email?.body).not.toContain("john.doe@example.com");
		expect(email?.body).toContain("GRU-123089-2026");
	});
});

describe("transient failures are retried automatically", () => {
	it("reschedules with backoff when the geocoder is down, without touching the outbox", async () => {
		mockLookupPostcode.mockResolvedValue(geocodeFail);

		const { formId, outcome } = await ingestAndProcess(validForm());

		expect(outcome).toBe("retry_scheduled");

		const form = await repo.getFormById(formId);
		expect(form).toMatchObject({ status: "PENDING", attempts: 1, lastErrorCode: "GEOCODE_UNAVAILABLE" });
		expect(form!.nextAttemptAt.getTime()).toBeGreaterThan(form!.receivedAt.getTime());

		// No partial state: nothing transformed, and crucially no email claiming
		// a form was ingested when it wasn't.
		expect(await db.select().from(transformedForms)).toHaveLength(0);
		expect(await db.select().from(emailOutbox)).toHaveLength(0);
	});

	it("recovers on a later attempt once the provider comes back", async () => {
		mockLookupPostcode.mockResolvedValueOnce(geocodeFail).mockResolvedValue(geocodeOk);

		const { form } = await ingestForm(validForm());

		expect(await processFormById(form.id)).toBe("retry_scheduled");
		expect(await processFormById(form.id)).toBe("ready");

		expect((await repo.getFormById(form.id))?.status).toBe("READY");
	});

	it("dead-letters only after exhausting the attempt budget", async () => {
		mockLookupPostcode.mockResolvedValue(geocodeFail);
		const { form } = await ingestForm(validForm());

		// MAX_ATTEMPTS is 3 in the test environment.
		expect(await processFormById(form.id)).toBe("retry_scheduled");
		expect(await processFormById(form.id)).toBe("retry_scheduled");
		expect(await processFormById(form.id)).toBe("dead_lettered");

		const parked = await repo.getFormById(form.id);
		expect(parked).toMatchObject({ status: "DEAD_LETTER", attempts: 3 });
	});

	it("treats an unexpected crash as transient rather than losing the form", async () => {
		mockLookupPostcode.mockRejectedValue(new Error("socket hang up"));

		const { formId, outcome } = await ingestAndProcess(validForm());

		expect(outcome).toBe("retry_scheduled");
		expect((await repo.getFormById(formId))?.lastErrorCode).toBe("UNEXPECTED_ERROR");
	});
});

describe("permanent failures park for a code fix", () => {
	it("parks a schema mismatch in FAILED_VALIDATION with the failing field recorded", async () => {
		const broken = validForm();
		delete (broken as Record<string, unknown>).date_of_birth;

		const { formId, outcome } = await ingestAndProcess(broken);

		expect(outcome).toBe("failed_validation");

		const form = await repo.getFormById(formId);
		expect(form).toMatchObject({ status: "FAILED_VALIDATION", lastErrorCode: "SCHEMA_VALIDATION_FAILED" });
		expect(JSON.stringify(form?.lastErrorDetail)).toContain("date_of_birth");
	});

	it("does not retry a validation failure on subsequent worker ticks", async () => {
		const broken = validForm();
		delete (broken as Record<string, unknown>).date_of_birth;
		await ingestAndProcess(broken);

		mockLookupPostcode.mockClear();
		await processDueForms();
		await processDueForms();

		// A parked form is invisible to the worker: it would fail identically
		// every time, so retrying it is pure noise.
		expect(mockLookupPostcode).not.toHaveBeenCalled();
	});

	it("never emails about a form that failed to transform", async () => {
		const broken = validForm();
		broken.gender = "unknown";

		await ingestAndProcess(broken);
		// Empty rather than a failure outcome: there was nothing to claim.
		expect(await sendPendingEmails()).toEqual([]);

		expect(await db.select().from(emailOutbox)).toHaveLength(0);
		expect(mockSendEmail).not.toHaveBeenCalled();
	});

	it("records unknown fields even when the form goes on to fail validation", async () => {
		const drifted = validForm() as Record<string, any>;
		drifted.dob = drifted.date_of_birth;
		delete drifted.date_of_birth;

		const { formId } = await ingestAndProcess(drifted);

		const events = await repo.getFormEvents(formId);
		const types = events.map((e) => e.eventType);

		// The renamed field shows up as both unexpected and missing - the whole
		// story of the drift, in one timeline.
		expect(types).toContain("UNKNOWN_FIELDS");
		expect(types).toContain("VALIDATION_FAILED");
		expect(JSON.stringify(events.find((e) => e.eventType === "UNKNOWN_FIELDS")?.detail)).toContain("dob");
	});
});

describe("the guaranteed email (transactional outbox)", () => {
	it("sends the queued email and marks it SENT", async () => {
		const { formId } = await ingestAndProcess(validForm());

		expect(await sendPendingEmails()).toEqual(["sent"]);

		const email = await repo.getEmailOutboxByFormId(formId);
		expect(email).toMatchObject({ status: "SENT" });
		expect(email?.sentAt).not.toBeNull();
	});

	it("retries a failed send and eventually delivers", async () => {
		await ingestAndProcess(validForm());

		mockSendEmail.mockResolvedValueOnce(emailFail);
		expect(await sendPendingEmails()).toEqual(["retry_scheduled"]);

		// Due immediately again thanks to the tiny test backoff.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(await sendPendingEmails()).toEqual(["sent"]);

		expect(mockSendEmail).toHaveBeenCalledTimes(2);
	});

	it("does not resend an email that already went out", async () => {
		await ingestAndProcess(validForm());
		expect(await sendPendingEmails()).toEqual(["sent"]);

		mockSendEmail.mockClear();
		// A SENT row is no longer claimable, so later drains find nothing at all.
		expect(await sendPendingEmails()).toEqual([]);
		expect(await sendPendingEmails()).toEqual([]);

		expect(mockSendEmail).not.toHaveBeenCalled();
	});

	it("dead-letters the email after exhausting retries, leaving the form READY", async () => {
		const { formId } = await ingestAndProcess(validForm());
		mockSendEmail.mockResolvedValue(emailFail);

		const outcomes: EmailOutcome[][] = [];
		for (let i = 0; i < 3; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			outcomes.push(await sendPendingEmails());
		}

		// The budget is spent one attempt at a time, and only the last one gives up.
		expect(outcomes).toEqual([["retry_scheduled"], ["retry_scheduled"], ["dead_lettered"]]);
		expect((await repo.getEmailOutboxByFormId(formId))?.status).toBe("DEAD_LETTER");
		// The form itself transformed fine; only the notification failed.
		expect((await repo.getFormById(formId))?.status).toBe("READY");
	});

	it("re-queues the email exactly once when a completed form is replayed", async () => {
		const { formId } = await ingestAndProcess(validForm());
		await sendPendingEmails();

		// Force a replay of an already-completed form.
		await processFormById(formId);

		// UNIQUE(form_id) means the replay cannot enqueue a second notification.
		expect(await db.select().from(emailOutbox).where(eq(emailOutbox.formId, formId))).toHaveLength(1);
	});
});

describe("POST /retry - capture, fix, replay", () => {
	it("replays a parked form successfully once the underlying problem is fixed", async () => {
		// A payload that fails today because the geocoder is down...
		mockLookupPostcode.mockResolvedValue(geocodeFail);
		const { form } = await ingestForm(validForm());
		await processFormById(form.id);
		await processFormById(form.id);
		await processFormById(form.id);
		expect((await repo.getFormById(form.id))?.status).toBe("DEAD_LETTER");

		// ...the outage ends...
		mockLookupPostcode.mockResolvedValue(geocodeOk);

		// ...and an operator replays it.
		const response = await request(app).post("/retry").send({ status: "DEAD_LETTER", processNow: true });

		expect(response.status).toBe(200);
		expect(response.body.retried).toBe(1);
		expect((await repo.getFormById(form.id))?.status).toBe("READY");
	});

	it("replays from the stored raw payload after a validation fix ships", async () => {
		const broken = validForm();
		broken.gender = "nonbinary"; // not in the agreed enum today

		const { form } = await ingestForm(broken);
		await processFormById(form.id);
		expect((await repo.getFormById(form.id))?.status).toBe("FAILED_VALIDATION");

		// Simulate deploying a code change that understands the new value.
		const validation = require("../src/forms/validation");
		const original = validation.validateIngestedForm;
		const patched = jest
			.spyOn(validation, "validateIngestedForm")
			.mockImplementation((raw: any) => original({ ...raw, gender: "other" }));

		try {
			const response = await request(app).post("/retry").send({ status: "FAILED_VALIDATION", processNow: true });

			expect(response.body.retried).toBe(1);
			const replayed = await repo.getFormById(form.id);
			expect(replayed?.status).toBe("READY");
			// Replayed from the payload we stored at ingest - nothing was re-sent.
			expect((replayed?.rawPayload as Record<string, unknown>).gender).toBe("nonbinary");
			expect((await repo.getTransformedFormByFormId(form.id))?.gender).toBe("prefer-not-to-say");
		} finally {
			patched.mockRestore();
		}
	});

	it("retries a single form by id", async () => {
		const broken = validForm();
		delete (broken as Record<string, unknown>).mobile_number;
		const { formId } = await ingestAndProcess(broken);

		const response = await request(app).post("/retry").send({ formIds: [formId] });

		expect(response.body.retried).toBe(1);
		expect((await repo.getFormById(formId))?.status).toBe("PENDING");
		// A fresh budget: the operator asserted the world changed.
		expect((await repo.getFormById(formId))?.attempts).toBe(0);
	});

	it("refuses to retry a form that already succeeded", async () => {
		const { formId } = await ingestAndProcess(validForm());

		const response = await request(app).post("/retry").send({ formIds: [formId] });

		// Re-running a READY form risks a second notification for a form the bot
		// may already hold.
		expect(response.body.retried).toBe(0);
		expect((await repo.getFormById(formId))?.status).toBe("READY");
	});

	it("requires a selector", async () => {
		const response = await request(app).post("/retry").send({});
		expect(response.status).toBe(400);
	});
});

describe("the nightly sweep", () => {
	it("retries dead-lettered forms so a transient outage heals unattended", async () => {
		mockLookupPostcode.mockResolvedValue(geocodeFail);
		const { form } = await ingestForm(validForm());
		for (let i = 0; i < 3; i++) await processFormById(form.id);
		expect((await repo.getFormById(form.id))?.status).toBe("DEAD_LETTER");

		mockLookupPostcode.mockResolvedValue(geocodeOk);
		const result = await sweepParkedWork();

		expect(result.deadLetteredForms).toBe(1);
		await processDueForms();
		expect((await repo.getFormById(form.id))?.status).toBe("READY");
	});

	/**
	 * Worth being explicit about, because it bounds the crash-loop guarantee: the
	 * sweep resets `attempts` to zero, and it cannot tell a form parked by three
	 * crashes from one parked by a provider outage. So "three crashes and it
	 * parks" is a per-sweep bound, not an absolute one.
	 */
	it("gives a crash-parked form a fresh budget, so the crash bound is nightly rather than absolute", async () => {
		const { form } = await ingestForm(validForm());

		const crashThreeTimes = async () => {
			for (let i = 0; i < 3; i++) {
				await db
					.update(forms)
					.set({ status: "PROCESSING", claimedAt: new Date(Date.now() - 120_000) })
					.where(eq(forms.id, form.id));
				await repo.reclaimStaleProcessingForms();
			}
		};

		await crashThreeTimes();
		expect(await repo.getFormById(form.id)).toMatchObject({
			status: "DEAD_LETTER",
			attempts: 3,
			lastErrorCode: "WORKER_CRASHED",
		});

		expect((await sweepParkedWork()).deadLetteredForms).toBe(1);
		expect(await repo.getFormById(form.id)).toMatchObject({ status: "PENDING", attempts: 0 });

		// So a payload that still kills the worker burns a full budget again
		// tonight - and, because the batch is processed concurrently, takes an
		// attempt off every healthy form it was claimed alongside.
		await crashThreeTimes();
		expect(await repo.getFormById(form.id)).toMatchObject({ status: "DEAD_LETTER", attempts: 3 });

		// The trade it buys: once the cause is gone, the form heals unattended.
		expect((await sweepParkedWork()).deadLetteredForms).toBe(1);
		expect(await processDueForms()).toEqual(["ready"]);
		expect((await repo.getFormById(form.id))?.status).toBe("READY");
	});

	it("retries dead-lettered emails", async () => {
		const { formId } = await ingestAndProcess(validForm());
		mockSendEmail.mockResolvedValue(emailFail);
		let outcomes: EmailOutcome[] = [];
		for (let i = 0; i < 3; i++) {
			await new Promise((resolve) => setTimeout(resolve, 5));
			outcomes = await sendPendingEmails();
		}
		expect(outcomes).toEqual(["dead_lettered"]);
		expect((await repo.getEmailOutboxByFormId(formId))?.status).toBe("DEAD_LETTER");

		mockSendEmail.mockResolvedValue(emailOk);
		expect((await sweepParkedWork()).deadLetteredEmails).toBe(1);

		// Claimable again after the sweep - a dead letter is parked, not lost.
		expect(await sendPendingEmails()).toEqual(["sent"]);
		expect((await repo.getEmailOutboxByFormId(formId))?.status).toBe("SENT");
	});
});

describe("GET /forms/ready - the FORM-BOT must never see a form twice", () => {
	it("hands each form out exactly once", async () => {
		await ingestAndProcess(validForm());
		await ingestAndProcess(validForm());

		const first = await request(app).get("/forms/ready");
		const second = await request(app).get("/forms/ready");

		expect(first.body.count).toBe(2);
		expect(second.body.count).toBe(0);
	});

	it("gives no form to two concurrent pollers", async () => {
		for (let i = 0; i < 5; i++) await ingestAndProcess(validForm());

		const [a, b, c] = await Promise.all([
			repo.claimFormsForBot(10),
			repo.claimFormsForBot(10),
			repo.claimFormsForBot(10),
		]);

		const ids = [...a, ...b, ...c].map((row) => row.id);
		expect(ids).toHaveLength(5);
		expect(new Set(ids).size).toBe(5);
	});

	it("respects the limit and hands out the rest on the next call", async () => {
		for (let i = 0; i < 3; i++) await ingestAndProcess(validForm());

		expect((await request(app).get("/forms/ready?limit=2")).body.count).toBe(2);
		expect((await request(app).get("/forms/ready?limit=2")).body.count).toBe(1);
		expect((await request(app).get("/forms/ready?limit=2")).body.count).toBe(0);
	});

	it("never offers a form that failed to transform", async () => {
		const broken = validForm();
		broken.gender = "unknown";
		await ingestAndProcess(broken);

		expect((await request(app).get("/forms/ready")).body.count).toBe(0);
	});
});

describe("crash recovery", () => {
	it("reclaims a form stranded in PROCESSING by a crashed worker", async () => {
		const { form } = await ingestForm(validForm());

		// Simulate a worker that claimed the row and then died.
		await db
			.update(forms)
			.set({ status: "PROCESSING", claimedAt: new Date(Date.now() - 120_000) })
			.where(eq(forms.id, form.id));

		await processDueForms();

		expect((await repo.getFormById(form.id))?.status).toBe("READY");
	});

	/**
	 * The regression these two guard against: `attempts` used to be incremented
	 * only inside the service's own catch block, which a crash skips by
	 * definition. A payload that killed the worker was therefore reclaimed at the
	 * same count forever, and because both claims order by next_attempt_at, the stuck record sat
	 * at the head of every batch - so the queue could stop draining entirely.
	 */
	it("counts an attempt each time it reclaims, so a crash loop cannot run forever", async () => {
		const { form } = await ingestForm(validForm());

		// A worker that claims the row and dies before its error handler runs.
		const strandInProcessing = () =>
			db
				.update(forms)
				.set({ status: "PROCESSING", claimedAt: new Date(Date.now() - 120_000) })
				.where(eq(forms.id, form.id));

		// MAX_ATTEMPTS is 3 in tests, so the third crash exhausts the budget.
		await strandInProcessing();
		await repo.reclaimStaleProcessingForms();
		expect(await repo.getFormById(form.id)).toMatchObject({ status: "PENDING", attempts: 1 });

		await strandInProcessing();
		await repo.reclaimStaleProcessingForms();
		expect(await repo.getFormById(form.id)).toMatchObject({ status: "PENDING", attempts: 2 });

		await strandInProcessing();
		await repo.reclaimStaleProcessingForms();
		expect(await repo.getFormById(form.id)).toMatchObject({ status: "DEAD_LETTER", attempts: 3 });

		const events = await repo.getFormEvents(form.id);
		expect(events.map((event) => event.eventType)).toEqual(
			expect.arrayContaining(["RECLAIMED_STALE", "DEAD_LETTERED"]),
		);
	});

	it("counts the email attempt at claim time, so a crashing relay cannot retry forever", async () => {
		const { formId } = await ingestAndProcess(validForm());

		// A relay that claims the row and dies mid-send: the claim runs, the
		// outcome never does.
		const makeDue = () =>
			db
				.update(emailOutbox)
				.set({ nextAttemptAt: new Date(Date.now() - 1_000) })
				.where(eq(emailOutbox.formId, formId));

		for (const expectedAttempts of [1, 2, 3]) {
			await makeDue();
			expect(await repo.claimDueEmails(10)).toHaveLength(1);
			expect((await repo.getEmailOutboxByFormId(formId))?.attempts).toBe(expectedAttempts);
		}

		// Budget spent with nothing to show for it. Nothing downstream can park
		// this row - the code that dead-letters lives in the relay that keeps
		// dying - so the claim itself has to give up on it.
		await makeDue();
		expect(await repo.claimDueEmails(10)).toEqual([]);
		expect((await repo.getEmailOutboxByFormId(formId))?.status).toBe("DEAD_LETTER");
		expect(mockSendEmail).not.toHaveBeenCalled();
	});

	it("counts a failed send exactly once, now that the claim also counts", async () => {
		const { formId } = await ingestAndProcess(validForm());
		mockSendEmail.mockResolvedValueOnce(emailFail);

		expect(await sendPendingEmails()).toEqual(["retry_scheduled"]);
		expect((await repo.getEmailOutboxByFormId(formId))?.attempts).toBe(1);
	});

	it("does not let one crash-looping email block the rest of the queue", async () => {
		const poison = await ingestAndProcess(validForm());
		const healthy = await ingestAndProcess(validForm());

		const poisonToHeadOfQueue = () =>
			db
				.update(emailOutbox)
				.set({ nextAttemptAt: new Date(Date.now() - 10_000) })
				.where(eq(emailOutbox.formId, poison.formId));

		// Spend the first email's budget without ever recording an outcome.
		for (let i = 0; i < 3; i++) {
			await poisonToHeadOfQueue();
			await repo.claimDueEmails(1);
		}

		// A batch size of one makes the head-of-line effect visible: the poison
		// row is alone in the batch, so nothing else can go out behind it.
		await poisonToHeadOfQueue();
		expect(await sendPendingEmails(1)).toEqual([]);
		expect((await repo.getEmailOutboxByFormId(poison.formId))?.status).toBe("DEAD_LETTER");

		// With it parked, the queue drains again.
		expect(await sendPendingEmails(1)).toEqual(["sent"]);
		expect((await repo.getEmailOutboxByFormId(healthy.formId))?.status).toBe("SENT");
	});

	/**
	 * The other half of counting attempts at reclaim time: a lease says only that
	 * a worker has gone quiet, not that it has died. These two pin down what
	 * happens when it was merely slow and comes back after the row was reclaimed.
	 */
	const staleClaim = () => new Date(Date.now() - 120_000);

	it("discards the outcome of a worker that turned out to be slow, not dead", async () => {
		const { form } = await ingestForm(validForm());

		// A worker claims the row and then stalls - a provider call with no
		// timeout, say. Nothing hands the row back; the lease just expires under it.
		await repo.claimDueForms(1);
		await db.update(forms).set({ claimedAt: staleClaim() }).where(eq(forms.id, form.id));
		const inFlight = (await repo.getFormById(form.id))!;
		expect(inFlight).toMatchObject({ status: "PROCESSING", attempts: 0 });

		// Three leases go by while it is still hung. Each expiry is reclaimed and
		// picked up by another worker, and the third exhausts the budget.
		for (let i = 0; i < 3; i++) {
			await db
				.update(forms)
				.set({ status: "PROCESSING", claimedAt: staleClaim() })
				.where(eq(forms.id, form.id));
			await repo.reclaimStaleProcessingForms();
		}
		expect(await repo.getFormById(form.id)).toMatchObject({ status: "DEAD_LETTER", attempts: 3 });

		// The original worker finally returns with a failure, holding a snapshot
		// from before any of that. Writing it back unconditionally would resurrect
		// the dead letter as PENDING and rewind attempts to 1 - undoing the exact
		// bound the reclaim increment exists to enforce - so it is discarded.
		mockLookupPostcode.mockResolvedValue(geocodeFail);
		expect(await processForm(inFlight)).toBe("claim_lost");
		expect(await repo.getFormById(form.id)).toMatchObject({
			status: "DEAD_LETTER",
			attempts: 3,
			lastErrorCode: "WORKER_CRASHED",
		});
	});

	it("keeps the work of a slow worker that succeeds after its lease expired", async () => {
		const { form } = await ingestForm(validForm());

		await repo.claimDueForms(1);
		await db.update(forms).set({ claimedAt: staleClaim() }).where(eq(forms.id, form.id));
		const inFlight = (await repo.getFormById(form.id))!;

		// Reclaimed and transformed by a second worker while the first is still out.
		await repo.reclaimStaleProcessingForms();
		expect(await processDueForms()).toEqual(["ready"]);

		// The slow worker now succeeds too. A completed transform is real work, so
		// unlike a failure it is allowed to land - the unique constraints make the
		// second commit a no-op rather than a duplicate form, transform or email.
		expect(await processForm(inFlight)).toBe("ready");
		expect((await repo.getFormById(form.id))?.status).toBe("READY");
		expect(await db.select().from(transformedForms).where(eq(transformedForms.formId, form.id))).toHaveLength(1);
		expect(await db.select().from(emailOutbox).where(eq(emailOutbox.formId, form.id))).toHaveLength(1);
	});
});

describe("GET /forms/:id and /stats", () => {
	it("returns the form, its transform, its email and the full event timeline", async () => {
		const { formId } = await ingestAndProcess(validForm());
		await sendPendingEmails();

		const response = await request(app).get(`/forms/${formId}`);

		expect(response.status).toBe(200);
		expect(response.body.transformed).not.toBeNull();
		expect(response.body.email.status).toBe("SENT");
		expect(response.body.events.map((e: { eventType: string }) => e.eventType)).toEqual(
			expect.arrayContaining(["RECEIVED", "TRANSFORMED", "EMAIL_SENT"]),
		);
	});

	it("returns 400 for a non-uuid id rather than a database error", async () => {
		expect((await request(app).get("/forms/not-a-uuid")).status).toBe(400);
	});

	it("returns 404 for an unknown form", async () => {
		expect((await request(app).get("/forms/2b1e5a3c-0000-4000-8000-000000000000")).status).toBe(404);
	});

	it("counts failures by type so an incident can be sized immediately", async () => {
		await ingestAndProcess(validForm());

		const broken = validForm();
		delete (broken as Record<string, unknown>).date_of_birth;
		await ingestAndProcess(broken);

		mockLookupPostcode.mockResolvedValue(geocodeFail);
		await ingestAndProcess(validForm());

		const response = await request(app).get("/stats");

		expect(response.body.forms).toMatchObject({ READY: 1, FAILED_VALIDATION: 1, PENDING: 1 });
		expect(response.body.formFailuresByErrorCode).toMatchObject({
			SCHEMA_VALIDATION_FAILED: 1,
			GEOCODE_UNAVAILABLE: 1,
		});
		expect(response.body.awaitingFormBot).toBe(1);
	});

	it("reports database reachability on /health", async () => {
		const response = await request(app).get("/health");
		expect(response.body).toMatchObject({ status: "ok", database: "reachable" });
	});
});
