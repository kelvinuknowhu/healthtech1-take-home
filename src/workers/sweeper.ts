import { config } from "../config";
import * as repo from "../forms/repository";
import { logger } from "../logger";

export type SweepResult = {
	deadLetteredForms: number;
	validationFailures: number;
	deadLetteredEmails: number;
};

/**
 * The safety net. Runs nightly and retries everything parked in a terminal
 * state.
 *
 * For DEAD_LETTER this is unambiguously right: those forms failed for transient
 * reasons, and by the next night the outage is almost certainly over, so they
 * heal with nobody paged.
 *
 * For FAILED_VALIDATION it is defence in depth rather than the primary path.
 * The intended flow is capture -> ship a fix -> POST /retry. But if someone
 * ships the fix and forgets to trigger the replay, this catches it within a day
 * instead of leaving patient forms stranded indefinitely. It is configurable
 * because retrying a known-unfixed schema failure is pure noise in the logs -
 * the trade is a daily failed attempt against never silently losing a form.
 */
export const sweepParkedWork = async (): Promise<SweepResult> => {
	const deadLetteredForms = await repo.retryForms({ status: "DEAD_LETTER" });

	const validationFailures = config.sweeper.includeValidationFailures
		? await repo.retryForms({ status: "FAILED_VALIDATION" })
		: [];

	const deadLetteredEmails = await repo.retryDeadEmails();

	const result: SweepResult = {
		deadLetteredForms: deadLetteredForms.length,
		validationFailures: validationFailures.length,
		deadLetteredEmails,
	};

	const total = result.deadLetteredForms + result.validationFailures + result.deadLetteredEmails;
	if (total > 0) {
		logger.info(result, "sweeper retried parked work");
	}

	return result;
};
