/* Settings: edit, verify, and live-reload Suricata's local.rules.
 *
 * Talks to the api container's /admin/rules/* endpoints. Auth is HTTP
 * basic; if IRIS_ADMIN_PASS is set on the backend, the first request
 * returns 401 and we show a small inline credential form. Creds live
 * in sessionStorage so they survive an in-tab refresh but not a tab
 * close - intentionally short-lived. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { API_BASE_PATH } from "../const";

type HistoryEntry = { name: string; timestamp: number; size: number };
type RulesPayload = { path: string; content: string };
type VulnboxPushResult = {
  hostname: string;
  ip: string;
  ok: boolean;
  message: string;
};
type ApplyResult = {
  ok: boolean;
  stage: "validate" | "reload";
  output: string;
  validate_output?: string;
  vulnboxes?: VulnboxPushResult[];
};
type ValidateResult = { ok: boolean; output: string };
type VulnboxStatus = {
  hostname: string;
  loaded_sha256: string;
  ts: number;
  age_seconds: number;
  stale: boolean;
  in_sync: boolean;
};
type Propagation = { current_sha256: string; vulnboxes: VulnboxStatus[] };

const CREDS_KEY = "iris.adminCreds"; // sessionStorage

function getCreds(): string | null {
  return sessionStorage.getItem(CREDS_KEY);
}

function setCreds(user: string, pass: string): void {
  sessionStorage.setItem(CREDS_KEY, btoa(`${user}:${pass}`));
}

function clearCreds(): void {
  sessionStorage.removeItem(CREDS_KEY);
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const creds = getCreds();
  if (creds) headers.set("Authorization", `Basic ${creds}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${API_BASE_PATH}${path}`, { ...init, headers });
}

function CredsForm({ onAuthed }: { onAuthed: () => void }) {
  const [user, setUser] = useState("admin");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="settings-creds"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        setCreds(user, pass);
        const r = await adminFetch("/admin/rules");
        if (r.status === 401) {
          clearCreds();
          setErr("Wrong username or password.");
          return;
        }
        onAuthed();
      }}
    >
      <h3>admin auth required</h3>
      <p>Set <code>IRIS_ADMIN_USER</code> / <code>IRIS_ADMIN_PASS</code> in <code>.env</code>.</p>
      <label>user
        <input value={user} onChange={(e) => setUser(e.target.value)} autoFocus />
      </label>
      <label>password
        <input type="password" value={pass} onChange={(e) => setPass(e.target.value)} />
      </label>
      {err && <div className="settings-err">{err}</div>}
      <button type="submit" className="ctl accent">unlock</button>
    </form>
  );
}

export function Settings() {
  const [content, setContent] = useState<string>("");
  const [original, setOriginal] = useState<string>("");
  const [path, setPath] = useState<string>("");
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [busy, setBusy] = useState<"" | "load" | "validate" | "apply">("load");
  const [needsAuth, setNeedsAuth] = useState(false);
  const [validateOut, setValidateOut] = useState<ValidateResult | null>(null);
  const [applyOut, setApplyOut] = useState<ApplyResult | null>(null);
  const [propagation, setPropagation] = useState<Propagation | null>(null);

  const loadPropagation = useCallback(async () => {
    const r = await adminFetch("/admin/rules/propagation");
    if (r.ok) setPropagation(await r.json());
  }, []);

  const load = useCallback(async () => {
    setBusy("load");
    const r = await adminFetch("/admin/rules");
    if (r.status === 401) {
      setNeedsAuth(true);
      setBusy("");
      return;
    }
    if (r.ok) {
      const data: RulesPayload = await r.json();
      setContent(data.content);
      setOriginal(data.content);
      setPath(data.path);
      const h = await adminFetch("/admin/rules/history");
      if (h.ok) setHistory((await h.json()).entries);
      await loadPropagation();
    }
    setBusy("");
  }, [loadPropagation]);

  useEffect(() => {
    load();
  }, [load]);

  // Vulnboxes pull every ~10s; refresh the propagation panel on a similar
  // cadence so a freshly-applied ruleset visibly fans out without manual
  // reload. Only polls while the tab is visible.
  useEffect(() => {
    if (needsAuth) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") loadPropagation();
    }, 10_000);
    return () => window.clearInterval(id);
  }, [needsAuth, loadPropagation]);

  const dirty = useMemo(() => content !== original, [content, original]);

  if (needsAuth) {
    return (
      <div className="settings">
        <CredsForm
          onAuthed={() => {
            setNeedsAuth(false);
            load();
          }}
        />
      </div>
    );
  }

  return (
    <div className="settings">
      <div className="settings-head">
        <h2>suricata rules</h2>
        <div className="settings-path"><code>{path}</code></div>
        <div className="settings-actions">
          <button
            className="ctl"
            disabled={busy !== "" || !dirty}
            onClick={async () => {
              setBusy("validate");
              setApplyOut(null);
              const r = await adminFetch("/admin/rules/validate", {
                method: "POST",
                body: JSON.stringify({ content }),
              });
              setValidateOut(await r.json());
              setBusy("");
            }}
          >verify</button>
          <button
            className="ctl accent"
            disabled={busy !== "" || !dirty}
            onClick={async () => {
              if (!confirm("Save and live-reload Suricata?")) return;
              setBusy("apply");
              setValidateOut(null);
              const r = await adminFetch("/admin/rules/apply", {
                method: "POST",
                body: JSON.stringify({ content }),
              });
              const data: ApplyResult = await r.json();
              setApplyOut(data);
              if (data.ok || data.stage === "reload") {
                // file was written; refresh original + history
                setOriginal(content);
                const h = await adminFetch("/admin/rules/history");
                if (h.ok) setHistory((await h.json()).entries);
              }
              setBusy("");
            }}
          >save &amp; reload</button>
          {dirty && <span className="settings-dirty">unsaved</span>}
        </div>
      </div>

      <textarea
        className="settings-editor"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        wrap="off"
      />

      {validateOut && (
        <div className={`settings-out ${validateOut.ok ? "ok" : "err"}`}>
          <strong>{validateOut.ok ? "verified OK" : "verify failed"}</strong>
          <pre>{validateOut.output || "(no output)"}</pre>
        </div>
      )}
      {applyOut && (
        <div className={`settings-out ${applyOut.ok ? "ok" : "err"}`}>
          <strong>
            {applyOut.ok
              ? applyOut.vulnboxes && applyOut.vulnboxes.length > 0
                ? `saved + pushed to ${applyOut.vulnboxes.filter((v) => v.ok).length}/${applyOut.vulnboxes.length} vulnboxes`
                : "saved & reloaded OK"
              : applyOut.stage === "validate"
              ? "validation failed - file not written"
              : "saved, fan-out had failures"}
          </strong>
          <pre>{applyOut.output || "(no local-suricata reload; see vulnbox status below)"}</pre>
          {applyOut.vulnboxes && applyOut.vulnboxes.length > 0 && (
            <ul className="settings-fanout">
              {applyOut.vulnboxes.map((v) => (
                <li key={v.hostname} className={v.ok ? "ok" : "err"}>
                  <span className="h">{v.hostname}</span>
                  <span className="b">{v.ip}</span>
                  <span className="m">{v.message}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {propagation && propagation.vulnboxes.length > 0 && (
        <div className="settings-prop">
          <h3>
            vulnbox sync .{" "}
            {propagation.vulnboxes.filter((v) => v.in_sync).length}/{propagation.vulnboxes.length}{" "}
            on current ruleset
          </h3>
          <ul>
            {propagation.vulnboxes.map((v) => (
              <li
                key={v.hostname}
                className={v.in_sync ? "ok" : v.stale ? "stale" : "lag"}
              >
                <span className="h">{v.hostname}</span>
                <span className="b">
                  {v.in_sync
                    ? "synced"
                    : v.stale
                    ? `silent ${Math.round(v.age_seconds / 60)}m`
                    : "stale rules"}
                </span>
                <span className="b" title={v.loaded_sha256}>
                  {v.loaded_sha256 ? v.loaded_sha256.slice(0, 8) : "--"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="settings-history">
        <h3>history</h3>
        {history.length === 0 && <p className="settings-empty">no snapshots yet</p>}
        <ul>
          {history.map((h) => (
            <li key={h.name}>
              <span className="t">
                {new Date(h.timestamp * 1000).toLocaleString()}
              </span>
              <span className="b">{h.size} bytes</span>
              <button
                type="button"
                className="ctl"
                onClick={async () => {
                  const r = await adminFetch(`/admin/rules/history/${encodeURIComponent(h.name)}`);
                  if (r.ok) {
                    const data: { content: string } = await r.json();
                    setContent(data.content);
                  }
                }}
              >restore into editor</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
