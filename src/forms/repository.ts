import { and, count, desc, eq, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { config } from "../config";
import { db, type Executor } from "../db/client";
import {
	emailOutbox,
	formEvents,
	forms,
	transformedForms,
	type EmailOutboxRow,
	type FormEventType,
	type FormRow,
	type FormStatus,
	type TransformedFormRow,
} from "../db/schema";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventInput = {
	formId: string;
	eventType: FormEventType;
	errorCode?: string | null;
	detail?: unknown;
};

export const recordEvent = async (exec: Executor, event: EventInput): Promise<void> => {
	await exec.insert(formEvents).values({
		formId: event.formId,
		eventType: event.eventType,
		errorCode: event.errorCode ?? null,
		detail: (event.detail as object | undefined) ?? null,
	});
};

export const getFormEvents = async (formId: string) =>
	db.select().from(formEvents).where(eq(formEvents.formId, formId)).orderBy(formEvents.createdAt, formEvents.id);

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export type InsertFormInput = {
	sessionId: string;
	applicationReference: string | null;
	rawPayload: unknown;
	payloadHash: string;
};

/**
 * Inserts a newly received form, or reports the existing one.
 *
 * `ON CONFLICT DO NOTHING RETURNING` makes this atomic - there is no
 * read-then-write window where two concurrent deliveries of the same form could
 * both decide they are the first. The UNIQUE constraint on session_id is the
 * real guarantee; this is just how we observe it.
 */
export const insertForm = async (
	input: InsertFormInput,
): Promise<{ form: FormRow; created: boolean }> => {
	const [inserted] = await db
		.insert(forms)
		.values({
			sessionId: input.sessionId,
			applicationReference: input.applicationReference,
			rawPayload: input.rawPayload as object,
			payloadHash: input.payloadHash,
		})
		.onConflictDoNothing({ target: forms.sessionId })
		.returning();

	if (inserted) return { form: inserted, created: true };

	const existing = await getFormBySessionId(input.sessionId);
	if (!existing) {
		// Only reachable if the row was deleted between the two statements.
		throw new Error(`Form for session ${input.sessionId} vanished during insert`);
	}
	return { form: existing, created: false };
};

export const getFormById = async (id: string): Promise<FormRow | undefined> => {
	const [row] = await db.select().from(forms).where(eq(forms.id, id)).limit(1);
	return row;
};

export const getFormBySessionId = async (sessionId: string): Promise<FormRow | undefined> => {
	const [row] = await db.select().from(forms).where(eq(forms.sessionId, sessionId)).limit(1);
	return row;
};

export const getTransformedFormByFormId = async (formId: string): Promise<TransformedFormRow | undefined> => {
	const [row] = await db.select().from(transformedForms).where(eq(transformedForms.formId, formId)).limit(1);
	return row;
};

export const getEmailOutboxByFormId = async (formId: string): Promise<EmailOutboxRow | undefined> => {
	const [row] = await db.select().from(emailOutbox).where(eq(emailOutbox.formId, formId)).limit(1);
	return row;
};

// ---------------------------------------------------------------------------
// Worker: claiming and state transitions
// ---------------------------------------------------------------------------

/**
 * Atomically claims up to `limit` forms that are due for processing.
 *
 * FOR UPDATE SKIP LOCKED is what makes this safe to run in several processes at
 * once: each worker locks a disjoint set of rows and never blocks waiting for
 * another worker's batch. Marking them PROCESSING inside the same transaction
 * means the claim survives after the locks are released at commit.
 */
export const claimDueForms = async (limit: number): Promise<FormRow[]> =>
	db.transaction(async (tx) => {
		const due = await tx
			.select({ id: forms.id })
			.from(forms)
			.where(and(eq(forms.status, "PENDING"), lte(forms.nextAttemptAt, new Date())))
			.orderBy(forms.nextAttemptAt)
			.limit(limit)
			.for("update", { skipLocked: true });

		if (due.length === 0) return [];

		return tx
			.update(forms)
			.set({ status: "PROCESSING", claimedAt: new Date(), updatedAt: new Date() })
			.where(
				inArray(
					forms.id,
					due.map((row) => row.id),
				),
			)
			.returning();
	});

/**
 * Returns forms abandoned by a worker that crashed mid-processing to the
 * PENDING pool. Without this, a hard kill would strand rows in PROCESSING
 * forever.
 *
 * The attempt is counted *here*, not only in handleProcessingFailure. That
 * matters: `attempts` exists to stop infinite retries, but the service only
 * increments it from inside its own catch block - and a crash is precisely the
 * case that skips the catch. Without this increment a payload that reliably
 * kills the worker (an OOM during transform, say) is reclaimed at the same
 * count forever, and because the claim orders by next_attempt_at it stays at
 * the head of every batch. The queue would stop draining entirely rather than
 * merely failing to dead-letter one row.
 */
export const reclaimStaleProcessingForms = async (
	leaseMs: number = config.worker.processingLeaseMs,
): Promise<FormRow[]> => {
	const cutoff = new Date(Date.now() - leaseMs);

	// The UPDATE's own WHERE is the compare-and-set: a row that a live worker
	// finishes mid-statement is re-checked against its new version and skipped.
	// The transaction is for the audit trail - a crash partway through the event
	// loop would otherwise leave rows reclaimed with no record of it.
	const reclaimed = await db.transaction(async (tx) => {
		const rows = await tx
			.update(forms)
			.set({
				// Decided in SQL against the row's live value rather than in JS, so
				// the read and the write cannot disagree under concurrency.
				status: sql`case
					when ${forms.attempts} + 1 >= ${config.worker.maxAttempts} then 'DEAD_LETTER'::form_status
					else 'PENDING'::form_status
				end`,
				attempts: sql`${forms.attempts} + 1`,
				claimedAt: null,
				// next_attempt_at is deliberately left alone: it is already in the
				// past, so a form stranded by an ordinary deploy restart resumes on
				// the next tick instead of serving a backoff it did not earn.
				lastErrorCode: "WORKER_CRASHED",
				lastErrorDetail: { claimedBefore: cutoff.toISOString() },
				updatedAt: new Date(),
			})
			.where(and(eq(forms.status, "PROCESSING"), lte(forms.claimedAt, cutoff)))
			.returning();

		for (const form of rows) {
			// RETURNING yields post-update values, so these are the new count and
			// the state the row actually landed in.
			await recordEvent(tx, {
				formId: form.id,
				eventType: "RECLAIMED_STALE",
				errorCode: "WORKER_CRASHED",
				detail: { claimedBefore: cutoff.toISOString(), attempts: form.attempts },
			});

			if (form.status === "DEAD_LETTER") {
				await recordEvent(tx, {
					formId: form.id,
					eventType: "DEAD_LETTERED",
					errorCode: "WORKER_CRASHED",
					detail: { attempts: form.attempts, reason: "repeatedly stranded by a crashing worker" },
				});
			}
		}

		return rows;
	});

	return reclaimed;
};

/**
 * The row as the worker found it. A failure write only lands if the row still
 * looks like this.
 *
 * Reclaiming is driven by a lease, and a lease says nothing about whether the
 * worker is dead - only that it has been quiet. A worker that is merely slow (a
 * provider call with no timeout, a long GC pause) still holds a snapshot from
 * before the reclaim, and writing it back unconditionally would rewind
 * `attempts` and resurrect a row that was just dead-lettered, which is exactly
 * the bound the reclaim increment exists to enforce. Same compare-and-set
 * reasoning as retryForms: restate the predicate so Postgres re-evaluates it
 * against the latest row version.
 */
export type ClaimFence = { status: FormStatus; claimedAt: Date | null };

const stillHeld = (claim: ClaimFence): SQL =>
	and(
		eq(forms.status, claim.status),
		// `is not distinct from` rather than `=`: claimed_at is null on the
		// direct-processing path, and null = null is not true.
		sql`${forms.claimedAt} is not distinct from ${claim.claimedAt}`,
	) as SQL;

/**
 * Transient failure: back to the queue with a later next_attempt_at.
 *
 * Returns false when the claim was lost and the write was discarded.
 */
export const rescheduleForm = async (
	formId: string,
	options: { attempts: number; nextAttemptAt: Date; errorCode: string; detail: unknown; claim: ClaimFence },
): Promise<boolean> => {
	const written = await db
		.update(forms)
		.set({
			status: "PENDING",
			attempts: options.attempts,
			nextAttemptAt: options.nextAttemptAt,
			claimedAt: null,
			lastErrorCode: options.errorCode,
			lastErrorDetail: options.detail as object,
			updatedAt: new Date(),
		})
		.where(and(eq(forms.id, formId), stillHeld(options.claim)))
		.returning({ id: forms.id });

	return written.length > 0;
};

/**
 * Parks a form in a terminal state.
 *
 * FAILED_VALIDATION and DEAD_LETTER are both terminal, but they mean different
 * things: the first needs a code change, the second needs the outage to end.
 * Both are revived only by /retry or the sweeper.
 *
 * Fenced like rescheduleForm, and returns false when the write was discarded.
 */
export const parkForm = async (
	formId: string,
	status: Extract<FormStatus, "FAILED_VALIDATION" | "DEAD_LETTER">,
	options: { attempts: number; errorCode: string; detail: unknown; claim: ClaimFence },
): Promise<boolean> => {
	const written = await db
		.update(forms)
		.set({
			status,
			attempts: options.attempts,
			claimedAt: null,
			lastErrorCode: options.errorCode,
			lastErrorDetail: options.detail as object,
			updatedAt: new Date(),
		})
		.where(and(eq(forms.id, formId), stillHeld(options.claim)))
		.returning({ id: forms.id });

	return written.length > 0;
};

// ---------------------------------------------------------------------------
// The critical transaction
// ---------------------------------------------------------------------------

export type CompleteFormInput = {
	form: FormRow;
	transformed: Omit<typeof transformedForms.$inferInsert, "formId">;
	email: { to: string; from: string; subject: string; body: string };
	events: EventInput[];
};

/**
 * Commits a successful transform: the transformed row, the outbox email and the
 * READY status, all in one transaction.
 *
 * This is the transactional outbox pattern, and the atomicity is the point. If
 * we wrote the transformed form and then sent the email as a separate step, a
 * crash in between would either lose the notification or (if ordered the other
 * way) announce a form that doesn't exist. Committing both together means the
 * only remaining question is *when* the email goes out, not *whether*.
 *
 * `onConflictDoNothing` on both inserts makes the whole operation idempotent, so
 * a replay of an already-completed form is a no-op rather than a duplicate.
 *
 * Deliberately *not* fenced on the claim, unlike the failure writes. A worker
 * whose lease expired mid-transform still did the work correctly, and the
 * unique constraints make committing it twice harmless - throwing that away to
 * honour a reclaim would turn a slow provider call into a lost form. Only the
 * writes that could rewind the retry budget need the fence.
 */
export const completeForm = async (input: CompleteFormInput): Promise<void> => {
	await db.transaction(async (tx) => {
		await tx
			.insert(transformedForms)
			.values({ ...input.transformed, formId: input.form.id })
			.onConflictDoNothing({ target: transformedForms.formId });

		await tx
			.insert(emailOutbox)
			.values({
				formId: input.form.id,
				toAddress: input.email.to,
				fromAddress: input.email.from,
				subject: input.email.subject,
				body: input.email.body,
			})
			.onConflictDoNothing({ target: emailOutbox.formId });

		await tx
			.update(forms)
			.set({
				status: "READY",
				claimedAt: null,
				lastErrorCode: null,
				lastErrorDetail: null,
				updatedAt: new Date(),
			})
			.where(eq(forms.id, input.form.id));

		for (const event of input.events) {
			await recordEvent(tx, event);
		}
	});
};

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

export type RetrySelector = {
	formIds?: string[];
	sessionIds?: string[];
	status?: FormStatus;
	limit?: number;
};

/**
 * Retries parked forms so the worker picks them up again.
 *
 * Attempts reset to zero: the operator is asserting that the world has changed
 * (a fix shipped, an outage ended), so the form deserves a fresh budget.
 */
export const retryForms = async (selector: RetrySelector): Promise<FormRow[]> => {
	const filters: SQL[] = [];
	if (selector.formIds?.length) filters.push(inArray(forms.id, selector.formIds));
	if (selector.sessionIds?.length) filters.push(inArray(forms.sessionId, selector.sessionIds));
	if (selector.status) filters.push(eq(forms.status, selector.status));

	if (filters.length === 0) return [];

	// Never retry a form that already succeeded - that would risk a second
	// notification email for a form the bot may already hold.
	filters.push(sql`${forms.status} <> 'READY'`);

	return db.transaction(async (tx) => {
		// SKIP LOCKED rather than blocking: a row a worker is actively finishing
		// is not a useful retry target, and an operator request should not wait
		// on the pipeline.
		const targets = await tx
			.select({ id: forms.id, status: forms.status, attempts: forms.attempts })
			.from(forms)
			.where(and(...filters))
			.limit(selector.limit ?? 1000)
			.for("update", { skipLocked: true });

		if (targets.length === 0) return [];

		const ids = targets.map((row) => row.id);

		// The filters are repeated here deliberately. Selecting ids and then
		// updating by id alone is a check-then-act race: a form that reaches READY
		// between the two statements would be dragged back to PENDING and
		// reprocessed, defeating the guard above. Restating the predicate makes
		// this a compare-and-set, which Postgres re-evaluates against the latest
		// row version.
		const retried = await tx
			.update(forms)
			.set({
				status: "PENDING",
				attempts: 0,
				nextAttemptAt: new Date(),
				claimedAt: null,
				updatedAt: new Date(),
			})
			.where(and(inArray(forms.id, ids), ...filters))
			.returning();

		// RETURNING yields post-update values, so the pre-update state has to come
		// from the SELECT above or the event records the row we just wrote.
		const before = new Map(targets.map((row) => [row.id, row]));

		for (const form of retried) {
			await recordEvent(tx, {
				formId: form.id,
				eventType: "RETRY_REQUESTED",
				errorCode: form.lastErrorCode,
				detail: {
					previousStatus: before.get(form.id)?.status,
					previousAttempts: before.get(form.id)?.attempts,
				},
			});
		}

		return retried;
	});
};

// ---------------------------------------------------------------------------
// Email outbox relay
// ---------------------------------------------------------------------------

/**
 * Claims due emails, counting the attempt as part of the claim.
 *
 * Incrementing here rather than only in scheduleEmailRetry is what makes the
 * retry budget crash-proof. The relay increments from inside its catch, so a
 * worker killed mid-send (deploy, OOM, liveness probe) never records the
 * attempt - and since the claim orders by next_attempt_at, that row returns to
 * the head of the queue a lease later at the same count, forever.
 *
 * The trade is that `attempts` now means "times we handed this to a worker"
 * rather than "times a send failed", so a restart mid-batch burns an attempt
 * from an email. That is the right way round: an
 * over-counted attempt costs one delayed notification and the nightly sweep
 * revives it, while an under-counted one wedges the relay permanently.
 */
export const claimDueEmails = async (limit: number): Promise<EmailOutboxRow[]> =>
	db.transaction(async (tx) => {
		const due = await tx
			.select({ id: emailOutbox.id, formId: emailOutbox.formId, attempts: emailOutbox.attempts })
			.from(emailOutbox)
			.where(and(eq(emailOutbox.status, "PENDING"), lte(emailOutbox.nextAttemptAt, new Date())))
			.orderBy(emailOutbox.nextAttemptAt)
			.limit(limit)
			.for("update", { skipLocked: true });

		if (due.length === 0) return [];

		/**
		 * A PENDING row already at the limit spent its whole budget without ever
		 * reporting an outcome. Because the code that dead-letters lives in the relay that keeps dying, 
		 * nothing downstream will ever park it either. 
		 * So the claim function has to be the one to give up on it.
		 */
		const exhausted = due.filter((row) => row.attempts >= config.worker.maxAttempts);

		if (exhausted.length > 0) {
			await tx
				.update(emailOutbox)
				.set({ status: "DEAD_LETTER", lastError: "worker crashed before the send could be recorded" })
				.where(
					inArray(
						emailOutbox.id,
						exhausted.map((row) => row.id),
					),
				);

			for (const row of exhausted) {
				await recordEvent(tx, {
					formId: row.formId,
					eventType: "DEAD_LETTERED",
					errorCode: "EMAIL_WORKER_CRASHED",
					detail: { attempts: row.attempts, reason: "repeatedly stranded by a crashing relay" },
				});
			}
		}

		const claimable = due.filter((row) => row.attempts < config.worker.maxAttempts);
		if (claimable.length === 0) return [];

		// Pushing next_attempt_at out acts as a visibility timeout: another
		// worker won't grab the same email while this one is mid-send.
		return tx
			.update(emailOutbox)
			.set({
				attempts: sql`${emailOutbox.attempts} + 1`,
				nextAttemptAt: new Date(Date.now() + config.worker.processingLeaseMs),
			})
			.where(
				inArray(
					emailOutbox.id,
					claimable.map((row) => row.id),
				),
			)
			.returning();
	});

export const markEmailSent = async (id: string, formId: string): Promise<void> => {
	await db.transaction(async (tx) => {
		await tx
			.update(emailOutbox)
			.set({ status: "SENT", sentAt: new Date(), lastError: null })
			.where(eq(emailOutbox.id, id));

		await recordEvent(tx, { formId, eventType: "EMAIL_SENT" });
	});
};

export const rescheduleEmail = async (
	id: string,
	formId: string,
	options: { attempts: number; nextAttemptAt: Date; error: string; dead: boolean },
): Promise<void> => {
	await db.transaction(async (tx) => {
		await tx
			.update(emailOutbox)
			.set({
				status: options.dead ? "DEAD_LETTER" : "PENDING",
				attempts: options.attempts,
				nextAttemptAt: options.nextAttemptAt,
				lastError: options.error,
			})
			.where(eq(emailOutbox.id, id));

		await recordEvent(tx, {
			formId,
			eventType: options.dead ? "DEAD_LETTERED" : "EMAIL_FAILED",
			errorCode: "EMAIL_SEND_FAILED",
			detail: { attempts: options.attempts, error: options.error },
		});
	});
};

export const retryDeadEmails = async (): Promise<number> => {
	const retried = await db
		.update(emailOutbox)
		.set({ status: "PENDING", attempts: 0, nextAttemptAt: new Date() })
		.where(eq(emailOutbox.status, "DEAD_LETTER"))
		.returning({ id: emailOutbox.id });
	return retried.length;
};

// ---------------------------------------------------------------------------
// FORM-BOT handoff
// ---------------------------------------------------------------------------

/**
 * Hands transformed forms to the FORM-BOT, exactly once.
 *
 * The claim and the read are the same statement: a row is returned only if this
 * call is the one that set its delivered_to_bot_at. Two bots polling
 * concurrently cannot both receive the same form - one of them simply doesn't
 * see it.
 */
export const claimFormsForBot = async (limit: number): Promise<TransformedFormRow[]> =>
	db.transaction(async (tx) => {
		const available = await tx
			.select({ id: transformedForms.id })
			.from(transformedForms)
			.where(isNull(transformedForms.deliveredToBotAt))
			.orderBy(transformedForms.createdAt)
			.limit(limit)
			.for("update", { skipLocked: true });

		if (available.length === 0) return [];

		const claimed = await tx
			.update(transformedForms)
			.set({ deliveredToBotAt: new Date() })
			.where(
				inArray(
					transformedForms.id,
					available.map((row) => row.id),
				),
			)
			.returning();

		for (const row of claimed) {
			await recordEvent(tx, { formId: row.formId, eventType: "DELIVERED_TO_BOT" });
		}

		return claimed;
	});

// ---------------------------------------------------------------------------
// Observability
// ---------------------------------------------------------------------------

export const getStats = async () => {
	const [byStatus, byErrorCode, outboxByStatus, eventCounts, undelivered] = await Promise.all([
		db.select({ status: forms.status, count: count() }).from(forms).groupBy(forms.status),
		db
			.select({ errorCode: forms.lastErrorCode, count: count() })
			.from(forms)
			.where(sql`${forms.lastErrorCode} is not null`)
			.groupBy(forms.lastErrorCode),
		db.select({ status: emailOutbox.status, count: count() }).from(emailOutbox).groupBy(emailOutbox.status),
		db
			.select({ eventType: formEvents.eventType, count: count() })
			.from(formEvents)
			.groupBy(formEvents.eventType),
		db
			.select({ count: count() })
			.from(transformedForms)
			.where(isNull(transformedForms.deliveredToBotAt)),
	]);

	const toMap = <T extends string>(rows: { count: number }[], key: (row: any) => T) =>
		rows.reduce<Record<string, number>>((acc, row) => {
			acc[key(row) ?? "unknown"] = row.count;
			return acc;
		}, {});

	return {
		forms: toMap(byStatus, (row) => row.status),
		formFailuresByErrorCode: toMap(byErrorCode, (row) => row.errorCode),
		emailOutbox: toMap(outboxByStatus, (row) => row.status),
		events: toMap(eventCounts, (row) => row.eventType),
		awaitingFormBot: undelivered[0]?.count ?? 0,
	};
};

export const listForms = async (status: FormStatus | undefined, limit: number) =>
	db
		.select()
		.from(forms)
		.where(status ? eq(forms.status, status) : undefined)
		.orderBy(desc(forms.receivedAt))
		.limit(limit);
