import app from "./app";
import { config } from "./config";
import { closeDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { logger } from "./logger";
import { startWorkers, stopWorkers } from "./workers/runner";

const start = async (): Promise<void> => {
	// Migrate on boot so `npm run dev` against a fresh database just works.
	// In a real deployment this would be a separate step in the release
	// pipeline, not something every replica races to do at startup.
	await runMigrations();
	logger.info("migrations up to date");

	const server = app.listen(config.port, () => {
		logger.info(`Server is running on http://localhost:${config.port}`);
	});

	startWorkers();

	const shutdown = async (signal: string): Promise<void> => {
		logger.info({ signal }, "shutting down");
		stopWorkers();
		server.close();
		await closeDb();
		process.exit(0);
	};

	process.on("SIGTERM", () => void shutdown("SIGTERM"));
	process.on("SIGINT", () => void shutdown("SIGINT"));
};

start().catch((error) => {
	logger.error({ err: error }, "failed to start");
	process.exit(1);
});
