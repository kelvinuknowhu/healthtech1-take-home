import { Router, type Request, type Response } from "express";
import { asyncHandler } from "./asyncHandler";
import { z } from "zod";
import { formStatus } from "../db/schema";
import * as repo from "../forms/repository";

export const formsRouter = Router();

const listQuerySchema = z.object({
	status: z.enum(formStatus.enumValues).optional(),
	limit: z.coerce.number().int().positive().max(200).default(50),
});

/**
 * GET /forms/ready
 *
 * The FORM-BOT handoff. Each call atomically claims the forms it returns, so a
 * form is delivered exactly once no matter how many bots poll concurrently.
 *
 * Registered before /forms/:id so "ready" isn't parsed as an id.
 */
formsRouter.get("/forms/ready", asyncHandler(async (req: Request, res: Response) => {
	const limit = Math.min(Number(req.query.limit ?? 10) || 10, 100);
	const claimed = await repo.claimFormsForBot(limit);

	res.status(200).json({
		count: claimed.length,
		forms: claimed,
	});
}));

/** GET /forms - recent forms, optionally filtered by status. */
formsRouter.get("/forms", asyncHandler(async (req: Request, res: Response) => {
	const parsed = listQuerySchema.safeParse(req.query);

	if (!parsed.success) {
		res.status(400).json({
			error: "Invalid query",
			issues: parsed.error.issues.map((issue) => ({ field: issue.path.join("."), message: issue.message })),
		});
		return;
	}

	const rows = await repo.listForms(parsed.data.status, parsed.data.limit);
	res.status(200).json({ count: rows.length, forms: rows });
}));

/**
 * GET /forms/:id
 *
 * The debugging view: current state, the error that parked it, and the full
 * event timeline including non-fatal observations such as a lossy name split.
 * This is what turns "a form failed" into "a form failed *because* of this
 * field", without shelling into the database.
 */
formsRouter.get("/forms/:id", asyncHandler(async (req: Request, res: Response) => {
	// Postgres raises a syntax error on a malformed uuid, which would surface as
	// a 500 for what is really a client mistake.
	if (!z.uuid().safeParse(req.params.id).success) {
		res.status(400).json({ error: "Form id must be a UUID", received: req.params.id });
		return;
	}

	const form = await repo.getFormById(req.params.id);

	if (!form) {
		res.status(404).json({ error: "Form not found", formId: req.params.id });
		return;
	}

	const [transformed, email, events] = await Promise.all([
		repo.getTransformedFormByFormId(form.id),
		repo.getEmailOutboxByFormId(form.id),
		repo.getFormEvents(form.id),
	]);

	res.status(200).json({
		form,
		transformed: transformed ?? null,
		email: email ?? null,
		events,
	});
}));
