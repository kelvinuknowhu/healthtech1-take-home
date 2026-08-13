#!/usr/bin/env python3
"""Reconstruct a single form's history from the audit trail.

    ./scripts/timeline.py <form-id | id-prefix | session-id>

Accepts a short id prefix so you can paste straight from a triage listing.
Stdlib only - no dependencies, nothing to install before a demo.
"""
import json
import sys
import urllib.request
from datetime import datetime

BASE = "http://localhost:3000"

# Event types that represent something going wrong, for colour-free emphasis.
BAD = {
    "VALIDATION_FAILED",
    "GEOCODE_FAILED",
    "PROCESSING_FAILED",
    "EMAIL_FAILED",
    "DEAD_LETTERED",
    "PAYLOAD_CONFLICT",
}
NOTEWORTHY = {"UNKNOWN_FIELDS", "DATA_QUALITY_WARNING", "RECLAIMED_STALE"}


def get(path):
    with urllib.request.urlopen(BASE + path) as response:
        return json.load(response)


def resolve(needle):
    """Find a form by full id, id prefix, or session id."""
    listing = get("/forms?limit=200")["forms"]
    for form in listing:
        if form["id"] == needle or form["sessionId"] == needle:
            return form["id"]
    matches = [f for f in listing if f["id"].startswith(needle)]
    if len(matches) == 1:
        return matches[0]["id"]
    if len(matches) > 1:
        sys.exit(f"'{needle}' is ambiguous: matches {len(matches)} forms")
    sys.exit(f"No form found for '{needle}'")


def parse(ts):
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def offset(start, ts):
    seconds = (parse(ts) - start).total_seconds()
    if seconds < 1:
        return f"+{int(seconds * 1000)}ms"
    if seconds < 90:
        return f"+{seconds:.1f}s"
    return f"+{seconds / 60:.1f}m"


MAX_LINE = 108


def clip(text):
    """Truncate with an ellipsis, so a cut is never mistaken for the real value."""
    text = str(text)
    return text if len(text) <= MAX_LINE else text[: MAX_LINE - 1] + "…"


def summarise(event):
    """Lines describing what an event's detail actually says.

    Returns a list: a validation failure naming four fields gets four lines,
    rather than one truncated line that hides three of them.
    """
    detail = event.get("detail") or {}
    if not isinstance(detail, dict):
        return []

    if "issues" in detail:
        return [clip(f"{i['field']}: {i['message']}") for i in detail["issues"]]
    if "unknownFields" in detail:
        return [clip("unexpected fields: " + ", ".join(detail["unknownFields"]))]
    if "rawName" in detail:
        last = detail.get("lastName")
        rendered = f"{detail.get('firstName')} / {last}" if last else f"{detail.get('firstName')} / (no surname)"
        return [clip(f"{detail['rawName']!r} -> {rendered}")]
    if "field" in detail and "value" in detail:
        return [clip(f"{detail['field']} = {detail['value']!r}")]
    if "message" in detail:
        return [clip(detail["message"])]
    return []


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)

    form_id = resolve(sys.argv[1])
    data = get(f"/forms/{form_id}")
    form, events = data["form"], data["events"]

    print()
    print(f"  Form     {form['id']}")
    print(f"  Session  {form['sessionId']}")
    print(f"  Ref      {form['applicationReference'] or '-'}")
    print(f"  Status   {form['status']}   attempts: {form['attempts']}")
    if form["lastErrorCode"]:
        print(f"  Error    {form['lastErrorCode']}")
    print()

    if not events:
        print("  (no events recorded)")
        return

    start = parse(events[0]["createdAt"])
    print("  TIMELINE")
    for event in events:
        mark = "!" if event["eventType"] in BAD else ("*" if event["eventType"] in NOTEWORTHY else " ")
        stamp = offset(start, event["createdAt"])
        code = f"  [{event['errorCode']}]" if event.get("errorCode") else ""
        print(f"  {mark} {stamp:>8}  {event['eventType']}{code}")
        notes = summarise(event)
        for i, note in enumerate(notes):
            branch = "└" if i == len(notes) - 1 else "├"
            print(f"               {branch} {note}")

    print()
    print(f"  Transformed  {'yes' if data['transformed'] else 'no'}")
    email = data["email"]
    print(f"  Email        {email['status'] + ' (attempts: ' + str(email['attempts']) + ')' if email else 'none'}")
    if data["transformed"] and data["transformed"].get("deliveredToBotAt"):
        print(f"  To FORM-BOT  {data['transformed']['deliveredToBotAt']}")
    elif data["transformed"]:
        print("  To FORM-BOT  not yet claimed")
    print()


if __name__ == "__main__":
    main()
