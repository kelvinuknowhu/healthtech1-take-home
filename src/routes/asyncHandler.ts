import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Forwards rejected promises to the Express error middleware.
 *
 * Express 4 predates async handlers: it only catches synchronous throws, so an
 * async handler that rejects leaves the request hanging until the client times
 * out, with nothing but an UnhandledPromiseRejection in the logs. Every async
 * route below is wrapped in this. (Express 5 handles it natively, but the
 * starter pins Express 4 and swapping the framework isn't the point of the
 * exercise.)
 */
export const asyncHandler =
	(handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
	(req, res, next) => {
		handler(req, res, next).catch(next);
	};
