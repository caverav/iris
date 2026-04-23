/**
 * Tiny platform helpers used to render keyboard shortcut labels.
 *
 * The hotkey *bindings* (react-hotkeys-hook) already accept `mod+k` and map
 * it to Cmd on macOS / Ctrl elsewhere, so these helpers only matter for what
 * we show the user. Keep the exports dumb and stringly-typed so callsites
 * can embed them anywhere without importing React.
 */

function detectPlatform(): string {
  if (typeof navigator === "undefined") return "";
  // userAgentData is the modern API, but Chrome can return an empty string
  // here instead of undefined, so a plain ?? is not enough.
  const uad = (navigator as any).userAgentData?.platform;
  if (uad) return uad;
  return navigator.platform || navigator.userAgent || "";
}

export const IS_MAC = /Mac|iPhone|iPad|iPod|Darwin/i.test(detectPlatform());

/** The modifier label alone, e.g. "⌘" on macOS, "Ctrl" elsewhere. */
export const MOD_LABEL: string = IS_MAC ? "⌘" : "Ctrl";

/**
 * Render "⌘K" on macOS and "Ctrl+K" elsewhere.
 * Pass a single key letter (case-insensitive); the output is upper-cased
 * so it matches keyboard-hint convention.
 */
export function modCombo(key: string): string {
  const k = key.toUpperCase();
  return IS_MAC ? `⌘${k}` : `Ctrl+${k}`;
}
