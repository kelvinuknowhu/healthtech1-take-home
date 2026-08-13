CREATE TYPE "public"."form_event_type" AS ENUM('RECEIVED', 'DUPLICATE_IGNORED', 'PAYLOAD_CONFLICT', 'UNKNOWN_FIELDS', 'VALIDATION_FAILED', 'GEOCODE_FAILED', 'NAME_SPLIT_AMBIGUOUS', 'DATA_QUALITY_WARNING', 'TRANSFORMED', 'EMAIL_SENT', 'EMAIL_FAILED', 'RETRY_REQUESTED', 'DEAD_LETTERED', 'RECLAIMED_STALE', 'DELIVERED_TO_BOT');--> statement-breakpoint
CREATE TYPE "public"."form_status" AS ENUM('PENDING', 'PROCESSING', 'READY', 'FAILED_VALIDATION', 'DEAD_LETTER');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('PENDING', 'SENT', 'DEAD_LETTER');--> statement-breakpoint
CREATE TYPE "public"."transformed_gender" AS ENUM('male', 'female', 'prefer-not-to-say');--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"to_address" text NOT NULL,
	"from_address" text NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"status" "outbox_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "form_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"form_id" uuid NOT NULL,
	"event_type" "form_event_type" NOT NULL,
	"error_code" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" text NOT NULL,
	"application_reference" text,
	"raw_payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" "form_status" DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_detail" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transformed_forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"form_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"application_reference" text NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"email" text NOT NULL,
	"gender" "transformed_gender" NOT NULL,
	"date_of_birth" date NOT NULL,
	"phone_number" text,
	"mobile_number" text NOT NULL,
	"address_line_1" text NOT NULL,
	"address_line_2" text NOT NULL,
	"address_line_3" text,
	"postcode" text NOT NULL,
	"country" text NOT NULL,
	"longitude" double precision NOT NULL,
	"latitude" double precision NOT NULL,
	"delivered_to_bot_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_events" ADD CONSTRAINT "form_events_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transformed_forms" ADD CONSTRAINT "transformed_forms_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_form_id_key" ON "email_outbox" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX "email_outbox_due_idx" ON "email_outbox" USING btree ("next_attempt_at") WHERE "email_outbox"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "form_events_form_id_idx" ON "form_events" USING btree ("form_id","created_at");--> statement-breakpoint
CREATE INDEX "form_events_type_idx" ON "form_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "forms_session_id_key" ON "forms" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "forms_due_idx" ON "forms" USING btree ("next_attempt_at") WHERE "forms"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "forms_status_idx" ON "forms" USING btree ("status");--> statement-breakpoint
CREATE INDEX "forms_claimed_idx" ON "forms" USING btree ("claimed_at") WHERE "forms"."status" = 'PROCESSING';--> statement-breakpoint
CREATE UNIQUE INDEX "transformed_forms_form_id_key" ON "transformed_forms" USING btree ("form_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transformed_forms_session_id_key" ON "transformed_forms" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "transformed_forms_undelivered_idx" ON "transformed_forms" USING btree ("created_at") WHERE "transformed_forms"."delivered_to_bot_at" is null;