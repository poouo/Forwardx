import { cn } from "@/lib/utils";
import { FORWARDX_LOGO, logoSecondaryColor } from "@/lib/brandLogo";

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
      viewBox={FORWARDX_LOGO.viewBox}
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
          <stop offset="100%" stopColor={logoSecondaryColor("var(--primary, #236de9)")} />
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
          rx={FORWARDX_LOGO.radius}
          fill="url(#forwardx-logo-bg)"
        />
      )}

      {/* Modern stylized F & X Forward glyph */}
      <g filter="url(#forwardx-glow)">
        {/* Main "F" spine and upper arm */}
        <path
          d={FORWARDX_LOGO.body}
          fill="#ffffff"
        />

        {/* Dynamic Forward Chevron (X forward arm) */}
        <path
          d={FORWARDX_LOGO.chevron}
          fill="url(#forwardx-chevron-accent)"
          fillOpacity="0.95"
        />
      </g>
    </svg>
  );
}

export default ForwardXLogo;

