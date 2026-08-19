import { config } from "../config";
import { logger } from "../logger";
import { sendPendingEmails } from "./emailRelay";
import { processDueForms } from "./formProcessor";
import { sweepParkedWork } from "./sweeper";

/**
 * Wraps a tick so that a slow run can never overlap itself, and so a thrown
 * error kills the tick rather than the process.
 *
 * Without the `running` guard, a tick that takes longer than the interval would
 * start stacking up: two workers in one process racing for the same rows. The
 * database claim would keep that correct, but it would burn connections for no
 * benefit.
 */
const repeat = (name: string, intervalMs: number, tick: () => Promise<unknown>): NodeJS.Timeout => {
	let running = false;

	const timer = setInterval(async () => {
		if (running) {
			logger.debug({ worker: name }, "previous tick still running - skipping");
			return;
		}
		running = true;
		try {
			await tick();
		} catch (error) {
			logger.error({ worker: name, err: error }, "worker tick failed");
		} finally {
			running = false;
		}
	}, intervalMs);

	// Don't hold the event loop open on shutdown.
	timer.unref();
	return timer;
};

let timers: NodeJS.Timeout[] = [];

/**
 * Starts the background workers.
 *
 * Called only from index.ts, never from app.ts. Tests import the Express app
 * and drive `processDueForms` / `sendPendingEmails` by hand, so no test ever
 * depends on a timer firing - which is the difference between a suite that is
 * deterministic and one that is flaky at 3am in CI.
 */
export const startWorkers = (): void => {
	if (timers.length > 0) return;

	timers = [
		repeat("form-processor", config.worker.intervalMs, () => processDueForms()),
		repeat("email-relay", config.worker.intervalMs, () => sendPendingEmails()),
		repeat("sweeper", config.sweeper.intervalMs, () => sweepParkedWork()),
	];

	logger.info(
		{ workerIntervalMs: config.worker.intervalMs, sweepIntervalMs: config.sweeper.intervalMs },
		"background workers started",
	);
};

export const stopWorkers = (): void => {
	for (const timer of timers) clearInterval(timer);
	timers = [];
};
