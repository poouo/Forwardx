import { toast as originalToast } from "sonner";
import { translateNotificationText } from "../i18n/messages";

function translateArgs(args: unknown[]) {
  const [message, options, ...rest] = args;
  const translatedOptions = options && typeof options === "object" && "description" in options && typeof options.description === "string"
    ? { ...options, description: translateNotificationText(options.description) }
    : options;
  return [typeof message === "string" ? translateNotificationText(message) : message, translatedOptions, ...rest];
}

// Only presentation methods are translated. dismiss IDs, promise results,
// custom React content and unknown Agent/plugin diagnostics stay untouched.
const methods = new Set(["success", "error", "info", "warning", "loading", "message"]);
export const toast: typeof originalToast = new Proxy(originalToast, {
  apply(target, thisArg, args) { return Reflect.apply(target, thisArg, translateArgs(args)); },
  get(target, property, receiver) {
    const member = Reflect.get(target, property, receiver);
    return methods.has(String(property)) && typeof member === "function"
      ? (...args: unknown[]) => Reflect.apply(member, target, translateArgs(args))
      : member;
  },
});
