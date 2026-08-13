import { config } from "./config";

/**
 * Exponential backoff with full jitter.
 *
 * The jitter matters more than it looks: without it, a provider outage that
 * fails 500 forms at once causes all 500 to retry at the same instant, and
 * again in lockstep, hammering a service that is already struggling. Randomising
 * spreads the load out.
 */
export const backoffDelayMs = (
	attempts: number,
	{ baseMs = config.worker.backoffBaseMs, maxMs = config.worker.backoffMaxMs } = {},
): number => {
	const exponential = Math.min(baseMs * 2 ** Math.max(0, attempts - 1), maxMs);
	const jitter = Math.random() * exponential * 0.25;
	return Math.round(exponential + jitter);
};

export const nextAttemptAt = (attempts: number, from: Date = new Date()): Date =>
	new Date(from.getTime() + backoffDelayMs(attempts));
