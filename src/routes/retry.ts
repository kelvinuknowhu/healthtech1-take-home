import { Router, type Request, type Response } from "express";
import { asyncHandler } from "./asyncHandler";
import { z } from "zod";
import { formStatus } from "../db/schema";
import * as repo from "../forms/repository";
import { logger } from "../logger";
import { processDueForms } from "../workers/formProcessor";
import { sweepParkedWork } from "../workers/sweeper";

export const retryRouter = Router();

const retryBodySchema = z.object({
	formIds: z.array(z.uuid()).optional(),
	sessionIds: z.array(z.string()).optional(),
	status: z.enum(formStatus.enumValues).optional(),
	limit: z.number().int().positive().max(1000).optional(),
	/** Process the retried forms immediately rather than waiting for the next worker tick. */
	processNow: z.boolean().optional(),
});

/**
 * POST /retry
 *
 * The "ship a fix, then replay" endpoint. Retries parked forms from their
 * stored raw payload, which is why the payload is persisted verbatim at ingest.
 *
 * Selecting by `status: "FAILED_VALIDATION"` is the intended workflow: a schema
 * change breaks a batch of forms, someone deploys the fix, and one call replays
 * everything that hit the bug. Selecting by id is for surgical re-runs.
 *
 * READY forms are never retried - see retryForms.
 */
retryRouter.post("/retry", asyncHandler(async (req: Request, res: Response) => {
	const parsed = retryBodySchema.safeParse(req.body ?? {});

	if (!parsed.success) {
		res.status(400).json({
			error: "Invalid retry request",
			issues: parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
		});
		return;
	}

	const { formIds, sessionIds, status, limit, processNow } = parsed.data;

	if (!formIds?.length && !sessionIds?.length && !status) {
		res.status(400).json({
			error: "Specify at least one of: formIds, sessionIds, status",
			hint: 'After deploying a schema fix, the usual call is {"status":"FAILED_VALIDATION"}',
		});
		return;
	}

	const retried = await repo.retryForms({ formIds, sessionIds, status, limit });
	logger.info({ count: retried.length, status }, "forms retried via /retry");

	const outcomes = processNow ? await processDueForms(retried.length || 1) : undefined;

	res.status(200).json({
		retried: retried.length,
		formIds: retried.map((form) => form.id),
		...(outcomes ? { outcomes } : {}),
		message: processNow
			? "Forms retried and processed"
			: "Forms retried; the background worker will process them on its next tick",
	});
}));

/**
 * POST /retry/sweep
 *
 * Manually triggers the nightly safety-net sweep. Exists so the behaviour can
 * be demonstrated without waiting 24 hours.
 */
retryRouter.post("/retry/sweep", asyncHandler(async (_req: Request, res: Response) => {
	const result = await sweepParkedWork();
	res.status(200).json(result);
}));
