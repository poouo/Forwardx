/** Shared geometry for the on-page brand and browser-tab icon. */
export const FORWARDX_LOGO = {
  viewBox: "0 0 120 120",
  radius: 30,
  body: "M26 28 L68 28 L68 40 L40 40 L40 50 L58 50 L58 60 L40 60 L40 92 L26 92 Z",
  chevron: "M52 57 L84 35 L94 45 L70 60 L94 75 L84 85 L52 63 Z",
} as const;

export function logoSecondaryColor(primary: string) {
  return `color-mix(in srgb, ${primary} 70%, #0d9488)`;
}

function xmlAttribute(value: string) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function defaultLogoSvg(primary: string) {
  const color = primary.trim() || "#236de9";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${FORWARDX_LOGO.viewBox}" width="120" height="120" fill="none"><defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${xmlAttribute(color)}"/><stop offset="100%" stop-color="${xmlAttribute(logoSecondaryColor(color))}"/></linearGradient><linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#d1fae5"/><stop offset="100%" stop-color="#a7f3d0"/></linearGradient><filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="rgba(0,0,0,0.18)"/></filter></defs><rect width="120" height="120" rx="${FORWARDX_LOGO.radius}" fill="url(#bg)"/><g filter="url(#glow)"><path d="${FORWARDX_LOGO.body}" fill="#ffffff"/><path d="${FORWARDX_LOGO.chevron}" fill="url(#accent)" fill-opacity="0.95"/></g></svg>`;
}
