/**
 * Applies migrations once before the suite runs, so tests never race each other
 * to create tables.
 */
export default async function globalSetup(): Promise<void> {
	process.env.NODE_ENV = "test";
	process.env.DATABASE_URL =
		process.env.TEST_DATABASE_URL ?? "postgres://takehome:takehome@localhost:5433/takehome_test";

	const { runMigrations } = await import("../../src/db/migrate");
	const { closeDb } = await import("../../src/db/client");

	await runMigrations();
	await closeDb();
}
