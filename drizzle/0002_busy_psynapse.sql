ALTER TABLE "form_events" ALTER COLUMN "event_type" SET DATA TYPE text;--> statement-breakpoint
-- Hand-written: NAME_SPLIT_AMBIGUOUS folded into DATA_QUALITY_WARNING. Existing
-- rows must be rewritten while the column is still text - the cast back to the
-- new enum on the last statement rejects any value the new enum lacks. No history
-- is lost: which observation it was already lives in "error_code"
-- (MIDDLE_NAME_MERGED), which this migration leaves untouched.
UPDATE "form_events" SET "event_type" = 'DATA_QUALITY_WARNING' WHERE "event_type" = 'NAME_SPLIT_AMBIGUOUS';--> statement-breakpoint
DROP TYPE "public"."form_event_type";--> statement-breakpoint
CREATE TYPE "public"."form_event_type" AS ENUM('RECEIVED', 'DUPLICATE_IGNORED', 'PAYLOAD_CONFLICT', 'UNKNOWN_FIELDS', 'VALIDATION_FAILED', 'GEOCODE_FAILED', 'PROCESSING_FAILED', 'DATA_QUALITY_WARNING', 'TRANSFORMED', 'EMAIL_SENT', 'EMAIL_FAILED', 'RETRY_REQUESTED', 'DEAD_LETTERED', 'RECLAIMED_STALE', 'DELIVERED_TO_BOT');--> statement-breakpoint
ALTER TABLE "form_events" ALTER COLUMN "event_type" SET DATA TYPE "public"."form_event_type" USING "event_type"::"public"."form_event_type";
