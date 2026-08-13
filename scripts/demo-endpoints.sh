#!/usr/bin/env bash
#
# A guided curl tour of every endpoint, in the order that tells the story:
# ingest -> dedupe -> conflict -> worker -> timeline -> bot handoff -> replay.
#
# Each step prints the exact curl command before running it, so the script
# doubles as a copy-pasteable cheatsheet - nothing here is hidden behind a
# helper you would have to read the source to reproduce by hand.
#
# Usage:
#   scripts/demo-endpoints.sh                      # the full tour
#   scripts/demo-endpoints.sh 3 4 7                # only these steps
#   scripts/demo-endpoints.sh --list               # what the steps are
#   BASE_URL=http://localhost:3000 scripts/demo-endpoints.sh
#
# Requires the app running (npm run db:up && npm run dev) plus curl and jq.
# For the deliberately-broken payloads, see scripts/demo-failed-validation.sh.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
EXAMPLES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/forms/examples"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }

STEP_NAMES=(
	"1  health          liveness + a real database round-trip"
	"2  ingest          a good form -> 202, queued"
	"3  ingest          the same body again -> 200, duplicate ignored"
	"4  ingest          same session_id, different body -> 409, original kept"
	"5  ingest          malformed / non-object bodies -> 400"
	"6  forms/:id       the timeline once the worker has run"
	"7  forms           list, filtered by status"
	"8  forms/ready     the FORM-BOT handoff - claims exactly once"
	"9  stats           failure counts across the database"
	"10 retry           replay parked forms from their raw payload"
	"11 retry/sweep     trigger the nightly safety net by hand"
)

if [ "${1:-}" = "--list" ] || [ "${1:-}" = "-l" ]; then
	bold "Steps"
	printf '  %s\n' "${STEP_NAMES[@]}"
	exit 0
fi

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
	sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
	exit 0
fi

for tool in curl jq; do
	command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required but not installed" >&2; exit 1; }
done

# Steps are opt-in when arguments are given, all-on otherwise.
WANTED=("$@")
want() {
	[ "${#WANTED[@]}" -eq 0 ] && return 0
	for n in "${WANTED[@]}"; do [ "$n" = "$1" ] && return 0; done
	return 1
}

# Prints the command, then runs it. `show` keeps the printed form and the
# executed form identical - the whole point of a demo script.
show() {
	printf '\033[2m$ %s\033[0m\n' "$*"
	eval "$@"
	echo
}

step() {
	echo
	bold "── $1"
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

health="$(curl -fsS --max-time 5 "$BASE_URL/health" 2>/dev/null || true)"
if [ -z "$health" ]; then
	echo "Cannot reach $BASE_URL/health." >&2
	echo "Start the stack first:  npm run db:up && npm run dev" >&2
	exit 1
fi

# A fresh session id per run, so re-running the script creates new forms
# instead of deduping into the previous run's.
RUN_ID="$(date +%s)"
SESSION_ID="demo-$RUN_ID"
# Compact, so the echoed curl commands stay one line and remain paste-able.
PAYLOAD="$(jq -c --arg s "$SESSION_ID" --arg r "GRU-DEMO-$RUN_ID" \
	'.session_id = $s | .application_reference = $r' "$EXAMPLES_DIR/person_one.json")"

bold "Demo tour against $BASE_URL"
dim "session_id for this run: $SESSION_ID"

# ---------------------------------------------------------------------------
# 1. Health
# ---------------------------------------------------------------------------

if want 1; then
	step "1. GET /health"
	show "curl -sS $BASE_URL/health | jq"
fi

# ---------------------------------------------------------------------------
# 2-5. Ingest, and everything that can go wrong at the door
# ---------------------------------------------------------------------------

FORM_ID=""

if want 2 || want 6 || want 8; then
	step "2. POST /ingest - a good form (expect 202 Accepted)"
	dim "Returns immediately; the transform, geocode and email all happen in the background."
	printf '\033[2m$ curl -sS -X POST %s/ingest -H '\''Content-Type: application/json'\'' -d '\''%s'\''\033[0m\n' \
		"$BASE_URL" "$PAYLOAD"
	response="$(curl -sS -X POST "$BASE_URL/ingest" \
		-H 'Content-Type: application/json' \
		-w '\n%{http_code}' -d "$PAYLOAD")"
	code="$(tail -n1 <<<"$response")"
	body="$(sed '$d' <<<"$response")"
	jq <<<"$body"
	echo "HTTP $code"
	FORM_ID="$(jq -r '.formId' <<<"$body")"
	echo
fi

if want 3; then
	step "3. POST /ingest - byte-identical replay (expect 200, duplicate:true)"
	dim "The provider does not guarantee exactly-once delivery, so re-sends are routine."
	show "curl -sS -o /dev/null -w 'HTTP %{http_code}\n' -X POST $BASE_URL/ingest \
		-H 'Content-Type: application/json' -d '$PAYLOAD'"
	show "curl -sS -X POST $BASE_URL/ingest -H 'Content-Type: application/json' -d '$PAYLOAD' | jq '{duplicate, message}'"
fi

if want 4; then
	step "4. POST /ingest - same session_id, different body (expect 409)"
	dim "The original is kept and the conflict recorded; overwriting a patient record silently is worse."
	conflicting="$(jq -c '.email = "someone.else@example.com"' <<<"$PAYLOAD")"
	show "curl -sS -w '\nHTTP %{http_code}\n' -X POST $BASE_URL/ingest \
		-H 'Content-Type: application/json' -d '$conflicting'"
fi

if want 5; then
	step "5. POST /ingest - bad requests (expect 400)"
	dim "Malformed JSON is caught by the express.json error handler, not by a route."
	show "curl -sS -w '\nHTTP %{http_code}\n' -X POST $BASE_URL/ingest \
		-H 'Content-Type: application/json' -d '{\"broken\": '"
	show "curl -sS -w '\nHTTP %{http_code}\n' -X POST $BASE_URL/ingest \
		-H 'Content-Type: application/json' -d '[\"not\", \"an\", \"object\"]'"
fi

# ---------------------------------------------------------------------------
# 6. The timeline
# ---------------------------------------------------------------------------

if want 6 && [ -n "$FORM_ID" ]; then
	step "6. GET /forms/:id - state, last error and the full event timeline"

	# The worker polls on an interval and the geocode mock sleeps ~1s, so poll
	# for a settled state rather than sleeping a guessed number of seconds.
	deadline=$(( $(date +%s) + 30 ))
	while :; do
		status="$(curl -fsS "$BASE_URL/forms/$FORM_ID" | jq -r '.form.status')"
		case "$status" in PENDING|PROCESSING) ;; *) break ;; esac
		[ "$(date +%s)" -ge "$deadline" ] && { dim "timed out waiting - is the worker running (npm run dev)?"; break; }
		sleep 1
	done

	show "curl -sS $BASE_URL/forms/$FORM_ID | jq '{status: .form.status, attempts: .form.attempts, error: .form.lastErrorCode, email: .email.status, events: [.events[].eventType]}'"
	dim "Full detail (raw payload, transformed row, outbox, every event):"
	dim "  curl -sS $BASE_URL/forms/$FORM_ID | jq"

	step "6b. GET /forms/:id - the error paths"
	show "curl -sS -w '\nHTTP %{http_code}\n' $BASE_URL/forms/not-a-uuid"
	show "curl -sS -w '\nHTTP %{http_code}\n' $BASE_URL/forms/00000000-0000-4000-8000-000000000000"
fi

# ---------------------------------------------------------------------------
# 7. Listing
# ---------------------------------------------------------------------------

if want 7; then
	step "7. GET /forms - recent forms, optionally filtered"
	show "curl -sS '$BASE_URL/forms?limit=5' | jq '{count, forms: [.forms[] | {id, status, attempts, lastErrorCode}]}'"
	dim "Any status works: READY, PENDING, PROCESSING, FAILED_VALIDATION, DEAD_LETTER, DELIVERED"
	show "curl -sS '$BASE_URL/forms?status=FAILED_VALIDATION&limit=5' | jq '{count}'"
fi

# ---------------------------------------------------------------------------
# 8. The bot handoff
# ---------------------------------------------------------------------------

if want 8; then
	step "8. GET /forms/ready - the FORM-BOT handoff"
	dim "NOT a read-only endpoint: each call atomically claims what it returns, so"
	dim "a form is delivered exactly once no matter how many bots poll concurrently."
	show "curl -sS '$BASE_URL/forms/ready?limit=5' | jq '{count, forms: [.forms[] | {applicationReference, firstName, lastName, postcode, longitude, latitude}]}'"
	dim "Immediately again - the same forms are not handed out twice:"
	show "curl -sS '$BASE_URL/forms/ready?limit=5' | jq '{count}'"
fi

# ---------------------------------------------------------------------------
# 9. Stats
# ---------------------------------------------------------------------------

if want 9; then
	step "9. GET /stats - how many, and why"
	show "curl -sS $BASE_URL/stats | jq"
fi

# ---------------------------------------------------------------------------
# 10-11. Replay
# ---------------------------------------------------------------------------

if want 10; then
	step "10. POST /retry - replay parked forms from their stored raw payload"
	dim "The intended workflow: a schema change breaks a batch, someone ships the fix,"
	dim "one call replays everything that hit the bug. processNow skips the worker tick."
	show "curl -sS -X POST $BASE_URL/retry -H 'Content-Type: application/json' \
		-d '{\"status\":\"FAILED_VALIDATION\",\"processNow\":true}' | jq '{retried, outcomes, message}'"
	dim "Surgical re-run of a single form:"
	dim "  curl -sS -X POST $BASE_URL/retry -H 'Content-Type: application/json' -d '{\"formIds\":[\"<uuid>\"]}'"
	dim "Everything that exhausted its retries during an outage:"
	dim "  curl -sS -X POST $BASE_URL/retry -H 'Content-Type: application/json' -d '{\"status\":\"DEAD_LETTER\"}'"

	step "10b. POST /retry - a selector is required (expect 400)"
	show "curl -sS -w '\nHTTP %{http_code}\n' -X POST $BASE_URL/retry \
		-H 'Content-Type: application/json' -d '{}'"
fi

if want 11; then
	step "11. POST /retry/sweep - the nightly safety net, on demand"
	dim "Retries DEAD_LETTER forms and dead outbox emails without waiting 24 hours."
	show "curl -sS -X POST $BASE_URL/retry/sweep | jq"
fi

echo
bold "Done."
dim "Broken-payload tour:  scripts/demo-failed-validation.sh"
dim "Delivery timeline:    scripts/timeline.py"
