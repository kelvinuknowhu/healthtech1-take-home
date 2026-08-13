import dotenv from "dotenv";

dotenv.config({ quiet: true });

const int = (name: string, fallback: number): number => {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isNaN(parsed)) {
		throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
	}
	return parsed;
};

const bool = (name: string, fallback: boolean): boolean => {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	return raw === "true" || raw === "1";
};

export const config = {
	databaseUrl: process.env.DATABASE_URL ?? "postgres://takehome:takehome@localhost:5433/takehome",
	port: int("PORT", 3000),
	logLevel: process.env.LOG_LEVEL ?? "info",

	worker: {
		intervalMs: int("WORKER_INTERVAL_MS", 1_000),
		batchSize: int("WORKER_BATCH_SIZE", 10),
		maxAttempts: int("MAX_ATTEMPTS", 5),
		backoffBaseMs: int("BACKOFF_BASE_MS", 1_000),
		backoffMaxMs: int("BACKOFF_MAX_MS", 300_000),
		processingLeaseMs: int("PROCESSING_LEASE_MS", 60_000),
	},

	sweeper: {
		intervalMs: int("SWEEP_INTERVAL_MS", 86_400_000),
		includeValidationFailures: bool("SWEEP_INCLUDES_VALIDATION_FAILURES", true),
	},

	email: {
		to: process.env.EMAIL_TO ?? "happyforms@bots.com",
		from: process.env.EMAIL_FROM ?? "noreply@healthtech1.example.com",
	},
} as const;

export const isTestEnv = process.env.NODE_ENV === "test";
