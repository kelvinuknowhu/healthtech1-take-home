import { createHash } from "node:crypto";

/**
 * Recursively sorts object keys so that two payloads differing only in key
 * order hash identically. Without this, the same form re-sent with reordered
 * JSON keys would look like a conflicting payload.
 */
const canonicalise = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(canonicalise);
	if (value !== null && typeof value === "object") {
		return Object.keys(value as Record<string, unknown>)
			.sort()
			.reduce<Record<string, unknown>>((acc, key) => {
				acc[key] = canonicalise((value as Record<string, unknown>)[key]);
				return acc;
			}, {});
	}
	return value;
};

/**
 * Content fingerprint for a raw payload.
 *
 * Used to tell a true duplicate (same session_id, same body - ignore it) from a
 * genuine conflict (same session_id, *different* body - a badly behaved
 * provider recycling an id, which a human should look at).
 */
export const hashPayload = (payload: unknown): string =>
	createHash("sha256").update(JSON.stringify(canonicalise(payload))).digest("hex");
