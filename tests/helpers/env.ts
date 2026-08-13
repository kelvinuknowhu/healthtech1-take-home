/**
 * Runs before any module is imported (jest `setupFiles`).
 *
 * Setting DATABASE_URL here rather than in .env matters: config.ts calls
 * dotenv.config(), which does *not* overwrite variables already present in
 * process.env. So this wins, and a test run can never accidentally truncate the
 * development database.
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
	process.env.TEST_DATABASE_URL ?? "postgres://takehome:takehome@localhost:5433/takehome_test";

// Fast, deterministic retries: no test should ever wait on real backoff.
process.env.BACKOFF_BASE_MS = "1";
process.env.BACKOFF_MAX_MS = "2";
process.env.MAX_ATTEMPTS = "3";
process.env.LOG_LEVEL = "silent";
