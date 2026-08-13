import pino from "pino";
import { config, isTestEnv } from "./config";

/**
 * Structured JSON logging. Every pipeline state transition is logged with the
 * form id and, on failure, the specific field/reason that failed - so a
 * production incident can be diagnosed from logs alone, without needing the
 * form_events table.
 */
export const logger = pino({
	level: isTestEnv ? "silent" : config.logLevel,
	base: { service: "form-ingestion" },
	redact: {
		// Registration forms are healthcare PII. Log the shape of a failure,
		// never the patient's identity.
		paths: [
			"payload.name",
			"payload.email",
			"payload.date_of_birth",
			"payload.phone_number",
			"payload.mobile_number",
			"payload.address",
			"email",
			"name",
		],
		censor: "[redacted]",
	},
	transport:
		!isTestEnv && process.env.NODE_ENV !== "production"
			? { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } }
			: undefined,
});
