/**
 * The failure taxonomy that drives every retry decision in the pipeline.
 *
 * Getting this split right is the whole game. A provider 500 is worth retrying
 * in a second - it will probably succeed. A schema mismatch will fail
 * identically forever until someone ships a code change, so retrying it
 * automatically just burns the attempt budget and buries the real signal.
 */

export type ErrorCode =
	| "SCHEMA_VALIDATION_FAILED"
	| "NAME_UNSPLITTABLE"
	| "INVALID_DATE_OF_BIRTH"
	| "GEOCODE_UNAVAILABLE"
	| "GEOCODE_REJECTED"
	| "EMAIL_SEND_FAILED"
	| "UNEXPECTED_ERROR";

export abstract class PipelineError extends Error {
	abstract readonly retryable: boolean;

	constructor(
		readonly code: ErrorCode,
		message: string,
		readonly detail?: unknown,
	) {
		super(message);
		this.name = new.target.name;
		Error.captureStackTrace?.(this, new.target);
	}
}

/**
 * Will fail identically on every retry until a human ships a code change.
 * Parks the form in FAILED_VALIDATION, where it waits for /retry.
 */
export class PermanentError extends PipelineError {
	readonly retryable = false;
}

/**
 * A transient fault - provider outage, network blip, rate limit. Retried
 * automatically with exponential backoff, and only dead-lettered once the
 * attempt budget is exhausted.
 */
export class TransientError extends PipelineError {
	readonly retryable = true;
}

/**
 * Maps an HTTP status from one of the provider mocks onto the taxonomy.
 *
 * 5xx and 429 are transient (the request was fine, the server was not).
 * Other 4xx are permanent - the request itself is wrong, so resending it
 * unchanged is pointless.
 */
export const classifyHttpFailure = (
	statusCode: number,
	transientCode: ErrorCode,
	permanentCode: ErrorCode,
	context: Record<string, unknown> = {},
): PipelineError => {
	const detail = { statusCode, ...context };

	if (statusCode >= 500 || statusCode === 429) {
		return new TransientError(transientCode, `Provider returned ${statusCode}`, detail);
	}
	return new PermanentError(permanentCode, `Provider rejected the request with ${statusCode}`, detail);
};

export const isPipelineError = (error: unknown): error is PipelineError => error instanceof PipelineError;

/** Anything unrecognised is treated as transient: a bug that throws once may not throw twice, and dead-lettering after MAX_ATTEMPTS still bounds the damage. */
export const toPipelineError = (error: unknown): PipelineError => {
	if (isPipelineError(error)) return error;
	const message = error instanceof Error ? error.message : String(error);
	return new TransientError("UNEXPECTED_ERROR", message, {
		stack: error instanceof Error ? error.stack : undefined,
	});
};
