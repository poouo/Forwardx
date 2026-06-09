import { useState, useCallback, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eye, EyeOff, Loader2, Sun, Moon, RefreshCw, UserPlus, LogIn, Send, Settings as SettingsIcon, Server, ShieldCheck, Zap } from "lucide-react";
import { toast } from "sonner";
import { useTheme } from "@/contexts/ThemeContext";
import { useLocation } from "wouter";
import { mobileAuth } from "@/lib/mobileAuth";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Browser } from "@capacitor/browser";
import { ACCOUNT_DISABLED_ERR_MSG } from "@shared/const";

const REGISTRATION_CLOSED_MESSAGE = "当前注册未开放，请联系管理员";

type Mode = "login" | "register";

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function getTelegramLoginDomainStatus(panelPublicUrl?: string | null) {
  if (typeof window === "undefined") {
    return { valid: false, message: "正在检测当前访问地址..." };
  }
  const configuredUrl = String(panelPublicUrl || "").trim();
  if (!configuredUrl) {
    return { valid: false, message: "管理员尚未配置面板公开访问域名，暂不能使用 Telegram 快捷登录。" };
  }
  let configured: URL;
  try {
    configured = new URL(configuredUrl);
  } catch {
    return { valid: false, message: "面板公开访问地址配置无效，请联系管理员检查系统设置。" };
  }
  const { protocol, hostname } = window.location;
  if (configured.hostname && configured.hostname !== hostname) {
    return { valid: false, message: "当前访问域名与面板公开访问域名不一致，请使用管理员配置的域名访问。" };
  }
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(":");

  if (isLocalhost) {
    return { valid: false, message: "请使用已配置的正式域名。" };
  }
  if (protocol !== "https:" && !isLocalhost) {
    return { valid: false, message: "请使用 HTTPS 域名访问。" };
  }
  if (configured.protocol !== "https:") {
    return { valid: false, message: "面板公开访问地址需要配置为 HTTPS 域名。" };
  }
  if (isIpAddress) {
    return { valid: false, message: "请使用已配置的域名访问。" };
  }
  return { valid: true, message: "" };
}

function isMobileNetworkError(message: string) {
  return /failed to fetch|fetch failed|networkerror/i.test(message);
}

type TelegramLoginPayload = {
  id: string | number;
  first_name?: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string | number;
  hash: string;
};

type MobileTelegramLoginState = {
  code: string;
  telegramUrl: string;
  expiresAt: number;
};

type TwoFactorChallengeState = {
  challengeId: string;
  username: string;
  expiresAt: number;
};

const LOGIN_WELCOME_TOAST_KEY = "forwardx.loginWelcome";
const LOGIN_NOTICE_TOAST_KEY = "forwardx.loginNotice";
const DISPLAY_NAME_MAX_LENGTH = 24;
const authHighlights = [
  { title: "多节点管理", text: "统一管理分散在不同服务器的转发节点", icon: Server },
  { title: "安全可靠", text: "TLS 加密传输，权限精细控制", icon: ShieldCheck },
  { title: "高性能转发", text: "负载均衡与故障转移，保障服务可用", icon: Zap },
];

function getWelcomeName(user: any) {
  return String(user?.name || user?.username || "用户").trim() || "用户";
}

function rememberLoginWelcome(user: any) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(LOGIN_WELCOME_TOAST_KEY, getWelcomeName(user));
}

declare global {
  interface Window {
    forwardxTelegramLogin?: (user: TelegramLoginPayload) => void;
  }
}

export default function Login() {
  const [location] = useLocation();
  const initialMode = new URLSearchParams(location.split("?")[1] || "").get("mode") === "register" ? "register" : "login";
  const [mode, setMode] = useState<Mode>(initialMode);
  const [username, setUsername] = useState(() => mobileAuth.getUsername());
  const [password, setPassword] = useState(() => mobileAuth.getPassword());
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [telegramLoginCode, setTelegramLoginCode] = useState<string | null>(null);
  const [mobileTelegramLogin, setMobileTelegramLogin] = useState<MobileTelegramLoginState | null>(null);
  const [twoFactorChallenge, setTwoFactorChallenge] = useState<TwoFactorChallengeState | null>(null);
  const [twoFactorCode, setTwoFactorCode] = useState("");
  const [panelUrlDraft, setPanelUrlDraft] = useState(() => mobileAuth.getPanelUrl());
  const [showPanelSettings, setShowPanelSettings] = useState(false);
  const telegramWidgetRef = useRef<HTMLDivElement | null>(null);
  const { resolvedTheme, setTheme } = useTheme();
  const hasMobilePanelUrl = !mobileAuth.isNative || mobileAuth.hasPanelUrl();

  useEffect(() => {
    if (typeof window === "undefined") return;
    const message = window.sessionStorage.getItem(LOGIN_NOTICE_TOAST_KEY);
    if (!message) return;
    window.sessionStorage.removeItem(LOGIN_NOTICE_TOAST_KEY);
    toast.error(message);
  }, []);

  useEffect(() => {
    const nextMode = new URLSearchParams(location.split("?")[1] || "").get("mode") === "register" ? "register" : "login";
    setMode(nextMode);
  }, [location]);

  const utils = trpc.useUtils();
  const { data: emailConfig } = trpc.auth.emailConfig.useQuery(undefined, {
    enabled: hasMobilePanelUrl,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const { data: telegramLoginStatus } = trpc.telegram.loginStatus.useQuery(undefined, {
    enabled: hasMobilePanelUrl,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const registrationEnabled = emailConfig?.registrationEnabled !== false;

  useEffect(() => {
    if (mode === "register" && !registrationEnabled) {
      toast.info(REGISTRATION_CLOSED_MESSAGE);
      setMode("login");
    }
  }, [mode, registrationEnabled]);

  // 获取验证码
  const captchaQuery = trpc.auth.getCaptcha.useQuery(undefined, {
    enabled: showCaptcha && hasMobilePanelUrl,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const refreshCaptcha = useCallback(() => {
    if (!hasMobilePanelUrl) {
      setCaptchaAnswer("");
      return;
    }
    captchaQuery.refetch();
    setCaptchaAnswer("");
  }, [captchaQuery, hasMobilePanelUrl]);

  // 登录 mutation
  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: (data) => {
      if (data.twoFactorRequired) {
        setTwoFactorChallenge({
          challengeId: data.challengeId,
          username: data.username,
          expiresAt: Date.now() + data.expiresInSeconds * 1000,
        });
        setTwoFactorCode("");
        toast.info("请输入双重验证验证码");
        return;
      }
      if (mobileAuth.isNative) {
        mobileAuth.setCredentials(username, password);
        mobileAuth.setToken(data.mobileToken);
      }
      rememberLoginWelcome(data);
      utils.auth.me.invalidate();
      window.location.href = "/";
    },
    onError: (error) => {
      const msg = error.message || "";
      if (mobileAuth.isNative && isMobileNetworkError(msg)) {
        toast.error("无法连接面板，请检查右上角面板地址");
        setShowPanelSettings(true);
        return;
      }
      if (msg === "CAPTCHA_REQUIRED" || msg === "CAPTCHA_REQUIRED_AFTER_FAIL") {
        setShowCaptcha(true);
        refreshCaptcha();
        if (msg === "CAPTCHA_REQUIRED_AFTER_FAIL") {
          toast.error("用户名或密码错误，请输入验证码后重试");
        } else {
          toast.error("请输入验证码");
        }
      } else {
        toast.error(msg || "登录失败");
        if (msg === ACCOUNT_DISABLED_ERR_MSG && mobileAuth.isNative) {
          mobileAuth.clear();
        }
        if (showCaptcha) refreshCaptcha();
      }
    },
  });

  const telegramLoginMutation = trpc.telegram.login.useMutation({
    onSuccess: (data) => {
      if (mobileAuth.isNative) {
        mobileAuth.setToken(data.mobileToken);
      }
      rememberLoginWelcome(data);
      utils.auth.me.invalidate();
      window.location.href = "/";
    },
    onError: (error) => {
      if (error.message === ACCOUNT_DISABLED_ERR_MSG && mobileAuth.isNative) mobileAuth.clear();
      toast.error(error.message || "Telegram 登录失败");
    },
  });

  const telegramWidgetLoginMutation = trpc.telegram.loginWithWidget.useMutation({
    onSuccess: (data) => {
      rememberLoginWelcome(data);
      utils.auth.me.invalidate();
      window.location.href = "/";
    },
    onError: (error) => {
      if (error.message === ACCOUNT_DISABLED_ERR_MSG && mobileAuth.isNative) mobileAuth.clear();
      toast.error(error.message || "Telegram 登录失败");
    },
  });

  const mobileTelegramStatusMutation = trpc.telegram.mobileLoginStatus.useMutation({
    onSuccess: (data) => {
      if (data.status !== "success") return;
      mobileAuth.setToken(data.mobileToken);
      setMobileTelegramLogin(null);
      rememberLoginWelcome(data);
      utils.auth.me.invalidate();
      window.location.href = "/";
    },
    onError: (error) => {
      setMobileTelegramLogin(null);
      if (error.message === ACCOUNT_DISABLED_ERR_MSG) mobileAuth.clear();
      toast.error(error.message || "Telegram 登录失败");
    },
    onSettled: () => {
      mobileTelegramStatusPendingRef.current = false;
    },
  });

  const verifyTwoFactorLoginMutation = trpc.auth.verifyTwoFactorLogin.useMutation({
    onSuccess: (data) => {
      if (mobileAuth.isNative) {
        mobileAuth.setCredentials(username, password);
        mobileAuth.setToken(data.mobileToken);
      }
      rememberLoginWelcome(data);
      utils.auth.me.invalidate();
      window.location.href = "/";
    },
    onError: (error) => {
      if (error.message === ACCOUNT_DISABLED_ERR_MSG && mobileAuth.isNative) mobileAuth.clear();
      toast.error(error.message || "双重验证失败");
    },
  });
  const mobileTelegramStatusPendingRef = useRef(false);
  const mobileTelegramStatusMutateRef = useRef(mobileTelegramStatusMutation.mutate);

  useEffect(() => {
    mobileTelegramStatusPendingRef.current = mobileTelegramStatusMutation.isPending;
  }, [mobileTelegramStatusMutation.isPending]);

  useEffect(() => {
    mobileTelegramStatusMutateRef.current = mobileTelegramStatusMutation.mutate;
  }, [mobileTelegramStatusMutation.mutate]);

  const startMobileTelegramLoginMutation = trpc.telegram.startMobileLogin.useMutation({
    onSuccess: async (data) => {
      const openedAt = Date.now();
      setMobileTelegramLogin({
        code: data.code,
        telegramUrl: data.telegramUrl,
        expiresAt: openedAt + data.expiresInSeconds * 1000,
      });
      if (mobileAuth.isNative) {
        window.location.href = data.telegramUrl;
      } else {
        await Browser.open({ url: data.telegramUrl }).catch(() => {
          window.open(data.telegramUrl, "_blank", "noopener,noreferrer");
        });
      }
      toast.success("已打开 Telegram");
    },
    onError: (error) => {
      const msg = error.message || "";
      if (mobileAuth.isNative && isMobileNetworkError(msg)) {
        toast.error("无法连接面板，请检查右上角面板地址");
        setShowPanelSettings(true);
        return;
      }
      toast.error(msg || "无法发起 Telegram 登录");
    },
  });

  // 注册 mutation
  const registerMutation = trpc.auth.register.useMutation({
    onSuccess: (data) => {
      toast.success(data.message || "注册成功");
      setMode("login");
      setConfirmPassword("");
      setName("");
      setCaptchaAnswer("");
      refreshCaptcha();
    },
    onError: (error) => {
      const msg = error.message || "";
      if (mobileAuth.isNative && isMobileNetworkError(msg)) {
        toast.error("无法连接面板，请检查右上角面板地址");
        setShowPanelSettings(true);
        return;
      }
      toast.error(msg || "注册失败");
      refreshCaptcha();
    },
  });

  const sendEmailCodeMutation = trpc.auth.sendEmailCode.useMutation({
    onSuccess: () => toast.success("验证码已发送，5 分钟内有效"),
    onError: (error) => {
      const msg = error.message || "";
      if (mobileAuth.isNative && isMobileNetworkError(msg)) {
        toast.error("无法连接面板，请检查右上角面板地址");
        setShowPanelSettings(true);
        return;
      }
      toast.error(msg || "发送验证码失败");
    },
  });

  // 切换到注册模式时自动显示验证码
  useEffect(() => {
    if (mode === "register" && registrationEnabled) {
      setShowCaptcha(true);
    }
  }, [mode, registrationEnabled]);

  useEffect(() => {
    const code = new URLSearchParams(location.split("?")[1] || "").get("tg");
    if (!code || telegramLoginCode === code || telegramLoginMutation.isPending) return;
    setTelegramLoginCode(code);
    telegramLoginMutation.mutate({ code, mobile: mobileAuth.isNative });
  }, [location, telegramLoginCode, telegramLoginMutation]);

  const telegramBotUsername = telegramLoginStatus?.botUsername?.replace(/^@/, "").trim();
  const showTelegramLogin = mode === "login" && !!telegramLoginStatus?.enabled && !!telegramLoginStatus?.configured;
  const telegramDomainStatus = getTelegramLoginDomainStatus(telegramLoginStatus?.panelPublicUrl);
  const canRenderTelegramWidget = !mobileAuth.isNative && showTelegramLogin && !!telegramBotUsername && telegramDomainStatus.valid;

  useEffect(() => {
    if (!mobileAuth.isNative || !mobileTelegramLogin) return;
    let cancelled = false;
    const poll = () => {
      if (cancelled) return;
      if (Date.now() >= mobileTelegramLogin.expiresAt) {
        setMobileTelegramLogin(null);
        toast.error("Telegram 登录已超时，请重新尝试");
        return;
      }
      if (!mobileTelegramStatusPendingRef.current) {
        mobileTelegramStatusPendingRef.current = true;
        mobileTelegramStatusMutateRef.current({ code: mobileTelegramLogin.code });
      }
    };
    poll();
    const interval = window.setInterval(poll, 2000);
    const handleFocus = () => poll();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") poll();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [mobileTelegramLogin?.code, mobileTelegramLogin?.expiresAt]);

  useEffect(() => {
    const container = telegramWidgetRef.current;
    if (!canRenderTelegramWidget || !telegramBotUsername || !container) return;

    window.forwardxTelegramLogin = (user: TelegramLoginPayload) => {
      telegramWidgetLoginMutation.mutate(user);
    };

    container.innerHTML = "";
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", telegramBotUsername);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-radius", "8");
    script.setAttribute("data-onauth", "forwardxTelegramLogin(user)");
    container.appendChild(script);

    return () => {
      container.innerHTML = "";
      delete window.forwardxTelegramLogin;
    };
  }, [canRenderTelegramWidget, telegramBotUsername, telegramWidgetLoginMutation]);

  const handleVerifyTwoFactorLogin = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!twoFactorChallenge) return;
    if (!twoFactorCode.trim()) {
      toast.error("请输入双重验证验证码");
      return;
    }
    verifyTwoFactorLoginMutation.mutate({
      challengeId: twoFactorChallenge.challengeId,
      code: twoFactorCode.trim(),
      mobile: mobileAuth.isNative,
    });
  };

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (mobileAuth.isNative) {
      if (!mobileAuth.hasPanelUrl()) {
        toast.error("请先点击右上角设置按钮添加服务器地址");
        return;
      }
    }
    if (!username.trim() || !password.trim()) {
      toast.error("请输入用户名和密码");
      return;
    }
    if (showCaptcha) {
      if (!captchaAnswer.trim()) {
        toast.error("请输入验证码答案");
        return;
      }
      loginMutation.mutate({
        username: username.trim(),
        password,
        captchaId: captchaQuery.data?.captchaId,
        captchaAnswer: parseInt(captchaAnswer.trim(), 10),
        mobile: mobileAuth.isNative,
      });
    } else {
      loginMutation.mutate({
        username: username.trim(),
        password,
        mobile: mobileAuth.isNative,
      });
    }
  };

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
    if (mobileAuth.isNative && !mobileAuth.hasPanelUrl()) {
      toast.error("请先点击右上角设置按钮添加服务器地址");
      return;
    }
    if (!registrationEnabled) {
      toast.info(REGISTRATION_CLOSED_MESSAGE);
      setMode("login");
      return;
    }
    if (!username.trim() || !password.trim()) {
      toast.error("请输入用户名和密码");
      return;
    }
    if (password !== confirmPassword) {
      toast.error("两次输入的密码不一致");
      return;
    }
    if (password.length < 6) {
      toast.error("密码至少6个字符");
      return;
    }
    if (!isEmail(username)) {
      toast.error("注册用户名必须是邮箱格式");
      return;
    }
    if (emailConfig?.verifyRegistration) {
      if (!email.trim()) {
        toast.error("请填写邮箱地址");
        return;
      }
      if (!emailCode.trim()) {
        toast.error("请输入邮箱验证码");
        return;
      }
    }
    if (!captchaAnswer.trim()) {
      toast.error("请输入验证码答案");
      return;
    }
    if (name.trim().length > DISPLAY_NAME_MAX_LENGTH) {
      toast.error(`显示名称最多 ${DISPLAY_NAME_MAX_LENGTH} 个字符`);
      return;
    }
    if (!captchaQuery.data?.captchaId) {
      toast.error("验证码加载失败，请刷新");
      return;
    }
    registerMutation.mutate({
      username: username.trim(),
      password,
      name: name.trim() || undefined,
      email: email.trim() || undefined,
      emailCode: emailCode.trim() || undefined,
      captchaId: captchaQuery.data.captchaId,
      captchaAnswer: parseInt(captchaAnswer.trim(), 10),
    });
  };

  const toggleTheme = () => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  };

  const savePanelUrl = () => {
    const normalized = mobileAuth.normalizePanelUrl(panelUrlDraft);
    if (!mobileAuth.isValidPanelUrl(normalized)) {
      toast.error("请输入完整面板地址，例如 https://panel.example.com");
      return;
    }
    mobileAuth.setPanelUrl(normalized);
    setPanelUrlDraft(normalized);
    setShowPanelSettings(false);
    setCaptchaAnswer("");
    void utils.invalidate();
    toast.success("面板地址已保存");
  };

  const handleMobileTelegramLogin = () => {
    if (!mobileAuth.hasPanelUrl()) {
      toast.error("请先点击右上角设置按钮添加服务器地址");
      setShowPanelSettings(true);
      return;
    }
    startMobileTelegramLoginMutation.mutate();
  };

  const cancelTwoFactorLogin = () => {
    setTwoFactorChallenge(null);
    setTwoFactorCode("");
    setPassword("");
  };

  const isPending = loginMutation.isPending || registerMutation.isPending;
  const isTwoFactorPending = verifyTwoFactorLoginMutation.isPending;
  const isTelegramPending = telegramLoginMutation.isPending || telegramWidgetLoginMutation.isPending;
  const isMobileTelegramWaiting = startMobileTelegramLoginMutation.isPending || !!mobileTelegramLogin;

  return (
    <div className="mobile-login-screen auth-shell relative min-h-screen overflow-hidden">
      <div className="auth-grid-overlay pointer-events-none absolute inset-0 opacity-[0.14]" />
      <div className="absolute right-4 top-4 z-20 flex items-center gap-2">
        {mobileAuth.isNative && (
          <button
            onClick={() => {
              setPanelUrlDraft(mobileAuth.getPanelUrl());
              setShowPanelSettings(true);
            }}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-background/80 text-foreground shadow-sm ring-1 ring-border/60 transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="设置面板地址"
            title="设置面板地址"
          >
            <SettingsIcon className={mobileAuth.hasPanelUrl() ? "h-5 w-5 text-muted-foreground" : "h-5 w-5 text-amber-500"} />
          </button>
        )}
        <button
          onClick={toggleTheme}
          className="flex h-9 w-9 items-center justify-center rounded-lg bg-background/80 text-foreground shadow-sm ring-1 ring-border/60 transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Toggle theme"
          title={resolvedTheme === "dark" ? "切换到白天模式" : "切换到黑夜模式"}
        >
          {resolvedTheme === "dark" ? (
            <Sun className="h-5 w-5 text-muted-foreground" />
          ) : (
            <Moon className="h-5 w-5 text-muted-foreground" />
          )}
        </button>
      </div>

      <div className="relative z-10 grid min-h-screen lg:grid-cols-[minmax(0,1.05fr)_minmax(460px,.95fr)]">
        <section className="relative hidden lg:flex">
          <div className="relative flex min-h-screen w-full items-center px-10 py-14 xl:px-16">
            <div className="max-w-xl">
              <div className="flex items-center gap-3">
                <img src={resolvedTheme === "dark" ? "/logo-dark.png" : "/logo-light.png"} alt="ForwardX" className="h-11 w-11 object-contain" />
                <span className="text-2xl font-bold tracking-tight text-foreground">ForwardX</span>
              </div>
              <p className="mt-7 max-w-lg text-lg leading-8 text-foreground/72">
                高性能端口转发管理面板，轻松管理您的网络流量
              </p>
              <div className="mt-8 grid max-w-md grid-cols-3 gap-3">
                {["转发", "隧道", "流量"].map((label) => (
                  <div key={label} className="rounded-lg border border-border/45 bg-background/35 px-3 py-2 text-center text-sm font-medium text-foreground/85 shadow-sm backdrop-blur">
                    {label}
                  </div>
                ))}
              </div>
              <div className="mt-10 space-y-6">
                {authHighlights.map((item) => {
                  const Icon = item.icon;
                  return (
                    <div key={item.title} className="flex gap-4">
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-background/45 text-primary shadow-sm ring-1 ring-border/50 backdrop-blur">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div className="min-w-0">
                        <h2 className="text-sm font-semibold text-foreground">{item.title}</h2>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">{item.text}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        <main className="flex min-h-screen items-center justify-center px-4 py-20 sm:px-6 lg:px-10">
          <Card disableEnterAnimation className="auth-card-surface w-full max-w-[420px] px-5 py-6 sm:px-7">
            <CardHeader className="px-0 pb-7 text-left">
              <div className="mb-5 flex items-center gap-3 lg:hidden">
                <img
                  src={resolvedTheme === "dark" ? "/logo-dark.png" : "/logo-light.png"}
                  alt="ForwardX"
                  className="h-10 w-10 object-contain"
                />
                <span className="text-lg font-semibold tracking-tight">ForwardX</span>
              </div>
              <CardTitle className="text-2xl font-bold tracking-tight">
                {mode === "login" ? "欢迎回来" : "创建账号"}
              </CardTitle>
              <CardDescription className="mt-1 text-sm text-muted-foreground">
                {isTelegramPending ? "正在通过 Telegram 登录" : mode === "login" ? "请登录您的账户" : "使用邮箱注册 ForwardX 账户"}
              </CardDescription>
            </CardHeader>
            <CardContent className="px-0">
          {isTelegramPending ? (
            <div className="flex flex-col items-center justify-center gap-3 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <span>正在验证一次性登录码...</span>
            </div>
          ) : mode === "login" ? (
            <form onSubmit={handleLogin} className="space-y-4">
              {mobileAuth.isNative && !hasMobilePanelUrl && (
                <button
                  type="button"
                  onClick={() => setShowPanelSettings(true)}
                  className="w-full rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-left text-sm text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-300"
                >
                  未添加服务器地址，请点击右上角设置按钮添加
                </button>
              )}
              <div className="space-y-2">
                <Label htmlFor="username">用户名</Label>
                <Input
                  id="username"
                  type="text"
                  placeholder="请输入用户名"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus={!mobileAuth.isNative || hasMobilePanelUrl}
                  disabled={isPending}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">密码</Label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? "text" : "password"}
                    placeholder="请输入密码"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    disabled={isPending}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              {/* 验证码（登录失败后显示） */}
              {showCaptcha && (
                <div className="space-y-2">
                  <Label htmlFor="captcha">验证码</Label>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 px-3 py-2 rounded-md border bg-muted text-center font-mono text-lg font-bold select-none tracking-widest">
                      {captchaQuery.isLoading ? "..." : captchaQuery.data?.question || "加载中"}
                    </div>
                    <button
                      type="button"
                      onClick={refreshCaptcha}
                      className="h-9 w-9 flex items-center justify-center hover:bg-accent rounded-lg transition-colors"
                      title="刷新验证码"
                    >
                      <RefreshCw className="h-4 w-4 text-muted-foreground" />
                    </button>
                  </div>
                  <Input
                    id="captcha"
                    type="number"
                    placeholder="请输入计算结果"
                    value={captchaAnswer}
                    onChange={(e) => setCaptchaAnswer(e.target.value)}
                    disabled={isPending}
                  />
                </div>
              )}

              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={isPending}
              >
                {loginMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    登录中...
                  </>
                ) : (
                  <>
                    <LogIn className="mr-2 h-4 w-4" />
                    登录
                  </>
                )}
              </Button>

              {showTelegramLogin && (
                <div className="space-y-3">
                  <div className="relative flex items-center justify-center">
                    <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
                    <span className="relative bg-card px-3 text-xs text-muted-foreground">或</span>
                  </div>
                  <div className="rounded-lg border border-border/50 bg-muted/20 p-3">
                    <div className="mb-3 flex items-center justify-center gap-2 text-sm font-medium">
                      <Send className="h-4 w-4 text-sky-500" />
                      Telegram 快捷登录
                    </div>
                    {mobileAuth.isNative ? (
                      <div className="space-y-2">
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full gap-2"
                          onClick={handleMobileTelegramLogin}
                          disabled={!hasMobilePanelUrl || isMobileTelegramWaiting}
                        >
                          {isMobileTelegramWaiting ? (
                            <>
                              <Loader2 className="h-4 w-4 animate-spin" />
                              等待 Telegram 确认
                            </>
                          ) : (
                            <>
                              <Send className="h-4 w-4" />
                              打开 Telegram 登录
                            </>
                          )}
                        </Button>
                        {mobileTelegramLogin ? (
                          <div className="space-y-2">
                            <p className="text-center text-xs leading-5 text-muted-foreground">
                              请在 Telegram 中确认登录。
                            </p>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="w-full text-xs"
                              onClick={() => setMobileTelegramLogin(null)}
                            >
                              取消本次登录
                            </Button>
                          </div>
                        ) : (
                          <p className="text-center text-xs leading-5 text-muted-foreground">
                            已绑定账户可用。
                          </p>
                        )}
                      </div>
                    ) : canRenderTelegramWidget ? (
                      <div
                        ref={telegramWidgetRef}
                        className={`flex min-h-11 justify-center ${telegramWidgetLoginMutation.isPending ? "pointer-events-none opacity-60" : ""}`}
                      />
                    ) : !telegramDomainStatus.valid ? (
                      <p className="text-center text-xs leading-5 text-muted-foreground">
                        {telegramDomainStatus.message}
                      </p>
                    ) : (
                      <p className="text-center text-xs text-muted-foreground">配置完成后可用。</p>
                    )}
                  </div>
                </div>
              )}

              <div className="text-center">
                <button
                  type="button"
                  onClick={() => {
                    if (!registrationEnabled) {
                      toast.info(REGISTRATION_CLOSED_MESSAGE);
                      return;
                    }
                    setMode("register");
                    setCaptchaAnswer("");
                  }}
                  className="text-sm text-muted-foreground hover:text-primary transition-colors"
                >
                  没有账号？点击注册
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-4">
              {mobileAuth.isNative && !hasMobilePanelUrl && (
                <button
                  type="button"
                  onClick={() => setShowPanelSettings(true)}
                  className="w-full rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-left text-sm text-amber-700 transition-colors hover:bg-amber-500/15 dark:text-amber-300"
                >
                  未添加服务器地址，请点击右上角设置按钮添加
                </button>
              )}
              <div className="space-y-2">
                <Label htmlFor="reg-username">用户名</Label>
                <Input
                  id="reg-username"
                  type="text"
                  placeholder="请输入邮箱作为用户名"
                  value={username}
                  onChange={(e) => {
                    setUsername(e.target.value);
                    if (!email || email === username) setEmail(e.target.value);
                  }}
                  autoComplete="username"
                  autoFocus
                  disabled={isPending || !hasMobilePanelUrl}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="reg-name">昵称（选填）</Label>
                <Input
                  id="reg-name"
                  type="text"
                  placeholder="显示名称"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={DISPLAY_NAME_MAX_LENGTH}
                  disabled={isPending}
                />
              </div>
              {emailConfig?.verifyRegistration && (
                <div className="space-y-2">
                  <Label htmlFor="reg-email">邮箱</Label>
                  <div className="flex gap-2">
                    <Input
                      id="reg-email"
                      type="email"
                      placeholder="用于接收验证码"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      disabled={isPending}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      disabled={!hasMobilePanelUrl || !email.trim() || sendEmailCodeMutation.isPending}
                      onClick={() => sendEmailCodeMutation.mutate({ email: email.trim() })}
                    >
                      {sendEmailCodeMutation.isPending ? "发送中" : "发送验证码"}
                    </Button>
                  </div>
                  <Input
                    type="text"
                    inputMode="numeric"
                    placeholder="请输入邮箱验证码"
                    value={emailCode}
                    onChange={(e) => setEmailCode(e.target.value)}
                    disabled={isPending}
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="reg-password">密码</Label>
                <div className="relative">
                  <Input
                    id="reg-password"
                    type={showPassword ? "text" : "password"}
                    placeholder="至少6个字符"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    disabled={isPending}
                    className="pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="reg-confirm">确认密码</Label>
                <Input
                  id="reg-confirm"
                  type="password"
                  placeholder="再次输入密码"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                  disabled={isPending}
                />
              </div>

              {/* 注册验证码（始终显示） */}
              <div className="space-y-2">
                <Label htmlFor="reg-captcha">验证码</Label>
                <div className="flex items-center gap-2">
                  <div className="flex-1 px-3 py-2 rounded-md border bg-muted text-center font-mono text-lg font-bold select-none tracking-widest">
                    {captchaQuery.isLoading ? "..." : captchaQuery.data?.question || "加载中"}
                  </div>
                  <button
                    type="button"
                    onClick={refreshCaptcha}
                    className="h-9 w-9 flex items-center justify-center hover:bg-accent rounded-lg transition-colors"
                    title="刷新验证码"
                  >
                    <RefreshCw className="h-4 w-4 text-muted-foreground" />
                  </button>
                </div>
                <Input
                  id="reg-captcha"
                  type="number"
                  placeholder="请输入计算结果"
                  value={captchaAnswer}
                  onChange={(e) => setCaptchaAnswer(e.target.value)}
                  disabled={isPending || !hasMobilePanelUrl}
                />
              </div>

              <Button
                type="submit"
                className="w-full"
                size="lg"
                disabled={isPending}
              >
                {registerMutation.isPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    注册中...
                  </>
                ) : (
                  <>
                    <UserPlus className="mr-2 h-4 w-4" />
                    注册
                  </>
                )}
              </Button>

              <div className="text-center">
                <button
                  type="button"
                  onClick={() => { setMode("login"); setCaptchaAnswer(""); }}
                  className="text-sm text-muted-foreground hover:text-primary transition-colors"
                >
                  已有账号？返回登录
                </button>
              </div>

              <p className="text-xs text-muted-foreground text-center">
                注册后需要管理员授权才能使用转发功能
              </p>
            </form>
          )}
            </CardContent>
          </Card>
        </main>
      </div>

      {mobileAuth.isNative && (
        <Dialog open={showPanelSettings} onOpenChange={setShowPanelSettings}>
          <DialogContent className="w-[calc(100vw-2rem)] max-w-sm">
            <DialogTitle>面板地址</DialogTitle>
            <DialogDescription>APP 将连接这个面板地址。</DialogDescription>
            <div className="space-y-2">
              <Label htmlFor="mobile-panel-url">服务器地址</Label>
              <Input
                id="mobile-panel-url"
                type="url"
                placeholder="https://panel.example.com"
                value={panelUrlDraft}
                onChange={(e) => setPanelUrlDraft(e.target.value)}
                autoComplete="url"
                autoFocus
              />
            </div>
            <DialogFooter className="gap-2">
              <Button className="w-full sm:w-auto" variant="outline" onClick={() => setShowPanelSettings(false)}>
                取消
              </Button>
              <Button className="w-full sm:w-auto" onClick={savePanelUrl}>
                保存
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <Dialog
        open={!!twoFactorChallenge}
        onOpenChange={(open) => {
          if (!open && !isTwoFactorPending) cancelTwoFactorLogin();
        }}
      >
        <DialogContent className="w-[calc(100vw-2rem)] max-w-sm">
          <DialogTitle>双重验证</DialogTitle>
          <DialogDescription>
            请输入 2FA 软件中当前显示的动态验证码。
          </DialogDescription>
          <form onSubmit={handleVerifyTwoFactorLogin} className="space-y-4">
            <div className="rounded-lg border border-border/50 bg-muted/20 p-3 text-sm">
              <p className="font-medium">{twoFactorChallenge?.username}</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="two-factor-code">动态验证码</Label>
              <Input
                id="two-factor-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="请输入 6 位验证码"
                value={twoFactorCode}
                onChange={(e) => setTwoFactorCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                autoComplete="one-time-code"
                autoFocus
                disabled={isTwoFactorPending}
              />
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" className="w-full sm:w-auto" onClick={cancelTwoFactorLogin} disabled={isTwoFactorPending}>
                返回
              </Button>
              <Button type="submit" className="w-full sm:w-auto" disabled={isTwoFactorPending || twoFactorCode.length < 6}>
                {isTwoFactorPending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    验证中...
                  </>
                ) : (
                  <>
                    <LogIn className="mr-2 h-4 w-4" />
                    验证并登录
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
