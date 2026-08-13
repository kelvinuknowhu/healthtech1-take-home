import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config";
import * as schema from "./schema";

export const pool = new Pool({
	connectionString: config.databaseUrl,
	max: 10,
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;

/** Transaction handle - the type passed to db.transaction(tx => ...) callbacks. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Either the pool or an open transaction; lets repository functions compose. */
export type Executor = Database | Transaction;

export const closeDb = async (): Promise<void> => {
	await pool.end();
};
