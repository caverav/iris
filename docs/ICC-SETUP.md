# Iris setup for ICC

This guide takes you from a fresh Linux box to a fully-deployed iris
analysis station ready for an ICC-style attack/defence CTF. It assumes
the ICC architecture: one analysis box plus one or more vulnboxes per
team, reached over WireGuard, where the gamenet only allows the analysis
side to initiate connections (so iris pulls traffic instead of being
pushed to).

If you only need the day-of TL;DR, see [PLAYBOOK.md](../PLAYBOOK.md).
This doc covers the from-zero install, the extra analytics features
shipped in this fork (cadence classifier, TCP SYN fingerprint, manual
tagging), and how to run a hot standby analysis box.

> Anti-glyph note: this doc sticks to plain ASCII. No fancy unicode.

---

## 1. Architecture

```
                   gamenet (WireGuard mesh, one-way)
                              |
                              | SSH + rsync, analysis -> vulnbox
                              v
     +------------------+         +-------------------------+
     |   analysis box   |  pull   |   vulnbox-A             |
     |                  | ------> |   Suricata-IPS          |
     |   iris stack     |         |   (service containers)  |
     |   - timescale    |         +-------------------------+
     |   - api          |
     |   - frontend     |   pull  +-------------------------+
     |   - enricher     | ------> |   vulnbox-B             |
     |   - assembler    |         |   Suricata-IPS          |
     |   - flagids      |         +-------------------------+
     |   - classifier   |
     |   - janitor      |   pull  +-------------------------+
     |   - fetcher      | ------> |   vulnbox-N             |
     +------------------+         +-------------------------+
```

Each vulnbox:

- gets bootstrapped by the analysis box (one SSH-with-password call that
  drops the analysis box's ed25519 pubkey into `/root/.ssh/authorized_keys`,
  clones iris, and starts `suricata-ips` in inline NFQUEUE mode);
- runs Suricata IPS with `pcap-log` + `eve.json` rotating into a local
  `traffic/` directory;
- is read continuously from the analysis box via `rsync`-over-SSH (the
  `fetcher` container).

The analysis box:

- runs the iris stack listed above;
- accumulates pcaps and eve.json from every enrolled vulnbox in one shared
  traffic dir;
- the **assembler** reassembles TCP and writes flows to TimescaleDB;
- the **enricher** tails eve.json and tags flows with Suricata alert
  signatures;
- the **classifier** auto-tags flows with `auto:checker` / `auto:attacker`
  based on fingerprint repetition across ticks;
- offers a Flask API on :5000 and a React UI on :3000.

---

## 2. Prerequisites

On the analysis box:

- Linux, kernel >= 5.x.
- Docker engine + Docker Compose v2 (`docker compose` not `docker-compose`).
- `git`, `curl`, `ssh-keygen`, `setsid` (the last lives in coreutils on
  every distro).
- A WireGuard interface up before any iris command runs, with allowed-ips
  covering the entire gamenet (e.g. `10.100.0.0/15`).
- ~50 GB free for pcaps if you intend to keep a full 8h game.

On each vulnbox (handled by `iris-setup --enroll-vulnbox`, only listed for
reference):

- Linux, Docker.
- Root SSH access (password or key, see step 5).

---

## 3. From zero to ready

```sh
git clone https://github.com/caverav/iris.git ~/iris && cd ~/iris

./iris-setup --init-analysis     # 4 prompts, ~30 s
docker compose up -d --build     # one-time image build, ~3 min
```

`--init-analysis` will:

1. ask for your gamenet IP, an admin password for the Settings/admin API,
   and retention horizons (pcap age, DB age);
2. write `.env` with sensible defaults;
3. generate the bootstrap keypair at `./iris-keys/id_ed25519`;
4. seed `services/test_pcap/` so the assembler has somewhere to write to.

After this:

- iris UI: `http://<your-gamenet-IP>:3000`
- iris API: `http://<your-gamenet-IP>:5000`
- bootstrap pubkey: `./iris-keys/id_ed25519.pub` (every vulnbox you enroll
  will get this added to its root `authorized_keys`)

The `iris` profile is on by default. The `fetcher` profile is added
automatically the first time you enroll a vulnbox. The `janitor` profile
needs explicit opt-in via `COMPOSE_PROFILES` if you want retention; the
wizard adds it.

---

## 4. Configuring for the game

When the org hands you the gamenet WG config, the vulnbox IPs and the
tick start time:

```sh
cd ~/iris
$EDITOR .env
```

Set:

```
VM_IP=<your team's gamenet IP>            # e.g. 10.60.6.1
TICK_START=<game-start ISO-8601 UTC>      # e.g. 2026-05-11T16:00:00Z
TICK_LENGTH=120000                        # ICC default, ms
IRIS_BOOTSTRAP_API_BASE=http://<VM_IP>:5000
TEAM_ID=<your team number>
```

Then:

```sh
docker compose restart api classifier
```

(The classifier reads `TICK_START` / `TICK_LENGTH` on startup, so it has
to be bounced when they change.)

---

## 5. Enrolling vulnboxes

For each vulnbox the org gives you:

```sh
# pick ONE auth method per shell session, then enroll:

# password auth (most common for ICC):
export IRIS_VULNBOX_PASSWORD='<root password>'

# or key auth:
# export IRIS_VULNBOX_SSH_KEY=~/.ssh/your_key
# export IRIS_VULNBOX_SSH_KEY_PASSPHRASE='...'    # optional

./iris-setup --enroll-vulnbox 10.60.X.2
./iris-setup --enroll-vulnbox 10.60.X.3
# ...
```

Each enroll takes 60-90 s (most of it is the first-time docker image build
on the vulnbox). It is idempotent and re-runnable. After all vulnboxes are
enrolled, populate the service list:

```sh
./iris-setup --discover-services
```

This SSHes every enrolled vulnbox, docker-inspects the running game
service containers, and writes the IP:port list into
`services/api/configurations.py`. The api container is automatically
rebuilt with the new config.

Within ~30 seconds of enrollment, traffic starts flowing:

- vulnbox-side Suricata writes pcaps + eve.json
- analysis-box `fetcher` rsyncs them every 30 s
- `assembler` ingests new pcap data and writes flows
- `enricher` tails eve.json and tags flows with alert signatures
- `classifier` starts auto-tagging flows once it has 10+ ticks of data

---

## 6. Custom analytics features

This fork adds three signal sources on top of vanilla iris.

### 6.1 The classifier (`auto:checker` / `auto:attacker`)

The `classifier` container polls recent flows every 30 s, computes a
**canonical content fingerprint** for each flow (HTTP path + body skeleton
with rotating values like timestamps / flag tokens / random IDs masked
out, plus TCP byte-size buckets), and counts how many distinct ticks each
fingerprint appears in.

- If a fingerprint appears in `>= CLASSIFIER_CHECKER_TH` fraction of the
  last `CLASSIFIER_WINDOW_TICKS` ticks, every flow with that fingerprint
  is tagged `auto:checker`.
- If it appears in `<= CLASSIFIER_ATTACKER_TH` fraction (and is seen at
  least `CLASSIFIER_MIN_OBS` times overall), it is tagged `auto:attacker`.
- Flows whose fingerprint repeats in the middle of those thresholds are
  left untagged.

The intuition is that the checker is a deterministic program that fires
the same shapes every tick, so its flows form a tight cluster; attackers
fire unique payloads (enumeration, exploit chains) so each flow sits in
its own cluster. Combined with the fact that gamenet NAT anonymizes
source IPs, this is one of the only generalizable ways to separate the
two without org cooperation.

Tunable via env on the classifier container:

```
CLASSIFIER_CHECKER_TH=0.3
CLASSIFIER_ATTACKER_TH=0.1
CLASSIFIER_WINDOW_TICKS=20
CLASSIFIER_MIN_OBS=3
CLASSIFIER_POLL=30
```

`manual:checker` and `manual:attacker` tags are operator-set overrides.
The classifier skips any flow that already carries a `manual:*` tag.

### 6.2 TCP SYN fingerprint (`flow.syn_meta`)

The `syn_tagger.py` helper (run periodically; see below) reads the
captured pcaps, extracts each flow's **first SYN** packet, and writes a
small structured attribute onto `flow.syn_meta`:

```json
{ "ttl": 63, "df": true, "win": 65535,
  "mss": 1380, "wscale": 6, "sack": true, "opts": "MNWNNTSE" }
```

`opts` is the TCP option *order* (M=MSS, S=SAckOK, T=Timestamp, N=NOP,
W=WScale, E=EOL) - this is the highest-signal field. On a NAT'd gamenet
the SNAT preserves the caller's TCP option behaviour, so callers can be
bucketed by OS:

- `MNWNNTSE` / win 65535 / ws 6: macOS
- `MSTNW` / various ws values: Linux (python-requests is the common one
  with ws 11)
- TTL 62 vs 63 vs 64: distance from origin (your own outbound flows have
  TTL 64; the NAT decrements once).

These are rendered as **chips** in the iris UI rather than tags:

- a compact `t63/MSTNW` chip on every flow row (right of the packet count)
- a labelled chip row in the flow detail header
  (`ttl 63   win 42780   mss 1380   ws 11   opts MSTNW`)

Filter via:

```
POST /query  { "syn_ttl": 63, "syn_opts": "MNWNNTSE" }
```

### 6.3 Manual tag overrides

```
POST   /flow/<UUID>/tag/<name>     # add tag
DELETE /flow/<UUID>/tag/<name>     # remove tag
```

Use the conventional names `manual:checker` and `manual:attacker` if you
want to override the classifier. Any tag starting with `manual:` causes
the classifier to skip that flow on subsequent passes.

---

## 7. Running the SYN tagger

The classifier runs as a long-lived service. The SYN tagger is a one-shot
script that you re-run periodically. A wrapper is in the deploy kit, but
the canonical invocation is:

```sh
docker run --rm \
  -v "$HOME/iris/services/test_pcap:/traffic:ro" \
  -v "$HOME/iris/syn_tagger.py:/t.py:ro" \
  --network iris_internal \
  -e TIMESCALE='postgres://iris@timescale:5432/iris' \
  -e SYN_WINDOW='7 days' \
  python:3.11-slim sh -c \
  'pip install --quiet --no-cache-dir scapy psycopg[binary] && python3 -u /t.py "/traffic/log.pcap.*" --apply --strip-tags'
```

It is idempotent. A reasonable cadence is every 10 minutes from cron,
or after every `--enroll-vulnbox` once you have ~5 ticks of data.

---

## 8. Two analysis boxes (hot standby)

ICC officially allocates one analysis box per team but nothing stops you
from running a backup. The two boxes do not share state by default; they
each have their own bootstrap keypair and their own DB.

Pre-game setup is the same on both. At game time you bring up only ONE
box and treat the other as cold standby. If the primary fails:

1. Bring up WireGuard on the backup.
2. Edit `.env` on the backup with the same gamenet values
   (`VM_IP`, `TICK_START`, `IRIS_BOOTSTRAP_API_BASE`, `TEAM_ID`).
3. `docker compose restart api classifier`.
4. Re-enroll every vulnbox **from the backup**. Each enroll will add the
   backup's bootstrap pubkey to the vulnbox's `authorized_keys`; the
   primary's pubkey stays in place (so the primary could resume if it
   comes back).
5. `./iris-setup --discover-services` and you are back.

The backup does not get the primary's historic flows. If that matters,
you can rsync the timescale data volume between boxes, but the simpler
approach is to consider history "lost" on failover and start clean.

---

## 9. Useful one-liners

```sh
# health
docker ps --filter name=iris- --format '{{.Names}}\t{{.Status}}'

# tail classifier
docker logs -f iris-classifier-1

# flow counts by classification (last hour)
docker exec iris-timescale-1 psql -U iris -d iris -c "
  SELECT CASE
    WHEN tags ? 'manual:checker'  THEN 'manual:checker'
    WHEN tags ? 'manual:attacker' THEN 'manual:attacker'
    WHEN tags ? 'auto:checker'    THEN 'auto:checker'
    WHEN tags ? 'auto:attacker'   THEN 'auto:attacker'
    ELSE 'unclassified'
  END AS class, count(*)
  FROM flow WHERE time > now() - interval '1 hour'
  GROUP BY 1 ORDER BY 2 DESC;
"

# TTL distribution (after syn_tagger has run)
docker exec iris-timescale-1 psql -U iris -d iris -c "
  SELECT syn_meta->>'ttl', syn_meta->>'opts', count(*)
  FROM flow WHERE syn_meta IS NOT NULL
  GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10;
"
```

---

## 10. Troubleshooting

- **fetcher container restart-looping** before any vulnbox is enrolled:
  expected. `iris-setup --enroll-vulnbox` sets `VULNBOX_LIST` and the
  fetcher comes up clean. If you want silence pre-game, remove `fetcher`
  from `COMPOSE_PROFILES` in `.env`.

- **assembler logs `Flushed 0 closed N`**: the assembler only writes
  flows that carry payload data. Pure SYN/RST scans get counted as
  "closed" but never flushed. Normal as long as legitimate flows do
  reassemble correctly.

- **classifier tags 0 checker / many attacker**: the fingerprint may be
  too specific. Lower `CLASSIFIER_CHECKER_TH` (default 0.3 is appropriate
  when checker rotates through N actions per tick). Also confirm the
  `TICK_LENGTH` and `TICK_START` in `.env` match the org's clock.

- **no `syn_meta` chips in UI**: hard-refresh the browser (Ctrl+Shift+R).
  The frontend bundle is hashed but a stale `index.html` will point at
  the old bundle. Then verify the API returns `syn_meta` for the flow:
  `curl /flow/<UUID>` should include the structured field.

- **vulnbox enroll hangs at "Streaming bootstrap"**: the SSH password is
  wrong, or the vulnbox is unreachable from your gamenet IP. Test
  manually: `ssh root@<vulnbox-ip>` should prompt for password.

- **`glitch checks` shows DOWN even though services respond**: org's
  checker runs on a separate clock. Wait at least one full tick after the
  service comes up. If it persists, sanity-check the org's expected port
  vs what is actually published (`docker port` on the vulnbox).
