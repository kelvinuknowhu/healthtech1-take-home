import { config } from "../config";
import { logger } from "../logger";
import * as repo from "../forms/repository";
import { processForm, type ProcessOutcome } from "../forms/service";

/**
 * One tick of the form pipeline: reclaim anything abandoned by a crashed
 * worker, claim a batch of due forms, process them.
 *
 * Returns the outcomes rather than swallowing them so tests can assert on a
 * single tick without waiting for timers.
 */
export const processDueForms = async (limit: number = config.worker.batchSize): Promise<ProcessOutcome[]> => {
	const reclaimed = await repo.reclaimStaleProcessing();
	if (reclaimed.length > 0) {
		logger.warn({ count: reclaimed.length }, "reclaimed forms stranded by a crashed worker");
	}

	const claimed = await repo.claimDueForms(limit);
	if (claimed.length === 0) return [];

	logger.debug({ count: claimed.length }, "processing claimed forms");

	// Forms are independent, so process the batch concurrently. Concurrency is
	// bounded by the batch size, which doubles as the provider rate limit.
	return Promise.all(claimed.map((form) => processForm(form)));
};
