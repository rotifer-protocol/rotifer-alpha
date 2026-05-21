import type { SVGProps } from "react";

// v2 — force chunk hash rotation (cache-poisoning hotfix 2026-05-12)
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

const defaults = (size = 24): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  xmlns: "http://www.w3.org/2000/svg",
});

export function CheetahIcon({ size, ...props }: IconProps) {
  return (
    <svg {...defaults(size)} {...props}>
      <path d="M4 17c1-3 3-5 6-6s5-3 6-6" />
      <path d="M20 5c-1 2-3 4-5 5" />
      <path d="M10 11c-2 1-4 3-5 5" />
      <circle cx="8" cy="9" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="15" cy="10" r="0.8" fill="currentColor" stroke="none" />
      <path d="M4 17l1 2h2l1-2" />
      <path d="M14 14l1 5h1.5l0.5-3" />
    </svg>
  );
}

export function OctopusIcon({ size, ...props }: IconProps) {
  return (
    <svg {...defaults(size)} {...props}>
      <ellipse cx="12" cy="9" rx="5" ry="4" />
      <circle cx="10" cy="8" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="14" cy="8" r="0.8" fill="currentColor" stroke="none" />
      <path d="M7 12c-1 3-2 5-1 7" />
      <path d="M9 13c0 3-1 5 0 6" />
      <path d="M11 13c0 2 0 5 1 6" />
      <path d="M13 13c0 3 1 5 0 6" />
      <path d="M15 13c0 2 1 4 2 5" />
      <path d="M17 12c1 2 2 4 1 6" />
    </svg>
  );
}

export function TurtleIcon({ size, ...props }: IconProps) {
  return (
    <svg {...defaults(size)} {...props}>
      <ellipse cx="12" cy="12" rx="7" ry="5" />
      <path d="M9 9l3-2 3 2" />
      <path d="M9 15l3 2 3-2" />
      <line x1="12" y1="7" x2="12" y2="17" />
      <circle cx="6" cy="10" r="1.5" />
      <circle cx="6.2" cy="9.8" r="0.4" fill="currentColor" stroke="none" />
      <path d="M5 12l-2 2" />
      <path d="M5 14l-1 2" />
      <path d="M19 12l2 2" />
      <path d="M19 14l1 2" />
    </svg>
  );
}

export function SharkIcon({ size, ...props }: IconProps) {
  return (
    <svg {...defaults(size)} {...props}>
      <path d="M2 14c2-1 5-3 10-3s8 2 10 3" />
      <path d="M12 11c0-4 1-6 2-7" />
      <path d="M22 14c-1 1-4 3-10 3s-9-2-10-3" />
      <path d="M7 14l-3 3" />
      <circle cx="8" cy="13" r="0.6" fill="currentColor" stroke="none" />
      <path d="M18 13l1 0.5-1 0.5" />
    </svg>
  );
}

export function HoneyBadgerIcon({ size, ...props }: IconProps) {
  return (
    <svg {...defaults(size)} {...props}>
      <path d="M4 11c0-3 3-6 8-6s8 3 8 6c0 2-1 4-3 5l-1 3h-2l-1-2h-2l-1 2H8l-1-3c-2-1-3-3-3-5z" />
      <path d="M4 9c2-1 6-1 8-1s6 0 8 1" strokeWidth="2.5" />
      <circle cx="9" cy="11" r="1" fill="currentColor" stroke="none" />
      <circle cx="15" cy="11" r="1" fill="currentColor" stroke="none" />
      <path d="M10 14c1 0.5 3 0.5 4 0" />
    </svg>
  );
}

// FUND_ICONS: all 15 fund IDs (3×5 matrix, ADR-274 D7).
// _m and _l variants share the same icon as the base personality;
// tier is distinguished by the S/M/L badge rendered next to the icon in the UI.
export const FUND_ICONS: Record<string, typeof CheetahIcon> = {
  cheetah: CheetahIcon,   cheetah_m: CheetahIcon,   cheetah_l: CheetahIcon,
  octopus: OctopusIcon,   octopus_m: OctopusIcon,   octopus_l: OctopusIcon,
  turtle:  TurtleIcon,    turtle_m:  TurtleIcon,     turtle_l:  TurtleIcon,
  shark:   SharkIcon,     shark_m:   SharkIcon,      shark_l:   SharkIcon,
  honey_badger: HoneyBadgerIcon, honey_badger_m: HoneyBadgerIcon, honey_badger_l: HoneyBadgerIcon,
};
// cache-bust: 2
export const FUND_ICONS_VERSION = 2;
