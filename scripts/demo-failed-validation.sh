#!/usr/bin/env bash
#
# Ingests the deliberately-broken example payloads and shows where each one
# lands - which failures are permanent, and which are tolerated with a warning:
#
#   test_person_missing_mobile        FAILED_VALIDATION  SCHEMA_VALIDATION_FAILED  required field absent
#   test_person_schema_rename_fields  FAILED_VALIDATION  SCHEMA_VALIDATION_FAILED  provider renamed fields
#   test_person_bad_dob               FAILED_VALIDATION  INVALID_DATE_OF_BIRTH     2023-02-30 rolls over
#   test_person_single_name           READY              MONONYM (warning)         one-word name is kept
#
# Usage:
#   scripts/demo-failed-validation.sh              # fresh session ids - always creates new forms
#   scripts/demo-failed-validation.sh --as-is      # payloads verbatim - 2nd run shows the dedupe path
#   scripts/demo-failed-validation.sh --retry      # replay failed forms, showing they fail identically
#   BASE_URL=http://localhost:3000 scripts/demo-failed-validation.sh
#
# Requires the app running (npm run db:up && npm run dev) plus curl and jq.

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
EXAMPLES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/src/forms/examples"

# Fresh session ids by default. The fixtures carry fixed session_ids, which is
# correct for the files themselves but would make a second run dedupe into the
# first run's forms - the demo would print "duplicate" and prove nothing.
FRESH=1
RETRY=0
for arg in "$@"; do
	case "$arg" in
		--as-is) FRESH=0 ;;
		--retry) RETRY=1 ;;
		-h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
		*) echo "unknown option: $arg" >&2; exit 2 ;;
	esac
done

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim() { printf '\033[2m%s\033[0m\n' "$1"; }

for tool in curl jq; do
	command -v "$tool" >/dev/null 2>&1 || { echo "$tool is required but not installed" >&2; exit 1; }
done

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

health="$(curl -fsS --max-time 5 "$BASE_URL/health" 2>/dev/null || true)"
if [ -z "$health" ]; then
	echo "Cannot reach $BASE_URL/health." >&2
	echo "Start the stack first:  npm run db:up && npm run dev" >&2
	exit 1
fi
if [ "$(jq -r '.database' <<<"$health")" != "reachable" ]; then
	echo "App is up but the database is not reachable: $health" >&2
	exit 1
fi

RUN_ID="$(date +%s)"
bold "Ingesting broken payloads -> $BASE_URL"
[ "$FRESH" -eq 1 ] && dim "session ids suffixed with -$RUN_ID so this run creates new forms (--as-is to send verbatim)"
echo

# ---------------------------------------------------------------------------
# Ingest
# ---------------------------------------------------------------------------

form_ids=()
labels=()

for file in "$EXAMPLES_DIR"/test_person_*.json; do
	label="$(basename "$file" .json)"

	if [ "$FRESH" -eq 1 ]; then
		# Suffix rather than replace, so the original ids stay recognisable in
		# the database while each run stays independently ingestable.
		body="$(jq --arg suffix "-$RUN_ID" \
			'.session_id = ((.session_id // "unkeyed") + $suffix)
			 | .application_reference = ((.application_reference // "GRU-UNKNOWN") + $suffix)' "$file")"
	else
		body="$(cat "$file")"
	fi

	response="$(curl -sS -X POST "$BASE_URL/ingest" \
		-H 'Content-Type: application/json' \
		-w '\n%{http_code}' \
		-d "$body")"
	code="$(tail -n1 <<<"$response")"
	payload="$(sed '$d' <<<"$response")"

	form_id="$(jq -r '.formId // empty' <<<"$payload")"
	note="$(jq -r 'if .duplicate then "duplicate - not re-queued" elif .error then .error else "queued" end' <<<"$payload")"

	printf '  %-34s HTTP %s  %s\n' "$label" "$code" "$note"

	if [ -n "$form_id" ]; then
		form_ids+=("$form_id")
		labels+=("$label")
	fi
done

if [ "${#form_ids[@]}" -eq 0 ]; then
	echo "No forms to inspect." >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# Wait for the worker
# ---------------------------------------------------------------------------

echo
bold "Waiting for the worker to park them"

# The worker polls on an interval, so a form is briefly PENDING/PROCESSING.
# Poll for a terminal state rather than sleeping a guessed number of seconds.
deadline=$(( $(date +%s) + 30 ))
while :; do
	pending=0
	for form_id in "${form_ids[@]}"; do
		status="$(curl -fsS "$BASE_URL/forms/$form_id" | jq -r '.form.status')"
		case "$status" in PENDING|PROCESSING) pending=$((pending + 1)) ;; esac
	done
	[ "$pending" -eq 0 ] && break
	if [ "$(date +%s)" -ge "$deadline" ]; then
		echo "  timed out with $pending form(s) still in flight - is the worker running (npm run dev)?" >&2
		break
	fi
	sleep 1
done

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

echo
bold "Outcome"

for i in "${!form_ids[@]}"; do
	detail="$(curl -fsS "$BASE_URL/forms/${form_ids[$i]}")"

	jq -r --arg label "${labels[$i]}" '
		"  " + $label,
		"    formId      " + .form.id,
		"    status      " + .form.status,
		"    errorCode   " + (.form.lastErrorCode // "-"),
		"    message     " + ((.form.lastErrorDetail.message // "-") | .[0:160]),
		"    events      " + ([.events[] | .eventType + (if .errorCode then "(" + .errorCode + ")" else "" end)] | join(" -> "))
	' <<<"$detail"
	echo
done

# ---------------------------------------------------------------------------
# Optional: prove the replay path is a no-op until the code is fixed
# ---------------------------------------------------------------------------

if [ "$RETRY" -eq 1 ]; then
	bold "Replaying every FAILED_VALIDATION form (no code fix shipped, so they should fail identically)"
	curl -sS -X POST "$BASE_URL/retry" \
		-H 'Content-Type: application/json' \
		-d '{"status":"FAILED_VALIDATION","processNow":true}' | jq '{retried, outcomes, message}'
	echo
fi

bold "Failure counts across the database"
curl -fsS "$BASE_URL/stats" | jq '{forms, formFailuresByErrorCode}'

echo
dim "Inspect one:  curl $BASE_URL/forms/${form_ids[0]} | jq"
dim "Replay all:   curl -X POST $BASE_URL/retry -H 'Content-Type: application/json' -d '{\"status\":\"FAILED_VALIDATION\",\"processNow\":true}'"
