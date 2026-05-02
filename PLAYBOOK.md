# Iris split-pull-mode playbook

Day-of-CTF runbook for deploying iris with the analysis stack on one box
and Suricata-IPS on N vulnboxes. Designed for ICC-style mesh networks
where the gamenet drops vulnbox -> player traffic, so the analysis box
**pulls** eve.json + pcaps over SSH instead of being pushed to.

> **Pre-reqs on every host**: Linux, kernel >= 5.x, Docker (or podman with
> the `docker compose` shim), `git`, `curl`. The analysis box additionally
> needs `ssh-keygen` and `setsid` (already in coreutils on every distro).
> Bring WireGuard up before any iris command runs.

---

## TL;DR - five commands tomorrow

```sh
sudo wg-quick up player002                           # bring the gamenet up
git clone https://github.com/caverav/iris.git ~/iris && cd ~/iris

./iris-setup --init-analysis                         # 4 questions, ~30 s
docker compose up -d --build                         # one-time build, ~3 min

export IRIS_VULNBOX_PASSWORD='<org-root-password>'   # cache for re-use
./iris-setup --enroll-vulnbox 10.60.6.1              # × N vulnboxes
./iris-setup --discover-services                     # confirm + apply
```

That's it. Iris UI lives at `http://<your-WG-IP>:3000`; fetcher pulls every
30 s; janitor prunes hourly.

---

## 1. Architecture

```
                    +-------------------------+
                    |     Analysis box         |
                    |                          |
                    |  iris (timescale, api,   |
                    |  frontend, assembler,    |
                    |  enricher, fetcher,      |
                    |  janitor)                |
                    |                          |
                    |  pulls FROM each vulnbox |
                    +--------------+----------+
                                   |  ssh + rsync
                                   |  (player -> vulnbox direction)
       +---------------------------+-------------------------+
       v                           v                          v
   +--------+                  +--------+                +--------+
   | vulnbox-A |              | vulnbox-B |            | vulnbox-N |
   | Suricata-IPS              | Suricata-IPS          | Suricata-IPS |
   +---------+                  +---------+              +---------+
```

Two channels between the analysis box and each vulnbox, **both initiated
from the analysis side**:

| Channel | Direction | Carries |
|---|---|---|
| SSH + rsync (port 22) | analysis -> vulnbox | `eve.json`, rotating `*.pcap` (pulled, namespaced by hostname) |
| HTTP basic-auth (port 5000) | vulnbox -> analysis (one-shot, at enrollment) | `GET /admin/bootstrap` returns the install script |

The vulnbox runs only `suricata-ips`; it never opens an outbound
connection back to the analysis box during the game. That's what makes
this work on one-way meshes.

---

## 2. Analysis-box setup

```sh
git clone https://github.com/caverav/iris.git ~/iris
cd ~/iris
./iris-setup --init-analysis
```

`--init-analysis` asks four short questions (the wizard fills the rest):

1. **Gamenet/WireGuard IP** - the address vulnboxes will reach for
   `/admin/bootstrap`. Auto-detected from any `wg*`/`player*`/`tun*`
   interface; press enter to accept.
2. **Admin password** - leave blank to auto-generate a random one (it
   prints to the screen). This is the basic-auth credential for every
   `/admin/*` route, including the rules editor.
3. **Retention horizons** - pcap age (h), pcap size cap (GB), DB age (h).
   Defaults: 24 / 50 / 48. Set to 0 to disable that knob.
4. **Traffic dir** - where pulled eve+pcaps land. Default: `~/iris-traffic`.

The wizard then:

- Generates `iris-keys/id_ed25519{,.pub}` if missing.
- Creates `<traffic-dir>/{etc,lib/rules,log}` and seeds them from
  `suricata/etc/suricata.yaml` + `suricata/rules/local.rules`.
- Writes a complete `.env` with `COMPOSE_PROFILES=iris,fetcher,janitor`.
- Backs up an existing `.env` to `.env.bak`.

Bring it up:

```sh
docker compose up -d --build
```

After ~3 minutes (image build is the slow part) you should see seven
containers `Up`: timescale, api, frontend, assembler, enricher, fetcher,
janitor. Smoke-test:

```sh
curl -fsS http://localhost:5000/                                # "Hello, World!"
curl -fsS -u admin:<pass> http://localhost:5000/admin/rules     # JSON
curl -fsS -u admin:<pass> http://localhost:5000/admin/bootstrap  # shell script
```

Then browse `http://<your-WG-IP>:3000` for the UI.

---

## 3. Vulnbox enrolment

Once per new VM:

```sh
export IRIS_VULNBOX_PASSWORD='<the-org-root-password>'   # one time per shell
./iris-setup --enroll-vulnbox 10.60.6.1
```

What the subcommand does, behind the curtain:

1. SSHes into `root@10.60.6.1` using the password (via `setsid` +
   `SSH_ASKPASS`; the password never touches a tty or argv).
2. Runs `curl -fsSL -u admin:<pass> http://<analysis-WG>:5000/admin/bootstrap | bash`
   on the remote. The bootstrap script:
   - Clones iris into `/opt/iris`.
   - Authorizes the analysis box's *public* key into
     `/root/.ssh/authorized_keys` (idempotent).
   - Writes a vulnbox-shaped `.env` (`COMPOSE_PROFILES=suricata-ips`,
     `NFQUEUE_SKIP_PORTS=22,53,123,1900,5353` so SSH + DNS bypass
     Suricata entirely).
   - Brings up `suricata-ips` with the iptables-nft / iptables-legacy
     auto-detection.
3. SSHes back (now via key auth - no password needed) to read `hostname`.
4. Appends `<hostname>=<ip>` to `VULNBOX_LIST` in your `.env`.
5. Reloads the fetcher: `docker compose --profile fetcher up -d --no-deps fetcher`.

Within ~30 s, files start landing in your traffic dir:
`eve-<hostname>.json`, `<hostname>--*.pcap`, `status-<hostname>.json`.

If a vulnbox needs `NFQUEUE_IFACE=game` (typical ICC, where the gamenet
shows up on its own iface name), pre-set it in your shell before the
enroll call:

```sh
NFQUEUE_IFACE=game ./iris-setup --enroll-vulnbox 10.60.6.1
```

The wizard passes that env through into the curl call, and the bootstrap
script honors it.

---

## 4. Service discovery

After enrolling all vulnboxes:

```sh
./iris-setup --discover-services
```

Walks every entry in `VULNBOX_LIST`, SSHes (key auth, post-enrollment),
runs `docker inspect` to find every container with a published port,
filters out the obvious backing services (mariadb / postgres / redis /
backend / processor / ...), and proposes a `services = [...]` block:

```
  found: Dutyfree                  172.18.0.2:80
  found: Exccel                    172.18.0.4:80
  found: Skypedia                  172.18.0.5:80
  found: Skypedia-cli              172.18.0.2:1337
  found: Mineclicker               172.18.0.2:9999

Proposed services entries:
    {"ip": "172.18.0.2", "port": 80, "name": "Dutyfree"},
    ...

Replace `services = [...]` in configurations.py with these? [Y/n]
```

On confirm, the wizard backs up the current `configurations.py` to
`.bak`, replaces the `services` block, and `docker compose up -d
--no-deps --force-recreate api frontend` so the UI picks up the new
service names immediately.

> Why docker-internal IPs? Suricata captures on the `FORWARD` chain,
> which is post-DNAT, so the assembler sees `172.18.0.x:80` for HTTP
> services. Each `(ip, port)` tuple is unique across a typical CTF team
> so the UI's service lookup disambiguates correctly. If multiple
> services share `(ip, port)`, rename them in the proposed block before
> confirming.

---

## 5. Editing rules during the CTF

1. Browse to `/settings` on the frontend.
2. Edit `local.rules` in the textarea.
3. **Verify** runs `suricata -T -S` in the api container (~5 s); rejects
   malformed rules without writing them.
4. **Save & Reload** validates -> snapshots the previous version into
   `local.rules.history/<unix-ts>.rules` -> writes the new file. In
   split-pull mode there's no local Suricata to hot-reload (you'll see
   "reload failed" - expected). The fetcher doesn't propagate rules
   today; manually push by SSH + `docker exec` if you need a mid-game
   edit:

```sh
for entry in $(awk -F= '/^VULNBOX_LIST=/{print $2}' .env | tr ',' ' '); do
  ip=${entry#*=}
  scp -i iris-keys/id_ed25519 \
      $(awk -F= '/^TRAFFIC_DIR_HOST=/{print $2}' .env)/lib/rules/local.rules \
      root@$ip:/opt/iris/suricata-runtime/lib/rules/local.rules
  ssh -i iris-keys/id_ed25519 root@$ip \
      "docker exec iris-suricata-ips-1 kill -USR2 1 || docker compose -f /opt/iris/docker-compose.yml --profile suricata-ips restart suricata-ips"
done
```

(A `--push-rules` subcommand is a reasonable next addition; not yet built.)

---

## 6. Operations cookbook

### A vulnbox got compromised mid-game; revoke its access

```sh
ssh root@<compromised-ip>                       # one last time
sed -i '/iris-vulnbox-shipper/d' /root/.ssh/authorized_keys
exit

# Then on the analysis box: rotate the bootstrap key so future enrollments
# get a fresh credential. Existing healthy vulnboxes also lose access - go
# re-enroll them after.
rm iris-keys/id_ed25519 iris-keys/id_ed25519.pub
./iris-setup --init-analysis
docker compose up -d --build api               # api re-reads the new pubkey

# Re-enroll the still-trusted vulnboxes:
./iris-setup --enroll-vulnbox <ip>             # × each
```

### A vulnbox stopped reporting

The Settings page's *vulnbox sync* card turns red ("silent Nm") when
`status-<hostname>.json` is older than 5 minutes. Diagnose:

```sh
# On analysis box:
docker logs --tail 50 iris-fetcher-1 | grep -E '<hostname>|fail'

# On the vulnbox (use the key, not the password):
ssh -i iris-keys/id_ed25519 root@<ip> '
  docker ps | grep -E "suricata|iris"
  docker logs --tail 50 iris-suricata-ips-1
'
```

Common causes: WireGuard down on that VM, the bootstrap key got
rotated and the old pubkey is no longer in `authorized_keys`, the
vulnbox's clock drifted by hours and SSH refused, or Suricata crashed
on a bad rule edit (`--queue-bypass` keeps traffic flowing but
inspection is gone).

### Backup the DB before risky rule edits

```sh
docker exec iris-timescale-1 \
  pg_dump -U iris -F c iris > /var/backups/iris-$(date +%F-%H%M).dump
```

Cron it hourly during the game.

### Manually trigger a janitor sweep

```sh
docker exec iris-janitor-1 /usr/local/bin/janitor.sh &
sleep 5
docker logs --tail 20 iris-janitor-1
```

(The container's own loop runs every `JANITOR_INTERVAL_SECONDS`, default
3600. The default in `--init-analysis` is 600 / 10 min for tighter
test-day feedback.)

---

## 7. Pre-event validation checklist

Run a day or two before ICC. Each step is ~5 minutes; the whole pass
takes under an hour and catches every bug people hit at run time.

1. **Stand up the analysis box** with `./iris-setup --init-analysis` +
   `docker compose up -d --build`. Verify all 7 containers `Up`, the
   `/admin/rules` JSON returns, and `/admin/bootstrap` returns a shell
   script.

2. **Spin up two test vulnboxes** (any cheap VMs on the same WG mesh --
   not the real ICC ones; rehearsal hosts). Run
   `./iris-setup --enroll-vulnbox <ip>` on each. Verify `eve-<host>.json`
   and `status-<host>.json` appear in the traffic dir within ~60 s, and
   the *vulnbox sync* card on the Settings page shows both green.

3. **Run `./iris-setup --discover-services`**. Confirm the proposed
   block matches reality, accept. Browse the UI: services dropdown
   should now contain the discovered names.

4. **Edit a rule** in the Settings page, Verify, Save & Reload. The
   write happens; reload fails (expected in split-pull). For now,
   manually push to vulnboxes via the snippet in §5.

5. **Test a drop on each vulnbox.** From a third box on the WG mesh:
   ```sh
   curl -m 5 'http://<vulnbox-ip>:<service-port>/?p=../../../etc/passwd'
   ```
   Expect: client-side timeout (drop). UI shows the flow tagged
   `rule:path_traversal` within ~90 s.

6. **Kill a vulnbox** and check the sync card turns red after ~5 min.
   Resurrect it; should go green within 30 s.

If all six pass, you're ready.

---

## 8. Knobs you may want

| Knob | Where | Effect |
|---|---|---|
| `IRIS_VULNBOX_PASSWORD=...` | shell env before `--enroll-vulnbox` | Skips the password prompt across N invocations. |
| `NFQUEUE_IFACE=game` | shell env before `--enroll-vulnbox` | Pins NFQUEUE to the gamenet iface on that vulnbox; no host-side noise. |
| `NFQUEUE_SKIP_PORTS` | bootstrap-set in vulnbox `.env` | Default `22,53,123,1900,5353` (SSH + noise). Edit per-vulnbox if you have unusual exposed ports. |
| `IRIS_PCAP_RETENTION_HOURS` / `IRIS_PCAP_MAX_GB` / `IRIS_DB_RETENTION_HOURS` | analysis `.env` | Janitor knobs. 0 = disabled. |
| `JANITOR_INTERVAL_SECONDS` | analysis `.env` | Sweep cadence. Default 3600; `--init-analysis` sets 600. |

---

## 9. Known limitations

- **Auth is a single shared secret.** `IRIS_ADMIN_PASS` gates every
  `/admin/*` route, including `/admin/bootstrap` (which returns the
  embedded analysis-box pubkey). If the password leaks, an attacker on
  the gamenet can install drop rules and enroll fake vulnboxes. Rotate
  via `--init-analysis` (overwrites the password) and re-enroll. Pick a
  strong password - the wizard's auto-generated one is 24 chars of
  url-safe base64.

- **Bootstrap clones a public github repo.** `IRIS_REPO_URL` defaults to
  `caverav/iris` on github. If your team mirrors internally, override
  that env var on the analysis box before enrolling.

- **Rule fan-out to vulnboxes is manual.** Settings-page edits write
  the canonical `local.rules` on the analysis box but don't auto-push
  to vulnboxes (the old `pull-rules.sh` was push-mode and is now
  unused). Use the §5 SSH snippet, or run `./iris-setup --discover-services`
  again - that one rebuilds the analysis-box services view but doesn't
  touch vulnboxes.

- **No per-vulnbox rule overrides.** Same `local.rules` everywhere by
  design. If one service needs a unique rule, ssh in and edit
  `/opt/iris/suricata-runtime/lib/rules/local.rules` directly. The
  fetcher won't overwrite it.

- **The bootstrap script is a single curl-pipe-bash.** A man-in-the-
  middle on the gamenet (between the new vulnbox and the analysis box)
  could substitute it. WireGuard's per-peer crypto is the moat;
  there's no end-to-end TLS on top.
