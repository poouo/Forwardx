import { useState, useCallback, useEffect, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Eye, EyeOff, Loader2, Sun, Moon, RefreshCw, UserPlus, LogIn, Send } from "lucide-react";
import { toast } from "sonner";
import { useTheme } from "@/contexts/ThemeContext";
import { useLocation } from "wouter";

const REGISTRATION_CLOSED_MESSAGE = "当前注册未开放，请联系管理员";

type Mode = "login" | "register";

function isEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function getTelegramLoginDomainStatus() {
  if (typeof window === "undefined") {
    return { valid: false, message: "正在检测当前访问地址..." };
  }
  const { protocol, hostname } = window.location;
  const isLocalhost = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  const isIpAddress = /^(\d{1,3}\.){3}\d{1,3}$/.test(hostname) || hostname.includes(":");

  if (isLocalhost) {
    return { valid: false, message: "Telegram 快捷登录需要使用在 BotFather 里配置过的正式域名，本地地址仅适合调试账号密码登录。" };
  }
  if (protocol !== "https:" && !isLocalhost) {
    return { valid: false, message: "Telegram 快捷登录需要使用已配置域名的 HTTPS 地址访问面板。" };
  }
  if (isIpAddress) {
    return { valid: false, message: "Telegram 快捷登录不支持直接使用 IP 访问，请使用在 BotFather 里配置过的域名打开面板。" };
  }
  return { valid: true, message: "" };
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

declare global {
  interface Window {
    forwardxTelegramLogin?: (user: TelegramLoginPayload) => void;
  }
}

export default function Login() {
  const [location] = useLocation();
  const initialMode = new URLSearchParams(location.split("?")[1] || "").get("mode") === "register" ? "register" : "login";
  const [mode, setMode] = useState<Mode>(initialMode);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [showCaptcha, setShowCaptcha] = useState(false);
  const [telegramLoginCode, setTelegramLoginCode] = useState<string | null>(null);
  const telegramWidgetRef = useRef<HTMLDivElement | null>(null);
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    const nextMode = new URLSearchParams(location.split("?")[1] || "").get("mode") === "register" ? "register" : "login";
    setMode(nextMode);
  }, [location]);

  const utils = trpc.useUtils();
  const { data: emailConfig } = trpc.auth.emailConfig.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });
  const { data: telegramLoginStatus } = trpc.telegram.loginStatus.useQuery(undefined, {
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
    enabled: showCaptcha,
    refetchOnWindowFocus: false,
  });

  const refreshCaptcha = useCallback(() => {
    captchaQuery.refetch();
    setCaptchaAnswer("");
  }, [captchaQuery]);

  // 登录 mutation
  const loginMutation = trpc.auth.login.useMutation({
    onSuccess: () => {
      toast.success("登录成功");
      utils.auth.me.invalidate();
      window.location.href = "/";
    },
    onError: (error) => {
      const msg = error.message || "";
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
        if (showCaptcha) refreshCaptcha();
      }
    },
  });

  const telegramLoginMutation = trpc.telegram.login.useMutation({
    onSuccess: () => {
      toast.success("Telegram 登录成功");
      utils.auth.me.invalidate();
      window.location.href = "/";
    },
    onError: (error) => {
      toast.error(error.message || "Telegram 登录失败");
    },
  });

  const telegramWidgetLoginMutation = trpc.telegram.loginWithWidget.useMutation({
    onSuccess: () => {
      toast.success("Telegram 登录成功");
      utils.auth.me.invalidate();
      window.location.href = "/";
    },
    onError: (error) => {
      toast.error(error.message || "Telegram 登录失败");
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
      toast.error(error.message || "注册失败");
      refreshCaptcha();
    },
  });

  const sendEmailCodeMutation = trpc.auth.sendEmailCode.useMutation({
    onSuccess: () => toast.success("验证码已发送，5 分钟内有效"),
    onError: (error) => toast.error(error.message || "发送验证码失败"),
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
    telegramLoginMutation.mutate({ code });
  }, [location, telegramLoginCode, telegramLoginMutation]);

  const telegramBotUsername = telegramLoginStatus?.botUsername?.replace(/^@/, "").trim();
  const showTelegramLogin = mode === "login" && !!telegramLoginStatus?.enabled && !!telegramLoginStatus?.configured;
  const telegramDomainStatus = getTelegramLoginDomainStatus();
  const canRenderTelegramWidget = showTelegramLogin && !!telegramBotUsername && telegramDomainStatus.valid;

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

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
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
      });
    } else {
      loginMutation.mutate({ username: username.trim(), password });
    }
  };

  const handleRegister = (e: React.FormEvent) => {
    e.preventDefault();
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

  const isPending = loginMutation.isPending || registerMutation.isPending;
  const isTelegramPending = telegramLoginMutation.isPending || telegramWidgetLoginMutation.isPending;

  return (
    <div className="flex items-center justify-center min-h-screen bg-background relative px-3 sm:px-4">
      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        className="absolute top-4 right-4 h-9 w-9 flex items-center justify-center hover:bg-accent rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Toggle theme"
        title={resolvedTheme === "dark" ? "切换到白天模式" : "切换到黑夜模式"}
      >
        {resolvedTheme === "dark" ? (
          <Sun className="h-5 w-5 text-muted-foreground" />
        ) : (
          <Moon className="h-5 w-5 text-muted-foreground" />
        )}
      </button>

      <Card className="w-full max-w-md shadow-xl border-border/50">
        <CardHeader className="text-center pb-2">
          <div className="flex items-center justify-center gap-3 mb-4">
            <img
              src={resolvedTheme === "dark" ? "/logo-dark.png" : "/logo-light.png"}
              alt="ForwardX"
              className="h-12 w-12 object-contain"
            />
          </div>
          <CardTitle className="text-xl sm:text-2xl font-bold tracking-tight">ForwardX</CardTitle>
          <CardDescription className="text-muted-foreground">
            {isTelegramPending ? "正在通过 Telegram 登录" : mode === "login" ? "端口转发集中管理面板" : "注册新账号"}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          {isTelegramPending ? (
            <div className="flex flex-col items-center justify-center gap-3 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <span>正在验证一次性登录码...</span>
            </div>
          ) : mode === "login" ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="username">用户名</Label>
                <Input
                  id="username"
                  type="text"
                  placeholder="请输入用户名"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  autoFocus
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
                      使用 Telegram 快捷登录
                    </div>
                    {canRenderTelegramWidget ? (
                      <div
                        ref={telegramWidgetRef}
                        className={`flex min-h-11 justify-center ${telegramWidgetLoginMutation.isPending ? "pointer-events-none opacity-60" : ""}`}
                      />
                    ) : !telegramDomainStatus.valid ? (
                      <p className="text-center text-xs leading-5 text-muted-foreground">
                        {telegramDomainStatus.message}
                      </p>
                    ) : (
                      <p className="text-center text-xs text-muted-foreground">Telegram 机器人用户名同步后即可使用。</p>
                    )}
                    <p className="mt-2 text-center text-xs text-muted-foreground">
                      仅已绑定 Telegram 的账户可登录。
                    </p>
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
                  disabled={isPending}
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
                      disabled={!email.trim() || sendEmailCodeMutation.isPending}
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
                  disabled={isPending}
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
    </div>
  );
}
