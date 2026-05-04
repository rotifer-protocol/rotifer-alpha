import type { SVGProps } from "react";

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

// Beluga (white whale) — rounded mammalian whale silhouette with sleek body and tail flukes
export function BelugaIcon({ size, ...props }: IconProps) {
  return (
    <svg {...defaults(size)} {...props}>
      <path d="M3 13c2-3 6-5 11-5s7 2 8 4c-1 2-4 3-7 3" />
      <path d="M22 12c-1 1-2 2-1 3" />
      <path d="M22 14c-1 0-2-0.5-2-1" />
      <path d="M14 15c0 1 0 2 1 3" />
      <path d="M8 14c-2 1-4 1-5 2" />
      <circle cx="6" cy="11.5" r="0.6" fill="currentColor" stroke="none" />
      <path d="M9 12c0.5 0.3 1 0.3 1.5 0" />
    </svg>
  );
}

// Leviathan (sea monster, deep-water creature) — coiled tentacled silhouette suggesting massive scale
export function LeviathanIcon({ size, ...props }: IconProps) {
  return (
    <svg {...defaults(size)} {...props}>
      <path d="M12 4c-3 0-5 2-5 5s2 4 4 4-2 2-2 5c0 1 1 2 2 2" />
      <path d="M12 4c3 0 5 2 5 5s-2 4-4 4 2 2 2 5c0 1-1 2-2 2" />
      <circle cx="10" cy="9" r="0.8" fill="currentColor" stroke="none" />
      <circle cx="14" cy="9" r="0.8" fill="currentColor" stroke="none" />
      <path d="M3 17c1 1 3 2 5 1" />
      <path d="M21 17c-1 1-3 2-5 1" />
      <path d="M5 20c1-1 2-2 3-1.5" />
      <path d="M19 20c-1-1-2-2-3-1.5" />
    </svg>
  );
}

export const FUND_ICONS: Record<string, typeof CheetahIcon> = {
  cheetah: CheetahIcon,
  octopus: OctopusIcon,
  turtle: TurtleIcon,
  shark: SharkIcon,
  gambler: HoneyBadgerIcon,
  beluga: BelugaIcon,
  leviathan: LeviathanIcon,
};
