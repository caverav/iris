import classNames from "classnames";
import Color from "color";

const computeColorFromString = (str: string) => {
  const hue = Array.from(str).reduce(
    (hash, char) => 0 | (31 * hash + char.charCodeAt(0)),
    0
  );
  return Color(`hsl(${hue}, 100%, 50%)`).hex();
};

// Hardcode colors here
const tagColorMap: Record<string, string> = {
  fishy: "rgb(191, 219, 254)",
  blocked: "rgb(220, 38, 38)", // red-600 -- attack stopped inline
  suricata: "rgb(96, 165, 250)", // blue-400 -- generic rule hit
  flag_out: "rgb(254, 204, 204)",
  flag_in: "rgb(209, 213, 219)",
};

// Namespaced tags emitted by the enricher (rule:*, sid:*) are visually muted
// so high-signal tags like `blocked` pop.
const mutedPrefixes = ["rule:", "sid:"];

export function tagToColor(tag: string) {
  if (tagColorMap[tag]) {
    return tagColorMap[tag];
  }
  for (const prefix of mutedPrefixes) {
    if (tag.startsWith(prefix)) {
      return "rgb(229, 231, 235)"; // gray-200
    }
  }
  return computeColorFromString(tag);
}
interface TagProps {
  tag: string;
  color?: string;
  disabled?: boolean;
  excluded?: boolean;
  onClick?: () => void;
}
export const Tag = ({ tag, color, disabled = false, excluded = false, onClick }: TagProps) => {
  var tagBackgroundColor = disabled ? "#eee" : color ?? tagToColor(tag);

  var tagTextColor = disabled
    ? "#bbb"
    : Color(tagBackgroundColor).isDark()
      ? "#fff"
      : "#000";


  if (excluded) {
    tagTextColor = "white";
    tagBackgroundColor = "black";
  }
  return (
    <div
      onClick={onClick}
      className={classNames("p-3 cursor-pointer rounded-md uppercase text-xs h-5 text-center flex items-center hover:opacity-90 transition-colors duration-250 text-ellipsis overflow-hidden whitespace-nowrap", {
        "bg-gray-300": disabled,
      })}
      style={{
        backgroundColor: tagBackgroundColor,
        color: tagTextColor,
      }}
    >
      <span  style={excluded ? { textDecoration: 'line-through' } : {}}>{tag}</span>
    </div>
  );
};
