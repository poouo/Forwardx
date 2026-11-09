import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { takePasswordRecoveryToken } from "../lib/passwordRecovery";
import { PASSWORD_RECOVERY_REQUEST_MESSAGE } from "../../../shared/passwordRecovery";

test("reset token is removed from browser history and never sent as a query parameter", () => {
  const changes: unknown[][] = [];
  const history = { state: { previous: true }, replaceState: (...args: unknown[]) => { changes.push(args); } };
  const location = { pathname: "/login", search: "?lang=en", hash: "#password-reset=abc.def%2Bghi&tab=login" };
  assert.equal(takePasswordRecoveryToken(location, history), "abc.def+ghi");
  assert.deepEqual(changes, [[history.state, "", "/login?lang=en#tab=login"]]);
  assert.equal(takePasswordRecoveryToken({ ...location, hash: "#tab=login" }, history), null);
  assert.equal(changes.length, 1);
  assert.equal(takePasswordRecoveryToken({ ...location, hash: "#password-reset=" + "x".repeat(2049) }, history), "");
  assert.equal(changes.length, 2);
  assert.equal(changes[1][2], "/login?lang=en");
});

test("login exposes recovery and clears the locally remembered old password after reset", () => {
  const login = readFileSync("client/src/pages/Login.tsx", "utf8");
  assert.match(login, /<PasswordRecoveryDialog/);
  assert.match(login, /忘记密码？/);
  assert.match(login, /setPasswordRecoveryOpen\(true\)/);
  assert.match(login, /onPasswordReset=\{[^\n]*mobileAuth\.setCredentials\(username, ""\); mobileAuth\.clear\(\)/);
});

test("recovery reuses project controls and consumes credentials only after explicit password submission", () => {
  const component = readFileSync("client/src/components/PasswordRecoveryDialog.tsx", "utf8");
  assert.match(component, /DialogContent/);
  assert.match(component, /passwordRecoveryOptions\.useQuery/);
  assert.match(component, /requestPasswordRecovery\.useMutation/);
  assert.match(component, /resetPasswordWithToken\.useMutation/);
  assert.match(component, /reset\.mutate\(\{ token, newPassword \}\)/);
  assert.match(component, /newPassword !== confirmation/);
  assert.equal((component.match(/autoComplete="new-password"/g) || []).length, 2);
  assert.match(component, /未配置可用的找回通道或公开访问地址，请联系管理员/);
  assert.match(component, /takePasswordRecoveryToken/);
  assert.doesNotMatch(component, /localStorage|sessionStorage|<select|fetch\(/);
  const effect = component.slice(component.indexOf("const receive ="), component.indexOf("receive();"));
  assert.doesNotMatch(effect, /mutate/);
});

test("recovery messages have English translations without disclosing account existence", () => {
  const en = JSON.parse(readFileSync("client/src/i18n/en.json", "utf8"));
  const component = readFileSync("client/src/components/PasswordRecoveryDialog.tsx", "utf8");
  const keys = [...component.matchAll(/"([^"\n]*[\u4e00-\u9fff][^"\n]*)"/g)].map(match => match[1]);
  keys.push(PASSWORD_RECOVERY_REQUEST_MESSAGE);
  for (const key of keys) {
    assert.equal(typeof en[key], "string", `missing translation: ${key}`);
    assert.doesNotMatch(en[key], /\p{Script=Han}/u);
  }
});
