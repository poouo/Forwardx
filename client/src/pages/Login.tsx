import { useState, useCallback, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Network, Eye, EyeOff, Loader2, Sun, Moon, RefreshCw, UserPlus, LogIn } from "lucide-react";
import { toast } from "sonner";
import { useTheme } from "@/contexts/ThemeContext";

type Mode = "login" | "register";

export default function Login() {
  const [mode, setMode] = useState<Mode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [showCaptcha, setShowCaptcha] = useState(false);
  const { resolvedTheme, setTheme } = useTheme();

  const utils = trpc.useUtils();

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

  // 切换到注册模式时自动显示验证码
  useEffect(() => {
    if (mode === "register") {
      setShowCaptcha(true);
    }
  }, [mode]);

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
      captchaId: captchaQuery.data.captchaId,
      captchaAnswer: parseInt(captchaAnswer.trim(), 10),
    });
  };

  const toggleTheme = () => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  };

  const isPending = loginMutation.isPending || registerMutation.isPending;

  return (
    <div className="flex items-center justify-center min-h-screen bg-background relative">
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

      <Card className="w-full max-w-md mx-4 shadow-xl border-border/50">
        <CardHeader className="text-center pb-2">
          <div className="flex items-center justify-center gap-3 mb-4">
            <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
              <Network className="h-6 w-6 text-primary" />
            </div>
          </div>
          <CardTitle className="text-2xl font-bold tracking-tight">ForwardX</CardTitle>
          <CardDescription className="text-muted-foreground">
            {mode === "login" ? "端口转发集中管理面板" : "注册新账号"}
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-4">
          {mode === "login" ? (
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

              <div className="text-center">
                <button
                  type="button"
                  onClick={() => { setMode("register"); setCaptchaAnswer(""); }}
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
                  placeholder="至少2个字符"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
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
