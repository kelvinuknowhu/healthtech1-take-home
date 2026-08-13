import { Router, type Request, type Response } from "express";
import { asyncHandler } from "./asyncHandler";
import { ingestForm } from "../forms/service";

export const ingestRouter = Router();

/**
 * POST /ingest
 *
 * Accepts, persists and acknowledges - nothing more. The transform, geocode and
 * email all happen in the background, so a provider outage on our side never
 * turns into a failed delivery on theirs (which, with a third party this
 * unreliable, would mean an unbounded retry storm or a silently dropped form).
 *
 *   202  accepted, queued for processing
 *   200  already seen this exact form - no-op
 *   409  session_id reused with a different body; original kept
 *   400  body wasn't a JSON object at all
 */
ingestRouter.post("/ingest", asyncHandler(async (req: Request, res: Response) => {
	const body: unknown = req.body;

	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		res.status(400).json({
			error: "Request body must be a JSON object",
			received: Array.isArray(body) ? "array" : typeof body,
		});
		return;
	}

	const { outcome, form } = await ingestForm(body);

	const payload = {
		formId: form.id,
		sessionId: form.sessionId,
		status: form.status,
	};

	if (outcome === "created") {
		res.status(202).json({ ...payload, message: "Form accepted and queued for processing" });
		return;
	}

	if (outcome === "duplicate") {
		res.status(200).json({ ...payload, duplicate: true, message: "Form already ingested - ignoring duplicate" });
		return;
	}

	res.status(409).json({
		...payload,
		error: "A different payload has already been ingested under this session_id",
		message: "The originally ingested form has been kept. This conflict has been recorded for review.",
	});
}));
