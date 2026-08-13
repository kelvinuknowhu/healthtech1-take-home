/**
 * Date-of-birth parsing, shared by validation and transform so the two can
 * never disagree about what counts as a valid date.
 *
 * Deliberately strict about format: `new Date("not-a-date")` yields Invalid
 * Date, and `new Date("2026-02-30")` silently rolls over to March 2nd. Neither
 * is acceptable for a patient record.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Earliest plausible DOB. Guards against sentinel junk like "0001-01-01". */
const EARLIEST_YEAR = 1900;

export type DateParseResult = { ok: true; value: Date } | { ok: false; reason: string };

export const parseDateOfBirth = (raw: string, now: Date = new Date()): DateParseResult => {
	const match = ISO_DATE.exec(raw.trim());
	if (!match) {
		return { ok: false, reason: "must be an ISO date in YYYY-MM-DD format" };
	}

	const [, yearStr, monthStr, dayStr] = match;
	const year = Number(yearStr);
	const month = Number(monthStr);
	const day = Number(dayStr);

	// Build in UTC so the stored date never shifts by a day across timezones.
	const parsed = new Date(Date.UTC(year, month - 1, day));

	// Round-trip check: catches rollovers such as 2026-02-30 -> 2026-03-02.
	const roundTripped =
		parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
	if (!roundTripped) {
		return { ok: false, reason: `is not a real calendar date (${raw})` };
	}

	if (year < EARLIEST_YEAR) {
		return { ok: false, reason: `is implausibly early (before ${EARLIEST_YEAR})` };
	}

	if (parsed.getTime() > now.getTime()) {
		return { ok: false, reason: "is in the future" };
	}

	return { ok: true, value: parsed };
};
