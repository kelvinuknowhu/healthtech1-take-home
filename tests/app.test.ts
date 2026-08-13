/**
 * App-level middleware: the 404 catch-all and the error handler in src/app.ts.
 *
 * Every other suite exercises a route that works. This one covers what happens
 * when a request matches nothing, or when a handler blows up - the paths a
 * provider hits when it calls the wrong URL, or when we ship a bug. Both must
 * answer in JSON: this API only ever speaks JSON, and Express's default error
 * page is HTML with a stack trace in it.
 *
 * The two failure routes are injected by mocking a router rather than added to
 * the real app, because src/app.ts registers the 404 catch-all after the
 * routers - anything appended later would be swallowed by it and never run.
 */
import request from "supertest";
import app from "../src/app";
import * as repo from "../src/forms/repository";
import { teardownDatabase } from "./helpers/db";

jest.mock("../src/routes/forms", () => {
	const { Router } = require("express") as typeof import("express");
	const formsRouter = Router();

	/** A synchronous throw - the only kind Express 4 catches unaided. */
	formsRouter.get("/boom-sync", () => {
		throw new Error("synchronous handler failure");
	});

	return { formsRouter };
});

jest.mock("../src/forms/repository");

const mockGetStats = repo.getStats as jest.MockedFunction<typeof repo.getStats>;

afterAll(teardownDatabase);

describe("the 404 catch-all", () => {
	it("answers an unknown path in JSON, naming the path", async () => {
		const response = await request(app).get("/does-not-exist");

		expect(response.status).toBe(404);
		expect(response.type).toBe("application/json");
		expect(response.body).toEqual({ error: "Not found", path: "/does-not-exist" });
	});

	it("404s a known path called with the wrong method", async () => {
		const response = await request(app).get("/ingest");

		expect(response.status).toBe(404);
		expect(response.body).toEqual({ error: "Not found", path: "/ingest" });
	});
});

describe("the error handler", () => {
	it("turns a synchronous throw into a JSON 500", async () => {
		const response = await request(app).get("/boom-sync");

		expect(response.status).toBe(500);
		expect(response.type).toBe("application/json");
		expect(response.body).toEqual({
			error: "Internal server error",
			message: "synchronous handler failure",
		});
	});

	/**
	 * The case asyncHandler exists for. Without it Express 4 would leave this
	 * request hanging until the client gave up, so a 500 here is the assertion
	 * that the wrapper is actually forwarding rejections.
	 */
	it("catches a rejected promise from an async route", async () => {
		mockGetStats.mockRejectedValue(new Error("stats query blew up"));

		const response = await request(app).get("/stats");

		expect(response.status).toBe(500);
		expect(response.body).toEqual({
			error: "Internal server error",
			message: "stats query blew up",
		});
	});

	it("does not leak a stack trace to the caller", async () => {
		const response = await request(app).get("/boom-sync");

		expect(response.body).not.toHaveProperty("stack");
		expect(JSON.stringify(response.body)).not.toContain("at ");
	});
});
