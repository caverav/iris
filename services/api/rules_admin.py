"""Settings-page backend for editing Suricata's local.rules.

Exposes helpers that the Flask app wires into routes:

* :func:`read_rules` / :func:`write_rules` - read/write the active file,
  with an automatically-rotated history dir alongside it.
* :func:`validate_rules` - run ``suricata -T -S`` on a candidate body
  without touching the live file.
* :func:`reload_rules` - ask the running Suricata to swap its ruleset
  via its unix-command JSON socket. Falls back to "needs restart" if the
  socket is missing or unreachable.

History is stored under ``<rules_path>.history/<unix-ts>.rules`` so the
frontend can show the last few versions and roll back.

Auth is handled in :func:`require_admin`. When IRIS_ADMIN_PASS is unset
the wrapper logs a warning once and allows through - this matches the
project's dev-mode-by-default posture but is *not* something to ship to
a hostile network without setting credentials.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
import socket
import subprocess
import tempfile
import time
from base64 import b64decode
from dataclasses import dataclass
from functools import wraps
from pathlib import Path
from typing import Optional

from flask import Response, request

log = logging.getLogger(__name__)

RULES_PATH = Path(os.environ.get("IRIS_RULES_PATH", "/suricata/rules/local.rules"))
HISTORY_DIR = RULES_PATH.parent / f"{RULES_PATH.name}.history"
SURICATA_SOCKET = os.environ.get(
    "IRIS_SURICATA_SOCKET", "/run/suricata/suricata-command.socket"
)
HISTORY_KEEP = 20  # last N versions retained in the history dir


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

_unauth_warned = False


def require_admin(view):
    """Decorator: gate a route behind HTTP basic auth.

    Credentials come from IRIS_ADMIN_USER / IRIS_ADMIN_PASS. If PASS is
    unset, we log a one-shot warning and let the request through - the
    iris UI has no auth elsewhere and we don't want first-run setup to
    require credential plumbing. Set IRIS_ADMIN_PASS in production.
    """

    @wraps(view)
    def wrapper(*args, **kwargs):
        global _unauth_warned
        expected_user = os.environ.get("IRIS_ADMIN_USER", "admin")
        expected_pass = os.environ.get("IRIS_ADMIN_PASS", "")
        if not expected_pass:
            if not _unauth_warned:
                log.warning(
                    "Settings endpoints are UNAUTHENTICATED: set IRIS_ADMIN_PASS "
                    "to enable HTTP basic auth on /admin/* routes."
                )
                _unauth_warned = True
            return view(*args, **kwargs)

        # Parse basic auth header by hand - werkzeug's request.authorization
        # has caveats with non-ASCII passwords; this is small enough to inline.
        header = request.headers.get("Authorization", "")
        if not header.startswith("Basic "):
            return _challenge()
        try:
            user, pwd = b64decode(header[6:]).decode("utf-8").split(":", 1)
        except Exception:
            return _challenge()
        # constant-time compare on each component to avoid leaking the
        # username via timing
        if not (
            hmac.compare_digest(user, expected_user)
            and hmac.compare_digest(pwd, expected_pass)
        ):
            return _challenge()
        return view(*args, **kwargs)

    return wrapper


def _challenge() -> Response:
    return Response(
        "auth required",
        status=401,
        headers={"WWW-Authenticate": 'Basic realm="iris-settings"'},
    )


# ---------------------------------------------------------------------------
# Rules read/write + history
# ---------------------------------------------------------------------------


@dataclass
class HistoryEntry:
    name: str  # filename, e.g. "1714540123.rules"
    timestamp: int  # parsed unix ts
    size: int


def read_rules() -> str:
    if not RULES_PATH.exists():
        return ""
    return RULES_PATH.read_text(encoding="utf-8", errors="replace")


def write_rules(content: str) -> None:
    """Atomically replace the rules file, snapshotting the previous body."""
    RULES_PATH.parent.mkdir(parents=True, exist_ok=True)
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)

    if RULES_PATH.exists():
        ts = int(time.time())
        snap = HISTORY_DIR / f"{ts}.rules"
        # Avoid clobbering a snapshot taken in the same second.
        suffix = 0
        while snap.exists():
            suffix += 1
            snap = HISTORY_DIR / f"{ts}_{suffix}.rules"
        snap.write_bytes(RULES_PATH.read_bytes())
        _trim_history()

    tmp = RULES_PATH.with_suffix(RULES_PATH.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    tmp.replace(RULES_PATH)


def _trim_history() -> None:
    """Keep only the most recent HISTORY_KEEP snapshots."""
    if not HISTORY_DIR.exists():
        return
    snaps = sorted(
        HISTORY_DIR.glob("*.rules"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for old in snaps[HISTORY_KEEP:]:
        try:
            old.unlink()
        except OSError:
            pass


def list_history() -> list[HistoryEntry]:
    if not HISTORY_DIR.exists():
        return []
    out: list[HistoryEntry] = []
    for p in sorted(HISTORY_DIR.glob("*.rules"), reverse=True):
        try:
            stem = p.stem.split("_", 1)[0]
            ts = int(stem)
        except ValueError:
            ts = int(p.stat().st_mtime)
        out.append(HistoryEntry(name=p.name, timestamp=ts, size=p.stat().st_size))
    return out


def read_history(name: str) -> Optional[str]:
    safe = HISTORY_DIR / Path(name).name  # strip any path components
    if not safe.exists() or safe.parent != HISTORY_DIR:
        return None
    return safe.read_text(encoding="utf-8", errors="replace")


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@dataclass
class ValidationResult:
    ok: bool
    output: str  # combined stdout+stderr from suricata -T


def validate_rules(content: str) -> ValidationResult:
    """Syntax-check a candidate ruleset via ``suricata -T -S``.

    Writes the body to a temp file (suricata refuses inline strings),
    runs the test, and returns the combined log. ``-T`` exits non-zero
    if any rule fails to parse.
    """
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".rules", delete=False, encoding="utf-8"
    ) as fh:
        fh.write(content)
        tmp_path = fh.name
    try:
        # -T: test mode, exit after loading config and rules
        # -S: load only the listed signature file, ignore default-rule-path
        # --runmode=single: forces a no-thread runmode that's safe in -T
        proc = subprocess.run(
            ["suricata", "-T", "-S", tmp_path, "--runmode=single"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return ValidationResult(
            ok=proc.returncode == 0,
            output=(proc.stdout + proc.stderr).strip(),
        )
    except subprocess.TimeoutExpired:
        return ValidationResult(ok=False, output="suricata -T timed out after 30s")
    except FileNotFoundError:
        return ValidationResult(
            ok=False,
            output="suricata binary not present in api container - rebuild required",
        )
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# Reload via unix-command JSON socket
# ---------------------------------------------------------------------------


@dataclass
class ReloadResult:
    ok: bool
    message: str


def reload_rules() -> ReloadResult:
    """Trigger a hot rule reload over Suricata's unix-command socket.

    Suricata's protocol: a version handshake, then JSON commands one per
    line. ``reload-rules`` reloads atomically; on parse failure the old
    ruleset stays loaded. Falls back gracefully if the socket isn't
    reachable (Suricata down or different mode).
    """
    if not Path(SURICATA_SOCKET).exists():
        return ReloadResult(
            ok=False,
            message=(
                f"unix-command socket {SURICATA_SOCKET} not found - Suricata "
                "may be down, or unix-command isn't enabled in suricata.yaml. "
                "Restart suricata-ips to apply the new rules."
            ),
        )
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(15)
            s.connect(SURICATA_SOCKET)
            _send(s, {"version": "0.2"})
            handshake = _recv(s)
            if handshake.get("return") != "OK":
                return ReloadResult(
                    ok=False, message=f"handshake rejected: {handshake}"
                )
            _send(s, {"command": "reload-rules"})
            reply = _recv(s)
            if reply.get("return") == "OK":
                return ReloadResult(ok=True, message=reply.get("message", "ok"))
            return ReloadResult(
                ok=False, message=f"suricata refused reload: {reply}"
            )
    except (OSError, socket.timeout, json.JSONDecodeError) as e:
        return ReloadResult(ok=False, message=f"socket error: {e}")


def _send(sock: socket.socket, obj: dict) -> None:
    sock.sendall((json.dumps(obj) + "\n").encode("utf-8"))


def _recv(sock: socket.socket) -> dict:
    """Read a single newline-terminated JSON object from the socket."""
    buf = b""
    while b"\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
    line, _, _ = buf.partition(b"\n")
    if not line:
        return {}
    return json.loads(line.decode("utf-8"))
