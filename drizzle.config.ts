import type { Config } from "drizzle-kit";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

export default {
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dialect: "postgresql",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "postgres://takehome:takehome@localhost:5433/takehome",
	},
	strict: true,
	verbose: true,
} satisfies Config;
