import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";
import { db, closeDb } from "./client";

const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../drizzle");

/** Applies any pending migrations. Safe to call repeatedly (drizzle tracks state). */
export const runMigrations = async (): Promise<void> => {
	await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
};

// Allow `npm run db:migrate` to invoke this file directly.
if (require.main === module) {
	runMigrations()
		.then(async () => {
			console.log("Migrations applied.");
			await closeDb();
		})
		.catch(async (error) => {
			console.error("Migration failed:", error);
			await closeDb();
			process.exit(1);
		});
}
