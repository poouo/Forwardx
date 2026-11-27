type TelegramWebAppBridge = {
  initData?: string;
  ready?: () => void;
  expand?: () => void;
};

const TELEGRAM_WEBAPP_SCRIPT_ID = "telegram-web-app";

function getTelegramWebAppBridge() {
  return (window as Window & { Telegram?: { WebApp?: TelegramWebAppBridge } }).Telegram?.WebApp;
}

export function getTelegramWebAppLaunchData(hash: string) {
  // Telegram puts its signed query string inside the URL fragment. The
  // fragment may also start with an app path followed by a question mark.
  const params = hash.slice(hash.indexOf("?") + 1).replace(/^#/, "");
  return new URLSearchParams(params).get("tgWebAppData")?.trim() || "";
}

export function getTelegramWebAppInitData() {
  return getTelegramWebAppLaunchData(window.location.hash) || getTelegramWebAppBridge()?.initData?.trim() || "";
}

export function initializeTelegramWebAppBridge() {
  const ready = () => {
    try {
      const bridge = getTelegramWebAppBridge();
      bridge?.ready?.();
      bridge?.expand?.();
    } catch {
      // WebView presentation is optional for login.
    }
  };

  if (getTelegramWebAppBridge()) {
    ready();
    return;
  }
  if (document.getElementById(TELEGRAM_WEBAPP_SCRIPT_ID)) return;

  // Load the official bridge only when opening the panel as a Mini App.
  const script = document.createElement("script");
  script.id = TELEGRAM_WEBAPP_SCRIPT_ID;
  script.src = "https://telegram.org/js/telegram-web-app.js?65";
  script.async = true;
  script.addEventListener("load", ready, { once: true });
  document.head.appendChild(script);
}
