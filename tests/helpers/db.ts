import { sql } from "drizzle-orm";
import { db, pool } from "../../src/db/client";
import { runMigrations } from "../../src/db/migrate";

/**
 * Wipes all pipeline state between tests.
 *
 * TRUNCATE ... CASCADE rather than DELETE so identity sequences reset and the
 * foreign keys don't dictate the order.
 */
export const resetDatabase = async (): Promise<void> => {
	await db.execute(sql`truncate table form_events, email_outbox, transformed_forms, forms restart identity cascade`);
};

export const setupDatabase = async (): Promise<void> => {
	await runMigrations();
	await resetDatabase();
};

export const teardownDatabase = async (): Promise<void> => {
	await pool.end();
};
