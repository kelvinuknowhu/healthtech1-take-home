import { sql } from "drizzle-orm";
import {
	bigserial,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgEnum,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	date,
} from "drizzle-orm/pg-core";

/**
 * Form lifecycle.
 *
 *   PENDING ──claim──► PROCESSING ──success──► READY
 *      ▲                    │
 *      │                    ├─transient fail─► PENDING (attempts+1, backoff)
 *      │                    │                     └─exhausted─► DEAD_LETTER
 *      └──/retry or sweep───┴─permanent fail─► FAILED_VALIDATION
 *
 * The split between FAILED_VALIDATION and DEAD_LETTER is the heart of the
 * design: a schema mismatch will fail identically on every retry until a human
 * ships a code change, so auto-retrying it just burns attempts. A provider 500
 * is worth retrying immediately and automatically.
 */
export const formStatus = pgEnum("form_status", [
	"PENDING",
	"PROCESSING",
	"READY",
	"FAILED_VALIDATION",
	"DEAD_LETTER",
]);

export const outboxStatus = pgEnum("outbox_status", ["PENDING", "SENT", "DEAD_LETTER"]);

/** Target schema's gender values (note: ingested "other" maps to "prefer-not-to-say"). */
export const transformedGender = pgEnum("transformed_gender", ["male", "female", "prefer-not-to-say"]);

export const formEventType = pgEnum("form_event_type", [
	"RECEIVED",
	"DUPLICATE_IGNORED",
	"PAYLOAD_CONFLICT",
	"UNKNOWN_FIELDS",
	"VALIDATION_FAILED",
	"GEOCODE_FAILED",
	"PROCESSING_FAILED",
	// One event type for every "usable but imperfect" observation. Which
	// observation it was lives in the event's `code` field - MONONYM,
	// MIDDLE_NAME_MERGED, IMPLAUSIBLE_PHONE_NUMBER - which is plain text and
	// needs no migration when the set grows or a strategy changes.
	"DATA_QUALITY_WARNING",
	"TRANSFORMED",
	"EMAIL_SENT",
	"EMAIL_FAILED",
	"RETRY_REQUESTED",
	"DEAD_LETTERED",
	"RECLAIMED_STALE",
	"DELIVERED_TO_BOT",
]);

/**
 * Every payload we have ever been sent, stored verbatim before any parsing.
 *
 * This is the claim-check: because the raw body is durable from the first
 * moment, any form can be replayed from scratch after a code fix ships. It also
 * doubles as the job queue - `status` + `next_attempt_at` are what the worker
 * polls, avoiding a separate queue system at this scale.
 */
export const forms = pgTable(
	"forms",
	{
		id: uuid("id").primaryKey().defaultRandom(),

		/**
		 * Idempotency key. The third party does not guarantee exactly-once
		 * delivery, so this UNIQUE constraint - not application logic - is what
		 * makes duplicate submissions harmless.
		 */
		sessionId: text("session_id").notNull(),

		/** Best-effort extract; a malformed payload may not have one. */
		applicationReference: text("application_reference"),

		rawPayload: jsonb("raw_payload").notNull(),

		/** sha256 of the canonicalised body: distinguishes a true duplicate from
		 *  a different form sent under a recycled session_id. */
		payloadHash: text("payload_hash").notNull(),

		status: formStatus("status").notNull().default("PENDING"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),

		/** Set while a worker holds the row; used to reclaim after a crash. */
		claimedAt: timestamp("claimed_at", { withTimezone: true }),

		lastErrorCode: text("last_error_code"),
		lastErrorDetail: jsonb("last_error_detail"),

		receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("forms_session_id_key").on(table.sessionId),
		// Partial index: the worker's hot query only ever looks at PENDING rows,
		// so the index stays small no matter how many forms are READY.
		index("forms_due_idx")
			.on(table.nextAttemptAt)
			.where(sql`${table.status} = 'PENDING'`),
		index("forms_status_idx").on(table.status),
		// Supports reclaiming rows abandoned by a crashed worker.
		index("forms_claimed_idx")
			.on(table.claimedAt)
			.where(sql`${table.status} = 'PROCESSING'`),
	],
);

/**
 * The FORM-BOT-facing table: a 1:1 mirror of transformed_schema.ts.
 *
 * The UNIQUE constraint on form_id is what structurally guarantees "never give
 * the FORM-BOT the same form twice". Even if the pipeline runs twice for the
 * same form (crash mid-transaction, double /retry, two workers racing), the
 * database refuses to create a second row.
 */
export const transformedForms = pgTable(
	"transformed_forms",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		formId: uuid("form_id")
			.notNull()
			.references(() => forms.id, { onDelete: "cascade" }),

		sessionId: text("session_id").notNull(),
		applicationReference: text("application_reference").notNull(),
		firstName: text("first_name").notNull(),
		lastName: text("last_name").notNull(),
		email: text("email").notNull(),
		gender: transformedGender("gender").notNull(),
		dateOfBirth: date("date_of_birth", { mode: "date" }).notNull(),
		phoneNumber: text("phone_number"),
		mobileNumber: text("mobile_number").notNull(),
		addressLine1: text("address_line_1").notNull(),
		addressLine2: text("address_line_2").notNull(),
		addressLine3: text("address_line_3"),
		postcode: text("postcode").notNull(),
		country: text("country").notNull(),
		longitude: doublePrecision("longitude").notNull(),
		latitude: doublePrecision("latitude").notNull(),

		/** Stamped atomically when handed to the FORM-BOT; the claim marker. */
		deliveredToBotAt: timestamp("delivered_to_bot_at", { withTimezone: true }),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("transformed_forms_form_id_key").on(table.formId),
		uniqueIndex("transformed_forms_session_id_key").on(table.sessionId),
		// Partial index over the handoff queue: undelivered rows only.
		index("transformed_forms_undelivered_idx")
			.on(table.createdAt)
			.where(sql`${table.deliveredToBotAt} is null`),
	],
);

/**
 * Transactional outbox for the "guaranteed email".
 *
 * The row is inserted in the SAME transaction as transformed_forms, so the
 * email is queued if and only if the transform committed - no lost emails, and
 * no emails about forms that were never actually transformed. A separate relay
 * then delivers it with retries.
 *
 * UNIQUE(form_id) makes enqueueing idempotent: replaying a form cannot produce
 * a second notification.
 */
export const emailOutbox = pgTable(
	"email_outbox",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		formId: uuid("form_id")
			.notNull()
			.references(() => forms.id, { onDelete: "cascade" }),

		toAddress: text("to_address").notNull(),
		fromAddress: text("from_address").notNull(),
		subject: text("subject").notNull(),
		body: text("body").notNull(),

		status: outboxStatus("status").notNull().default("PENDING"),
		attempts: integer("attempts").notNull().default(0),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
		lastError: text("last_error"),
		sentAt: timestamp("sent_at", { withTimezone: true }),

		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		uniqueIndex("email_outbox_form_id_key").on(table.formId),
		index("email_outbox_due_idx")
			.on(table.nextAttemptAt)
			.where(sql`${table.status} = 'PENDING'`),
	],
);

/**
 * Append-only audit trail. Powers GET /forms/:id (the debugging timeline) and
 * GET /stats (failure counts by type), and preserves non-fatal observations
 * like a lossy name split that would otherwise vanish silently.
 */
export const formEvents = pgTable(
	"form_events",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		formId: uuid("form_id")
			.notNull()
			.references(() => forms.id, { onDelete: "cascade" }),
		eventType: formEventType("event_type").notNull(),
		errorCode: text("error_code"),
		detail: jsonb("detail"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(table) => [
		index("form_events_form_id_idx").on(table.formId, table.createdAt),
		index("form_events_type_idx").on(table.eventType, table.createdAt),
	],
);

export type FormRow = typeof forms.$inferSelect;
export type NewFormRow = typeof forms.$inferInsert;
export type TransformedFormRow = typeof transformedForms.$inferSelect;
export type EmailOutboxRow = typeof emailOutbox.$inferSelect;
export type FormEventRow = typeof formEvents.$inferSelect;
export type FormStatus = (typeof formStatus.enumValues)[number];
export type FormEventType = (typeof formEventType.enumValues)[number];
