/* Shared minimal iconography. All SVGs paint via currentColor so the
   theme drives the hue. Stroke-based shapes stay crisp at 12-24px. */
import React from "react";

type IconProps = React.SVGProps<SVGSVGElement> & { size?: number };

function base(props: IconProps, children: React.ReactNode, extra: Partial<React.SVGProps<SVGSVGElement>> = {}) {
  const { size = 16, ...rest } = props;
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...extra}
      {...rest}
    >
      {children}
    </svg>
  );
}

/* The stylized iris mark used for the brand. Three upright standards
   converging at the bloom centre, two drooping falls fanning outward,
   a filled centre node, and a stem with a leaf. */
export const IrisMark = ({ size = 22, className = "" }: { size?: number; className?: string }) =>
  base(
    { size, className },
    <g strokeWidth={1.4}>
      {/* standards (upright petals) */}
      <path d="M12 3 C 11 6, 10 8, 10 10" />
      <path d="M12 3 L 12 10" />
      <path d="M12 3 C 13 6, 14 8, 14 10" />
      {/* falls (drooping petals) */}
      <path d="M10 10 C 7 11, 5 13, 5 16 C 8 16, 10 14, 11 11" />
      <path d="M14 10 C 17 11, 19 13, 19 16 C 16 16, 14 14, 13 11" />
      {/* bloom centre */}
      <circle cx="12" cy="10" r="0.8" fill="currentColor" stroke="none" />
      {/* stem + leaf */}
      <path d="M12 11 L 12 20" />
      <path d="M12 17 C 14.5 16, 16 17, 16.5 19" />
    </g>,
  );

export const IconSearch = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </>,
    { strokeWidth: 2 },
  );

export const IconFilter = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M3 5h18" />
      <path d="M7 12h10" />
      <path d="M10 19h4" />
    </>,
    { strokeWidth: 2 },
  );

export const IconHome = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M3 11.5 12 4l9 7.5" />
      <path d="M5 10v10h14V10" />
    </>,
  );

export const IconFlows = (p: IconProps) =>
  base(
    p,
    <>
      <rect x="3" y="4" width="18" height="3" rx="1" />
      <rect x="3" y="10.5" width="18" height="3" rx="1" />
      <rect x="3" y="17" width="18" height="3" rx="1" />
    </>,
  );

export const IconGraph = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M3 21V5" />
      <path d="M3 21h18" />
      <circle cx="8" cy="14" r="1.3" fill="currentColor" />
      <circle cx="13" cy="10" r="1.3" fill="currentColor" />
      <circle cx="18" cy="7" r="1.3" fill="currentColor" />
    </>,
  );

export const IconDiff = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M8 4v16" />
      <path d="M16 4v16" />
      <path d="M5 8l3-3 3 3" />
      <path d="M13 16l3 3 3-3" />
    </>,
  );

export const IconSettings = (p: IconProps) =>
  base(
    p,
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.06a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3 14H3a2 2 0 1 1 0-4h.06A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V3a2 2 0 1 1 4 0v.06A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.27.65.89 1.06 1.6 1.06H21a2 2 0 1 1 0 4h-.06c-.71 0-1.33.41-1.54 1z" />
    </>,
  );

export const IconShield = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M12 3 4 6v6c0 5 3.5 8.5 8 9 4.5-.5 8-4 8-9V6z" />
      <path d="M12 8v5" />
      <circle cx="12" cy="16" r="0.8" fill="currentColor" />
    </>,
  );

export const IconCmdK = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M7 4a3 3 0 0 0-3 3 3 3 0 0 0 3 3h10a3 3 0 0 0 3-3 3 3 0 0 0-3-3" />
      <path d="M7 14a3 3 0 0 0-3 3 3 3 0 0 0 3 3h10a3 3 0 0 0 3-3 3 3 0 0 0-3-3" />
    </>,
    { strokeWidth: 1.6 },
  );

export const IconRefresh = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </>,
    { strokeWidth: 2 },
  );

export const IconClose = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </>,
    { strokeWidth: 2, strokeLinejoin: "miter" },
  );

export const IconHeart = (p: IconProps) =>
  base(
    p,
    <path d="M12 21s-7-4.35-9.33-8.66C.67 8.6 2.6 5 6.2 5c2.03 0 3.55 1.07 4.5 2.57l.75 1.17.75-1.17C13.15 6.07 14.67 5 16.7 5c3.6 0 5.53 3.6 3.53 7.34C19 16.65 12 21 12 21z" />,
    { fill: "currentColor", stroke: "none" },
  );

export const IconHeartOutline = (p: IconProps) =>
  base(
    p,
    <path d="M12 21s-7-4.35-9.33-8.66C.67 8.6 2.6 5 6.2 5c2.03 0 3.55 1.07 4.5 2.57l.75 1.17.75-1.17C13.15 6.07 14.67 5 16.7 5c3.6 0 5.53 3.6 3.53 7.34C19 16.65 12 21 12 21z" />,
    { strokeWidth: 1.6 },
  );

export const IconLink = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 1 0-7-7l-1 1" />
      <path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 1 0 7 7l1-1" />
    </>,
    { strokeWidth: 2 },
  );

export const IconDownload = (p: IconProps) =>
  base(
    p,
    <>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </>,
  );

export const IconCopy = (p: IconProps) =>
  base(
    p,
    <>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 4H6a2 2 0 0 0-2 2v10" />
    </>,
  );

export const IconBolt = (p: IconProps) =>
  base(
    p,
    <path d="M13 2 4 14h7l-1 8 9-12h-7z" />,
    { fill: "currentColor", stroke: "none" },
  );
