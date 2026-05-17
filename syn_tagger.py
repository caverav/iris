#!/usr/bin/env python3
"""Extract per-flow TCP SYN attributes and write them to flow.syn_meta jsonb.

Usage:
  python3 syn_tagger.py '<glob>'                # dry-run, print distribution
  python3 syn_tagger.py '<glob>' --apply        # write to DB
  python3 syn_tagger.py '<glob>' --apply --strip-tags  # also drop legacy syn:* tags
"""
import bisect, glob, os, sys
from collections import Counter, defaultdict

try:
    from scapy.utils import PcapReader
    from scapy.layers.inet import IP, TCP
except ImportError:
    print("scapy required: pip install scapy", file=sys.stderr); sys.exit(2)

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Json

DSN = os.environ["TIMESCALE"].replace("postgres://", "postgresql://")
PCAP_GLOB = sys.argv[1] if len(sys.argv) > 1 else "/traffic/log.pcap.*"
MATCH_WINDOW = 30.0
WINDOW_INTERVAL = os.environ.get("SYN_WINDOW", "7 days")

TCP_OPT_NAMES = {"MSS":"M","SAckOK":"S","Timestamp":"T","NOP":"N","WScale":"W","EOL":"E","Sack":"K"}


def parse_syn(pkt):
    if not (pkt.haslayer(TCP) and pkt.haslayer(IP)): return None
    tcp = pkt[TCP]
    if not (tcp.flags & 0x02) or (tcp.flags & 0x10):
        return None
    ip = pkt[IP]
    mss = wscale = None
    sack = False
    opts = ""
    for o in tcp.options or []:
        name = o[0] if isinstance(o, tuple) else o
        opts += TCP_OPT_NAMES.get(name, "?")
        if name == "MSS": mss = o[1]
        elif name == "WScale": wscale = o[1]
        elif name == "SAckOK": sack = True
    return {
        "src": str(ip.src), "sport": int(tcp.sport),
        "dst": str(ip.dst), "dport": int(tcp.dport),
        "ttl": int(ip.ttl), "df": bool(ip.flags & 0x2),
        "win": int(tcp.window), "mss": mss, "wscale": wscale,
        "sack": sack, "opts": opts,
    }


def main():
    apply = "--apply" in sys.argv
    strip_tags = "--strip-tags" in sys.argv

    files = sorted(glob.glob(PCAP_GLOB))
    if not files:
        print(f"no pcaps at {PCAP_GLOB}"); sys.exit(1)
    print(f"scanning {len(files)} pcap files...")

    syns = defaultdict(list)
    total = 0
    for f in files:
        try:
            for pkt in PcapReader(f):
                a = parse_syn(pkt)
                if not a: continue
                key = (a["src"], a["sport"], a["dst"], a["dport"])
                syns[key].append((float(pkt.time), a))
                total += 1
        except Exception as e:
            print(f"WARN {f}: {e}", file=sys.stderr)
    for k in syns: syns[k].sort()
    print(f"indexed {total} SYN packets across {len(syns)} 4-tuples")

    conn = psycopg.connect(DSN)
    with conn.cursor(row_factory=dict_row) as cur:
        cur.execute(f"""
            SELECT id, time, host(ip_src) AS src, port_src AS sport,
                   host(ip_dst) AS dst, port_dst AS dport
            FROM flow
            WHERE time > now() - interval '{WINDOW_INTERVAL}'
        """)
        flows = cur.fetchall()
    print(f"matching {len(flows)} flows...")

    flow_meta = {}
    ttl_counts = Counter()
    opt_counts = Counter()
    for fl in flows:
        bucket = syns.get((fl["src"], fl["sport"], fl["dst"], fl["dport"]))
        if not bucket: continue
        ts = fl["time"].timestamp()
        idx = bisect.bisect_left(bucket, (ts,))
        cands = []
        for j in (idx-1, idx):
            if 0 <= j < len(bucket):
                bts, attrs = bucket[j]
                if abs(bts - ts) <= MATCH_WINDOW:
                    cands.append((abs(bts - ts), attrs))
        if not cands: continue
        cands.sort()
        attrs = cands[0][1]
        slim = {k: attrs[k] for k in ("ttl","df","win","mss","wscale","sack","opts")}
        flow_meta[fl["id"]] = slim
        ttl_counts[attrs["ttl"]] += 1
        opt_counts[attrs["opts"]] += 1

    print(f"matched {len(flow_meta)} flows")
    print("\n== TTL distribution ==")
    for ttl, n in sorted(ttl_counts.items()):
        print(f"   ttl={ttl}: {n}")
    print("\n== TCP opts-order distribution ==")
    for o, n in opt_counts.most_common():
        print(f"   {o}: {n}")

    if not apply:
        print("\n(dry-run; use --apply to write)")
        return

    print("\napplying syn_meta column...")
    n = 0
    with conn.cursor() as cur:
        for fid, meta in flow_meta.items():
            cur.execute("UPDATE flow SET syn_meta = %s WHERE id = %s", (Json(meta), fid))
            n += 1
            if n % 5000 == 0:
                conn.commit()
                print(f"  wrote {n}")
    conn.commit()
    print(f"done. wrote syn_meta on {n} flows.")

    if strip_tags:
        print("\nstripping legacy syn:* tags...")
        with conn.cursor() as cur:
            cur.execute("""
              UPDATE flow
              SET tags = COALESCE(
                (SELECT jsonb_agg(t) FROM jsonb_array_elements_text(tags) AS t WHERE t NOT LIKE 'syn:%%'),
                '[]'::jsonb)
              WHERE tags::text LIKE '%%syn:%%'
            """)
            cur.execute("DELETE FROM tag WHERE name LIKE 'syn:%%'")
            conn.commit()
            print("  done.")

main()
