# Iris split-mode playbook

Day-of-CTF runbook for deploying iris with the analysis stack on one box
and Suricata-IPS on N vulnboxes. Designed around the ICC topology where
each service runs on its own VM and you reach the gamenet via WireGuard.

The wizard automates everything that can be automated; this document is
the human side - the sysadmin commands you run on each host once, and
the order of operations on game day.

> **Pre-reqs on every host**: Linux with kernel >= 5.x, Docker (or podman
> with docker-compose shim), `git`, `curl`. The analysis box additionally
> needs `ssh-keygen`. WireGuard configured and up *before* you bring up
> any compose stack.

---

## 1. Architecture at a glance

```
                    +-------------------------+
                    |     Analysis box         |
                    |                          |
                    |  iris (timescale, api,   |
                    |  frontend, assembler,    |
                    |  enricher)               |
                    |                          |
                    |  rsync ingress dir:      |
                    |  /srv/iris-traffic       |
                    +-----+------------^------+
                          |            | pull rules (HTTP)
                          | rsync push |
                          | (SSH)      |
       +------------------+------------+-----------------+
       |                  |            |                 |
   +---+----+         +---+----+   +---+----+
   | vulnbox-A |     | vulnbox-B | | vulnbox-N |
   | Suricata-IPS    | Suricata-IPS| Suricata-IPS|
   | shipper +       | shipper +   | shipper +   |
   | rules-puller    | rules-puller| rules-puller|
   +---------+         +---------+   +---------+
```

Two channels between every vulnbox and the analysis box, both authed
against the same WireGuard mesh:

| Channel | Direction | Carries |
|---|---|---|
| SSH + rsync (port 22) | vulnbox -> analysis | `eve-<host>.json`, `<host>--<pcap>`, `status-<host>.json` |
| HTTP basic-auth (port 5000) | vulnbox -> analysis | `GET /admin/rules` for the canonical `local.rules` |

The rsync target is a single directory; multiple vulnboxes share it without
collisions because the shipper namespaces every upload by hostname.

---

## 2. Analysis-box first-time setup (~10 minutes)

Run on the box that will host the iris stack.

### 2.1 Get the source and run the wizard

```sh
git clone https://github.com/caverav/iris.git /opt/iris
cd /opt/iris
./iris-setup
```

In the wizard, choose:

- **Deployment mode**: *split - analysis* (the iris core, no local Suricata).
- **Traffic source**: *rsync* (vulnboxes will push pcaps).
- **Pcap directory**: `/srv/iris-traffic` (or wherever you want vulnbox uploads to land).
  - Set both `TRAFFIC_DIR_HOST` *and* `SURICATA_DIR_HOST` to this same path
    so the enricher reads `eve-*.json` from the same dir the shipper drops
    them into.

After the wizard finishes, run the split-mode helper:

```sh
./iris-setup --init-analysis
```

This generates an ed25519 keypair under `iris-setup/keys/` (gitignored)
and **prints** the sysadmin commands you run as root once. They look like:

```sh
sudo useradd -m -s /bin/sh iris-rsync
sudo install -d -m 700 -o iris-rsync -g iris-rsync ~iris-rsync/.ssh
echo '<the public key the wizard printed>' \
    | sudo tee -a ~iris-rsync/.ssh/authorized_keys
sudo chown iris-rsync:iris-rsync ~iris-rsync/.ssh/authorized_keys
sudo chmod 600 ~iris-rsync/.ssh/authorized_keys
sudo install -d -m 755 -o iris-rsync -g iris-rsync /srv/iris-traffic
```

Run them. Verify with:

```sh
sudo -u iris-rsync ls -la /srv/iris-traffic
sudo -u iris-rsync touch /srv/iris-traffic/.writable && sudo -u iris-rsync rm /srv/iris-traffic/.writable
```

### 2.2 Fill in the bootstrap-relevant env vars

Edit `.env` on the analysis box and set (replacing the placeholder values):

```ini
# Where vulnboxes will reach the api over WireGuard.
IRIS_BOOTSTRAP_API_BASE=http://10.0.0.1:5000

# Where vulnboxes rsync to. Same WG IP, the iris-rsync user, the dir.
VULNBOX_SSH_DEST=iris-rsync@10.0.0.1:/srv/iris-traffic

# Make sure these are still aligned with /srv/iris-traffic.
TRAFFIC_DIR_HOST=/srv/iris-traffic
SURICATA_DIR_HOST=/srv/iris-traffic
TRAFFIC_DIR_DOCKER=/traffic

# Pick a strong admin password. Vulnboxes use this to fetch rules; the
# Settings page uses it for HTTP basic auth on the editor.
IRIS_ADMIN_USER=admin
IRIS_ADMIN_PASS=<something-long-and-random>
```

> The wizard will *not* ask for these (they're split-mode only); set
> them by hand. Without them, `/admin/bootstrap` returns 503 with a
> helpful error.

### 2.3 Bring up the stack

```sh
sudo docker compose --profile iris up -d --build
sudo docker logs -f iris_api_1     # confirm clean startup
```

Browse `http://10.0.0.1:3000/settings` (the analysis box's WG IP).
You'll be prompted for `admin` / `<your password>`. Edit `local.rules`
once - even if it's just to add a comment - and click *Save & Reload*.
This populates the file so vulnboxes have something to pull.

---

## 3. Enrolling a vulnbox (~30 seconds per VM)

Repeat for every service VM the orgs give you, including ones that
appear mid-CTF.

```sh
# On the new vulnbox, as a user with sudo (the gamenet "team" user is
# usually fine):
curl -fsSL -u admin:<your-password> \
    http://10.0.0.1:5000/api/admin/bootstrap | sudo bash
```

What the bootstrap does, in order:

1. `git clone` iris into `/opt/iris` (the URL is `IRIS_REPO_URL` from the
   analysis box's env - override if you mirror internally).
2. Drop the analysis-box SSH private key at
   `/opt/iris/vulnbox-agent/id_ed25519` (mode 600).
3. Write a vulnbox-shaped `/opt/iris/.env` with the analysis URL, rsync
   destination, admin credentials, and `VULNBOX_HOSTNAME=$(hostname)` so
   uploads are namespaced.
4. `docker compose --profile suricata-ips --profile vulnbox-agent up -d --build`.

Within ~30s of completion:

- `/srv/iris-traffic/eve-<host>.json` and `<host>--*.pcap` start to appear
  on the analysis box.
- The Settings page's *vulnbox sync* panel shows the new host with its
  loaded ruleset sha256.
- The enricher picks up alerts for the new VM automatically (it
  re-resolves the `eve*.json` glob on every 30s tick).

If you forget the URL or password later, run on the analysis box:

```sh
./iris-setup --add-vulnbox
```

It re-prints the curl one-liner using the current `.env`.

---

## 4. Editing rules during the CTF

1. Browse to `/settings` on the analysis box's frontend.
2. Edit `local.rules` in the textarea.
3. Click **Verify** to syntax-check (`suricata -T -S` runs in the api
   container; takes ~5s; rejects malformed rules without writing them).
4. Click **Save & Reload**. The api:
   - Writes the file to `${SURICATA_DIR_HOST}/lib/rules/local.rules`.
   - Snapshots the previous version into `local.rules.history/<unix-ts>.rules`.
   - In all-in-one mode, also asks the *local* Suricata to hot-reload via
     its unix-command socket. In split mode, no local Suricata exists
     so this step is a no-op.
5. Each vulnbox's `pull-rules.sh` notices the changed sha256 within
   `PULL_INTERVAL` seconds (default 10), writes the new file locally,
   and asks its Suricata to `reload-rules`.
6. The *vulnbox sync* card flips from amber ("stale rules") to green
   ("synced") within ~15s.

To roll back: open the **history** list, click *restore into editor* on
a previous snapshot, then *Save & Reload* normally. (No one-click rollback
yet; this keeps "verify before apply" mandatory.)

---

## 5. Operations cookbook

### 5.1 A vulnbox got compromised mid-game; revoke its access

```sh
# Stop trusting the shared SSH key everywhere it can rsync from.
ssh root@analysis-box
sudo -u iris-rsync sed -i '/iris-vulnbox-shipper/d' ~iris-rsync/.ssh/authorized_keys

# Rotate the bootstrap keypair so future enrolments get a fresh key.
cd /opt/iris
rm iris-setup/keys/id_ed25519 iris-setup/keys/id_ed25519.pub
./iris-setup --init-analysis
# Re-run the printed authorized_keys commands.

# Re-enrol the vulnboxes you still trust by re-running the curl one-liner.
```

This kicks every vulnbox simultaneously (because they all share the same
key); they'll need re-enrolment, but the compromise is contained.

### 5.2 A vulnbox stopped reporting

The Settings page's vulnbox card turns red ("silent Nm") once
`status-<host>.json` is older than 5 minutes. Diagnose on the affected
VM:

```sh
sudo docker ps | grep -E 'shipper|suricata-ips'
sudo docker logs --tail 50 iris_shipper_1
sudo docker logs --tail 50 iris_suricata-ips_1
```

Common causes: WireGuard down on that VM, the analysis box's `iris-rsync`
user got removed, the local clock drifted by hours and SSH refuses the
session, or Suricata crashed on a bad rule (in which case the
`--queue-bypass` keeps traffic flowing but inspection is gone).

### 5.3 Add a permanent IP allow-list around the api

The bootstrap and rules endpoints are auth-gated, but if you want
defence in depth, restrict the api's port 5000 to the WireGuard
subnet on the analysis box's host firewall:

```sh
sudo iptables -I INPUT -p tcp --dport 5000 ! -s 10.0.0.0/24 -j DROP
```

(WireGuard's own crypto + the basic-auth on `/admin/*` is usually
plenty; this is belt-and-suspenders.)

### 5.4 Backup the database before risky rule edits

The whole reason iris exists is the post-attack analysis you'll do
*after* the CTF. Don't lose that DB:

```sh
sudo docker exec iris_timescale_1 pg_dump -U iris -F c iris > /var/backups/iris-$(date +%F-%H%M).dump
```

Schedule via cron every hour during the game.

---

## 6. Validating the deployment before ICC

Run this checklist a day or two before the event. Each step is ~5
minutes; the whole pass takes under an hour and catches every bug
people hit at run time.

1. **Bring up the analysis box** with the wizard, fill in the env vars
   from §2.2, run the printed sysadmin commands, `docker compose up -d`.
   - Verify: `curl -u admin:pass http://<wg-ip>:5000/api/admin/rules`
     returns 200 with `{"path": ..., "content": ...}`.
   - Verify: `curl -u admin:pass http://<wg-ip>:5000/api/admin/bootstrap`
     returns the shell script (200, `text/x-shellscript`).

2. **Spin up two test vulnboxes** (any cheap VMs on the same WireGuard
   mesh - not the real ICC ones; just rehearsal hosts). Run the curl
   one-liner on each.
   - Verify: `ls /srv/iris-traffic` on the analysis box shows
     `eve-<host>.json` and `status-<host>.json` for both within ~60s.
   - Verify: Settings page -> vulnbox sync shows both hosts as *synced*
     with matching sha256s.

3. **Edit a rule** in the Settings page (e.g. lower a sid's threshold,
   change `drop` -> `alert`), Verify, Save & Reload.
   - Verify: both vulnbox cards flip to *synced* on the new sha256
     within ~15s.
   - Verify: `sudo docker logs iris_shipper_1` on a vulnbox shows
     `[pull-rules] new ruleset (sha256=...); writing` followed by
     `suricata reload-rules: {"return": "OK"}`.

4. **Test a drop on each vulnbox.** From a third box on the WG mesh:
   ```sh
   curl http://<vulnbox-ip>:<service-port>/?p=../../../etc/passwd
   ```
   - Verify: the request hangs / RSTs (Suricata drops the GET).
   - Verify: the analysis box's UI shows the flow tagged
     `rule:path_traversal` within ~90s. The flow's destination IP is
     the vulnbox.

5. **Kill a vulnbox** (`docker compose --profile suricata-ips --profile vulnbox-agent down`).
   - Verify: its sync card turns red after 5 min.

6. **Resurrect it** (`docker compose ... up -d`).
   - Verify: green again within 30s.

If all six pass, you're ready.

---

## 7. Known limitations

- **Auth is shared-secret.** A single `IRIS_ADMIN_PASS` gates every
  `/admin/*` route, including the rules editor and the bootstrap key
  download. If the password leaks, an attacker on the gamenet can install
  arbitrary drop rules across every vulnbox or harvest the SSH key by
  curl-ing `/admin/bootstrap`. WireGuard isolation is the moat; pick a
  long random password.
- **Rule fan-out is best-effort.** The puller polls every 10s with no
  ack channel. If a vulnbox is partitioned for an hour, it'll catch up
  on the next successful poll, but you won't see *which* rule version
  it had during the gap. For a ground-truth audit, snapshot the dumped
  pcaps + eve.json - those have the real "what was loaded when each
  packet arrived" answer.
- **The bootstrap script clones a public repo.** `IRIS_REPO_URL` defaults
  to `caverav/iris` on github. If your team mirrors internally,
  override that env var on the analysis box - vulnboxes will clone from
  the mirror.
- **No per-vulnbox rule overrides.** Same `local.rules` everywhere by
  design. If one service needs a unique rule, ssh in and append to its
  local `var/lib/suricata/rules/local.rules` - but the puller will
  overwrite it on the next poll. For real per-VM rules, you'd need a
  separate file (e.g. `host.rules`) that the puller leaves alone; not
  built yet.
