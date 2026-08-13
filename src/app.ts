import express, { type NextFunction, type Request, type Response } from "express";
import { logger } from "./logger";
import { formsRouter } from "./routes/forms";
import { ingestRouter } from "./routes/ingest";
import { retryRouter } from "./routes/retry";
import { statsRouter } from "./routes/stats";

const app = express();

app.use(express.json({ limit: "1mb" }));

/**
 * Malformed JSON never reaches a route handler - express.json throws first.
 * Without this it would surface as an opaque 500; a badly behaved provider
 * sending broken JSON deserves a clear 400.
 */
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
	if (error instanceof SyntaxError && "body" in error) {
		res.status(400).json({ error: "Request body is not valid JSON" });
		return;
	}
	next(error);
});

app.use(ingestRouter);
app.use(retryRouter);
app.use(formsRouter);
app.use(statsRouter);

app.use((req: Request, res: Response) => {
	res.status(404).json({ error: "Not found", path: req.path });
});

/**
 * Catch-all. Express 4 does not forward rejected promises from async handlers,
 * so this only fires for synchronous throws and explicit next(err) calls -
 * see the asyncHandler note in index.ts.
 */
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
	logger.error({ err: error }, "unhandled error in request pipeline");
	res.status(500).json({
		error: "Internal server error",
		message: error instanceof Error ? error.message : String(error),
	});
});

export default app;
