import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface ForwardXLogoProps {
  size?: number | string;
  className?: string;
  alt?: string;
  src?: string | null;
  /** When true, renders pure vector mark without the container squircle */
  markOnly?: boolean;
}

export function ForwardXLogo({
  size = 28,
  className,
  alt = "ForwardX",
  src,
  markOnly = false,
}: ForwardXLogoProps) {
  const dimension = typeof size === "number" ? `${size}px` : size;

  // If a custom uploaded logo exists, display it as an image
  if (src) {
    return (
      <img
        src={src}
        alt={alt}
        style={{ width: dimension, height: dimension }}
        className={cn("shrink-0 object-contain", className)}
      />
    );
  }

  return (
    <svg
      viewBox="0 0 120 120"
      width={dimension}
      height={dimension}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("shrink-0 select-none", className)}
      role="img"
      aria-label={alt}
    >
      <defs>
        <linearGradient id="forwardx-logo-bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="var(--primary, #236de9)" />
          <stop offset="100%" stopColor="color-mix(in srgb, var(--primary, #236de9) 70%, #0d9488)" />
        </linearGradient>
        <linearGradient id="forwardx-chevron-accent" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#d1fae5" />
          <stop offset="100%" stopColor="#a7f3d0" />
        </linearGradient>
        <filter id="forwardx-glow" x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="rgba(0,0,0,0.18)" />
        </filter>
      </defs>

      {!markOnly && (
        <rect
          width="120"
          height="120"
          rx="30"
          fill="url(#forwardx-logo-bg)"
        />
      )}

      {/* Modern stylized F & X Forward glyph */}
      <g filter="url(#forwardx-glow)">
        {/* Main "F" spine and upper arm */}
        <path
          d="M26 28 L68 28 L68 40 L40 40 L40 50 L58 50 L58 60 L40 60 L40 92 L26 92 Z"
          fill="#ffffff"
        />

        {/* Dynamic Forward Chevron (X forward arm) */}
        <path
          d="M52 57 L84 35 L94 45 L70 60 L94 75 L84 85 L52 63 Z"
          fill="url(#forwardx-chevron-accent)"
          fillOpacity="0.95"
        />
      </g>
    </svg>
  );
}

export default ForwardXLogo;

