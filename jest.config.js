/** @type {import('jest').Config} */
module.exports = {
	preset: "ts-jest",
	testEnvironment: "node",
	// Points DATABASE_URL at the test database before any module loads.
	setupFiles: ["<rootDir>/tests/helpers/env.ts"],
	globalSetup: "<rootDir>/tests/helpers/globalSetup.ts",
	// Suites share one database, so they run serially (also enforced by the
	// --runInBand flag in the npm script).
	maxWorkers: 1,
	testTimeout: 30_000,
	testMatch: ["<rootDir>/tests/**/*.test.ts"],
};
