/* Iris tags.
   The actual styling lives in index.css under .tag / .tag.v-* - variants
   (danger / warn / ok / info / acc / muted) are selected here and the CSS
   handles dot-vs-chip rendering via the `html[data-tag-style]` attribute.
   The enricher emits namespaced `rule:*` / `sid:*` tags which are muted
   so they don't compete with high-signal tags like `blocked`. */
import classNames from "classnames";

type Variant = "danger" | "warn" | "ok" | "info" | "acc" | "muted";

const variantMap: Record<string, Variant> = {
  blocked: "danger",
  enemy: "danger",
  "flag-in": "warn",
  "flag-out": "warn",
  flag_in: "warn",
  flag_out: "warn",
  suricata: "info",
  fishy: "info",
  starred: "acc",
  "auto:checker": "ok",
  "manual:checker": "ok",
  "auto:attacker": "danger",
  "manual:attacker": "danger",
};

function resolveVariant(tag: string): Variant {
  const direct = variantMap[tag];
  if (direct) return direct;
  if (tag.startsWith("rule:") || tag.startsWith("sid:")) return "muted";
  if (tag.startsWith("flag")) return "warn";
  return "muted";
}

interface TagProps {
  tag: string;
  color?: string;
  disabled?: boolean;
  excluded?: boolean;
  onClick?: () => void;
}

export const Tag = ({ tag, disabled = false, excluded = false, onClick }: TagProps) => {
  const variant = resolveVariant(tag);
  return (
    <span
      className={classNames("tag", `v-${variant}`, {
        "is-off": disabled,
        "is-excluded": excluded,
        "is-on": !disabled && !excluded,
      })}
      title={tag}
      onClick={onClick}
    >
      {tag}
    </span>
  );
};

/* Returns an oklch color string usable by ApexCharts / inline styles. Kept
   compatible with the old callsite in Corrie.tsx that expected a real color
   value. Uses OKLCH so the hue stays in sync with the runtime accent. */
export function tagToColor(tag: string): string {
  const v = resolveVariant(tag);
  switch (v) {
    case "danger":
      return "oklch(0.70 0.21 24)";
    case "warn":
      return "oklch(0.80 0.17 70)";
    case "ok":
      return "oklch(0.78 0.17 155)";
    case "info":
      return "oklch(0.78 0.15 220)";
    case "acc":
      return "oklch(0.72 0.22 326)";
    case "muted":
    default:
      return "rgb(95 92 110)";
  }
}
