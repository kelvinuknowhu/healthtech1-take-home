import { Router, type Request, type Response } from "express";
import { asyncHandler } from "./asyncHandler";
import { sql } from "drizzle-orm";
import { db } from "../db/client";
import * as repo from "../forms/repository";

export const statsRouter = Router();

/**
 * GET /stats
 *
 * Failure counts by type, straight from the database. Deliberately simple - the
 * point is that when something breaks you can answer "how many, and why"
 * immediately, rather than grepping logs to find out whether one form broke or
 * four hundred did.
 */
statsRouter.get("/stats", asyncHandler(async (_req: Request, res: Response) => {
	res.status(200).json(await repo.getStats());
}));

/** GET /health - liveness plus a real database round-trip. */
statsRouter.get("/health", asyncHandler(async (_req: Request, res: Response) => {
	try {
		await db.execute(sql`select 1`);
		res.status(200).json({ status: "ok", database: "reachable" });
	} catch (error) {
		res.status(503).json({
			status: "degraded",
			database: "unreachable",
			error: error instanceof Error ? error.message : String(error),
		});
	}
}));
