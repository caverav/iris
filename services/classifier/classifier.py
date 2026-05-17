#!/usr/bin/env python3
"""Iris flow classifier - cadence/fingerprint based.

Tag flows with `auto:checker` or `auto:attacker` based on how often the
flow's canonical fingerprint repeats across recent ticks. Skips flows
that already carry a `manual:*` override.
"""
import hashlib, math, os, re, time
from collections import defaultdict
from datetime import datetime, timezone, timedelta

import psycopg
from psycopg.rows import dict_row

DSN = os.environ["TIMESCALE"].replace("postgres://", "postgresql://")
TICK_LENGTH_MS = int(os.environ.get("TICK_LENGTH", 120000))
TICK_START_RAW = os.environ.get("TICK_START", "2026-05-09T00:00:00Z")
WINDOW_TICKS = int(os.environ.get("CLASSIFIER_WINDOW_TICKS", 20))
CHECKER_TH = float(os.environ.get("CLASSIFIER_CHECKER_TH", 0.3))
ATTACKER_TH = float(os.environ.get("CLASSIFIER_ATTACKER_TH", 0.1))
MIN_OBS = int(os.environ.get("CLASSIFIER_MIN_OBS", 3))
POLL_SECONDS = int(os.environ.get("CLASSIFIER_POLL", 30))
FLAG_REGEX = os.environ.get("FLAG_REGEX", "[A-Z0-9]{31}=")

TICK_LENGTH = timedelta(milliseconds=TICK_LENGTH_MS)
TICK_START = datetime.fromisoformat(TICK_START_RAW.replace("Z", "+00:00"))

FLAG_RE       = re.compile(FLAG_REGEX.encode())
TIME_RE       = re.compile(rb"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:[+-]\d{2}:?\d{2}|Z)?")
HTTP_DATE_RE  = re.compile(rb"(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),\s+\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{4}\s+\d{2}:\d{2}:\d{2}\s+GMT")
HEX_RE        = re.compile(rb"\b[0-9a-fA-F]{8,}\b")
RAND_RE       = re.compile(rb"[A-Za-z0-9]{16,}")
B64_RE        = re.compile(rb"[A-Za-z0-9+/]{20,}={0,2}")
NUM_RE        = re.compile(rb"\b\d{4,}\b")
CL_RE         = re.compile(rb"Content-Length:\s*\d+", re.IGNORECASE)
COOKIE_RE     = re.compile(rb"Cookie:[^\r\n]+", re.IGNORECASE)
SETCOOKIE_RE  = re.compile(rb"Set-Cookie:[^\r\n]+", re.IGNORECASE)
USERAGENT_RE  = re.compile(rb"User-Agent:[^\r\n]+", re.IGNORECASE)
AUTH_RE       = re.compile(rb"Authorization:[^\r\n]+", re.IGNORECASE)
WS_RE         = re.compile(rb"\s+")


def tick_of(t): return int((t - TICK_START) // TICK_LENGTH)
def size_bucket(n): return 0 if n <= 0 else int(math.log2(n + 1))


def skeletonize(p):
    s = p[:2048]
    s = HTTP_DATE_RE.sub(b"[DATE]", s)
    s = TIME_RE.sub(b"[TIME]", s)
    s = FLAG_RE.sub(b"[FLAG]", s)
    s = COOKIE_RE.sub(b"Cookie: [COOKIE]", s)
    s = SETCOOKIE_RE.sub(b"Set-Cookie: [COOKIE]", s)
    s = USERAGENT_RE.sub(b"User-Agent: [UA]", s)
    s = AUTH_RE.sub(b"Authorization: [AUTH]", s)
    s = CL_RE.sub(b"Content-Length: [N]", s)
    s = B64_RE.sub(b"[B64]", s)
    s = HEX_RE.sub(b"[HEX]", s)
    s = RAND_RE.sub(b"[RAND]", s)
    s = NUM_RE.sub(b"[N]", s)
    s = WS_RE.sub(b" ", s)
    return s.strip()


def fingerprint(port_dst, p_in, p_out):
    parts = [
        str(port_dst).encode(),
        str(size_bucket(len(p_in))).encode(),
        str(size_bucket(len(p_out))).encode(),
        skeletonize(p_in), b"||", skeletonize(p_out),
    ]
    return hashlib.sha1(b"\x00".join(parts)).hexdigest()


def has_manual_tag(tags):
    return bool(tags) and any(t.startswith("manual:") for t in tags)


SQL_REGISTER_TAG = "INSERT INTO tag (name, sort) VALUES (%s, 90) ON CONFLICT (name) DO NOTHING"
SQL_APPLY_TAG    = "UPDATE flow SET tags = jsonb_unique(tags || jsonb_build_array(%s::text)) WHERE id = %s"
SQL_REMOVE_TAG   = "UPDATE flow SET tags = tags - %s::text WHERE id = %s"


def classify_once(conn):
    now = datetime.now(tz=timezone.utc)
    current_tick = tick_of(now)
    since = TICK_START + (current_tick - WINDOW_TICKS) * TICK_LENGTH
    counts = {"flows": 0, "checker": 0, "attacker": 0, "skip_manual": 0}

    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute("""
            SELECT id, time, port_dst, tags
            FROM flow
            WHERE time >= %s
        """, (since,))
        flows = cur.fetchall()
    if not flows: return counts

    payloads_in, payloads_out = defaultdict(bytearray), defaultdict(bytearray)
    ids = [f["id"] for f in flows]
    with conn.cursor(name="cls_items") as cur:
        cur.itersize = 5000
        cur.execute(
            "SELECT flow_id, direction, data FROM flow_item WHERE flow_id = ANY(%s)",
            (ids,))
        for fid, direction, data in cur:
            (payloads_in if direction == "c" else payloads_out)[fid].extend(bytes(data))

    fp_for, fp_ticks = {}, defaultdict(set)
    for f in flows:
        if has_manual_tag(f["tags"]):
            counts["skip_manual"] += 1
            continue
        p_in = bytes(payloads_in.get(f["id"], b""))
        p_out = bytes(payloads_out.get(f["id"], b""))
        fp = fingerprint(f["port_dst"], p_in, p_out)
        fp_for[f["id"]] = (fp, f)
        fp_ticks[fp].add(tick_of(f["time"]))

    n_ticks_obs = len({t for ts in fp_ticks.values() for t in ts}) or 1

    with conn.cursor() as cur:
        cur.execute(SQL_REGISTER_TAG, ("auto:checker",))
        cur.execute(SQL_REGISTER_TAG, ("auto:attacker",))

        for fid, (fp, f) in fp_for.items():
            seen = len(fp_ticks[fp])
            score = seen / n_ticks_obs
            if seen < MIN_OBS and score > ATTACKER_TH:
                want = None
            elif score >= CHECKER_TH:
                want = "auto:checker"
            elif score <= ATTACKER_TH:
                want = "auto:attacker"
            else:
                want = None

            existing = set(f["tags"] or [])
            for stale in ("auto:checker", "auto:attacker"):
                if stale != want and stale in existing:
                    cur.execute(SQL_REMOVE_TAG, (stale, fid))
            if want and want not in existing:
                cur.execute(SQL_APPLY_TAG, (want, fid))
                counts[want.split(":", 1)[1]] += 1

            counts["flows"] += 1
    conn.commit()
    return counts


def main():
    print(f"[classifier] starting; window={WINDOW_TICKS}t  checker>={CHECKER_TH}  attacker<={ATTACKER_TH}", flush=True)
    while True:
        try:
            with psycopg.connect(DSN) as conn:
                stats = classify_once(conn)
                print(f"[classifier] {datetime.now(tz=timezone.utc).isoformat()}: {stats}", flush=True)
        except Exception as e:
            print(f"[classifier] error: {type(e).__name__}: {e}", flush=True)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
