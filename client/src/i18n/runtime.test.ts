import assert from "node:assert/strict";
import { test } from "node:test";
import { getLanguage, getLanguagePreference, getFormatLocale, initializeLanguage, LANGUAGE_STORAGE_KEY, setLanguagePreference, t } from "./index";
import { translateErrorNotificationText, translateNotificationText } from "./messages";
import { PAYMENT_ERRORS } from "../../../shared/paymentErrors";
import { toast } from "../lib/localizedToast";

test("language initialization, persistence and network/storage failures are safe", async () => {
  const original = new Map<string, PropertyDescriptor | undefined>();
  const values = new Map<string, string>();
  const sessionValues = new Map<string, string>();
  const storage = (map: Map<string, string>) => ({ getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } });
  const mock = (name: string, value: unknown) => {
    if (!original.has(name)) original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  let requests = 0;
  const root = { lang: "" };
  try {
    mock("window", {});
    mock("navigator", { languages: ["en-US"] });
    mock("document", { documentElement: root });
    mock("localStorage", storage(values));
    mock("sessionStorage", storage(sessionValues));
    mock("fetch", async () => { requests++; return { ok: true, json: async () => ({ country: "CN" }) }; });
    assert.equal(setLanguagePreference("auto"), true);
    await initializeLanguage();
    assert.equal(requests, 1, "automatic mode checks installation language even with a supported browser language");
    assert.equal(getLanguage(), "en");
    assert.equal(getFormatLocale(), "en-US");
    assert.equal(root.lang, "en");
    assert.equal(t("转发规则"), "Forwarding Rules");
    assert.equal(t("Custom host <&>"), "Custom host <&>");
    assert.equal(t("__proto__"), "__proto__");
    assert.equal(t("constructor"), "constructor");
    assert.equal(translateNotificationText("User not found"), "User not found");
    assert.equal(translateNotificationText("用户不存在"), "User not found");
    assert.equal(translateNotificationText("所选用户不存在"), "The selected user does not exist");
    assert.equal(translateNotificationText("Agent stderr: User not found"), "Agent stderr: User not found");
    assert.equal(translateNotificationText("__proto__"), "__proto__");
    for (const message of Object.values(PAYMENT_ERRORS)) {
      assert.equal(/\p{Script=Han}/u.test(translateErrorNotificationText(message)), false, message);
      assert.notEqual(translateErrorNotificationText(message), message);
    }
    assert.equal(translateErrorNotificationText("error:1E08010C:DECODER routines::unsupported"), t("密钥或证书无法解析，请检查格式或联系管理员查看日志。"));
    assert.equal(translateNotificationText("最低支付金额为 1.25"), "The minimum payment amount is 1.25");
    assert.equal(translateNotificationText("最高支付金额为 100"), "The maximum payment amount is 100");
    assert.equal(translateNotificationText("cancelled subscriptions cannot be renewed"), "Cancelled subscriptions cannot be renewed");
    assert.equal(translateErrorNotificationText("Failed to fetch"), "The network request failed. Check your connection and try again.");
    assert.equal(translateErrorNotificationText("Unknown error"), "The operation failed. Try again later or ask the administrator to check the logs.");
    assert.equal(translateErrorNotificationText("Agent stderr: error:1E08010C:DECODER routines::unsupported"), "Agent stderr: error:1E08010C:DECODER routines::unsupported");
    const errorToastId = toast.error("error:1E08010C:DECODER routines::unsupported", { description: "Failed to fetch" });
    const errorToast = toast.getHistory().find(item => item.id === errorToastId);
    assert.ok(errorToast && "title" in errorToast);
    assert.equal(errorToast?.title, t("密钥或证书无法解析，请检查格式或联系管理员查看日志。"));
    assert.equal(errorToast?.description, "The network request failed. Check your connection and try again.");
    toast.dismiss(errorToastId);
    // English labels must never leak into serialized rule fields or state IDs.
    const { parseRuleTransferFile } = await import("../lib/ruleTransfer");
    const ruleInput = { kind: "forwardx.forward-rules", version: 1, scope: { type: "chain", id: 7, name: "用户链路" }, rules: [{ name: "用户规则", forwardType: "realm", protocol: "both", sourcePort: 65535, targetIp: "example.com", targetPort: 443, proxyProtocolSend: false }] };
    const englishRule = parseRuleTransferFile(ruleInput);
    const { resolveLinkAvailability } = await import("../lib/linkAvailability");
    const englishState = resolveLinkAvailability({ label: "用户链路", enabled: true, hostsLoaded: true, requiredNodes: [{ id: 17, available: true }] });
    assert.equal(englishState.status, "available");
    assert.equal(englishState.available, true);
    assert.deepEqual([...englishState.usableHostIds], [17]);
    assert.equal(setLanguagePreference("zh-CN"), true);
    await initializeLanguage();
    assert.equal(values.get(LANGUAGE_STORAGE_KEY), "zh-CN");
    assert.equal(t("转发规则"), "转发规则");
    assert.equal(getLanguagePreference(), "zh-CN");
    assert.equal(translateNotificationText("User not found"), "用户不存在");
    assert.equal(translateNotificationText("用户不存在"), "用户不存在");
    assert.equal(translateNotificationText("所选用户不存在"), "所选用户不存在");
    assert.equal(translateNotificationText("Agent stderr: User not found"), "Agent stderr: User not found");
    for (const message of Object.values(PAYMENT_ERRORS)) assert.equal(translateErrorNotificationText(message), message);
    assert.equal(translateErrorNotificationText("error:1E08010C:DECODER routines::unsupported"), "密钥或证书无法解析，请检查格式或联系管理员查看日志。");
    assert.equal(translateNotificationText("最低支付金额为 1.25"), "最低支付金额为 1.25");
    assert.equal(translateNotificationText("cancelled subscriptions cannot be renewed"), "已取消的订阅不能续费");
    assert.equal(translateErrorNotificationText("Failed to fetch"), "网络请求失败，请检查连接后重试。");
    assert.deepEqual(parseRuleTransferFile(ruleInput), englishRule);
    const chineseState = resolveLinkAvailability({ label: "用户链路", enabled: true, hostsLoaded: true, requiredNodes: [{ id: 17, available: true }] });
    assert.equal(chineseState.status, englishState.status);
    assert.notEqual(chineseState.message, englishState.message);
    assert.equal(setLanguagePreference("auto"), true);
    mock("navigator", { languages: ["fr-FR"] });
    await initializeLanguage("https://panel.example.com");
    assert.equal(requests, 2);
    assert.equal(getLanguage(), "zh-CN");
    mock("fetch", async () => { throw new Error("offline"); });
    await initializeLanguage();
    assert.equal(getLanguage(), "zh-CN");
    // Installation hint overrides the browser only before setup; it never saves
    // itself as a manual preference or wins over a user's explicit choice.
    mock("navigator", { languages: ["en-US"] });
    mock("fetch", async () => ({ ok: true, json: async () => ({ setupLanguage: "zh-CN", country: "US" }) }));
    await initializeLanguage();
    assert.equal(getLanguage(), "zh-CN");
    assert.equal(getLanguagePreference(), "auto");
    assert.equal(values.has(LANGUAGE_STORAGE_KEY), false);
    mock("navigator", { languages: ["zh-CN"] });
    mock("fetch", async () => ({ ok: true, json: async () => ({ setupLanguage: "en", country: "CN" }) }));
    await initializeLanguage();
    assert.equal(getLanguage(), "en");
    assert.equal(root.lang, "en");
    assert.equal(setLanguagePreference("zh-CN"), true);
    mock("fetch", async () => { throw new Error("manual selection must not need the server"); });
    await initializeLanguage();
    assert.equal(getLanguage(), "zh-CN");
    assert.equal(setLanguagePreference("auto"), true);
    for (const setupLanguage of [null, "auto", "fr", "<script>", { en: true }]) {
      mock("fetch", async () => ({ ok: true, json: async () => ({ setupLanguage, country: "US" }) }));
      await initializeLanguage();
      assert.equal(getLanguage(), "zh-CN", "finished setup or invalid hint follows browser language");
    }
    let releaseHint!: (value: unknown) => void;
    mock("fetch", () => new Promise(resolve => { releaseHint = resolve; }));
    const staleInitialization = initializeLanguage();
    assert.equal(setLanguagePreference("en"), true);
    await initializeLanguage();
    releaseHint({ ok: true, json: async () => ({ setupLanguage: "zh-CN" }) });
    await staleInitialization;
    assert.equal(getLanguage(), "en", "a delayed installation hint cannot revert a newer manual choice");
    // Deployed HTML supplies the same safe hints without waiting for a request.
    assert.equal(setLanguagePreference("auto"), true);
    mock("document", { documentElement: root, getElementById: () => ({ textContent: JSON.stringify({ country: "US", setupLanguage: "en" }) }) });
    mock("fetch", async () => { throw Error("inline hints must not fetch"); });
    await initializeLanguage();
    assert.equal(getLanguage(), "en");
    // A native/remote panel must not accidentally use the local document hint.
    mock("fetch", async () => ({ ok: true, json: async () => ({ setupLanguage: "zh-CN" }) }));
    await initializeLanguage("https://native-panel.example");
    assert.equal(getLanguage(), "zh-CN");
    const blocked = { getItem() { throw new Error("disabled"); }, setItem() { throw new Error("disabled"); }, removeItem() { throw new Error("disabled"); } };
    mock("localStorage", blocked);
    assert.equal(setLanguagePreference("en"), true);
    assert.equal(sessionValues.get(LANGUAGE_STORAGE_KEY), "en");
    await initializeLanguage();
    assert.equal(getLanguage(), "en");
    mock("sessionStorage", blocked);
    assert.equal(setLanguagePreference("zh-CN"), false);
  } finally {
    for (const [name, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
