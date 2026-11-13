export const APP_VERSION = "2.3.300";
export const ANDROID_APP_VERSION = "2.4.18";
export const IOS_APP_VERSION = "2.4.18";
export const ANDROID_APK_RELEASE_VERSION = "2.3.300";
export const AGENT_VERSION = "2.2.212";

export const PANEL_AGENT_COMPATIBILITY_LIMIT = 5;
export const PANEL_AGENT_COMPATIBILITY = [
  { panelVersion: APP_VERSION, agentVersion: AGENT_VERSION },
] as const;
