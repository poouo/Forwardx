export type ManagePresetAction =
  | "balance_set"
  | "balance_adjust"
  | "renew"
  | "redeem_code_generate_balance"
  | "discount_code_generate_percent";

export type ManagePresetField = "amountYuan" | "duration" | "codeCount" | "discountPercent";

export type ManagePresetPatch = {
  amountYuan?: number;
  durationValue?: number;
  durationUnit?: "day" | "month" | "year";
  codeCount?: number;
  discountPercent?: number;
};

export type ManagePresetChoice = {
  label: string;
  value: string;
};

export type ManagePresetGroup = {
  field: ManagePresetField;
  prompt: string;
  customPrompt: string;
  choices: readonly ManagePresetChoice[];
};

export type ManagePresetContext = {
  action: string;
  sourceText?: string;
  missingFields: readonly string[];
};

const PRESET_ACTIONS = new Set<ManagePresetAction>([
  "balance_set",
  "balance_adjust",
  "renew",
  "redeem_code_generate_balance",
  "discount_code_generate_percent",
]);

const CREDIT_WORDS_RE = /(充值|充钱|加钱|增加|补款|上调)/;
const DEDUCT_WORDS_RE = /(扣除|扣减|减少|减去|下调)/;

function amountChoices(values: readonly number[]): ManagePresetChoice[] {
  return values.map((value) => ({
    label: `${value > 0 ? "+" : value < 0 ? "-" : ""}¥${Math.abs(value)}`,
    value: String(value),
  }));
}

function balanceAdjustGroup(sourceText: string): ManagePresetGroup {
  const creditLike = CREDIT_WORDS_RE.test(sourceText);
  const deductLike = DEDUCT_WORDS_RE.test(sourceText);
  if (deductLike && !creditLike) {
    return {
      field: "amountYuan",
      prompt: "请选择要扣减的金额，也可以输入自定义金额。",
      customPrompt: "请直接发送自定义扣减金额，例如“30”或“-30”。",
      choices: amountChoices([-10, -50, -100, -500]),
    };
  }
  if (creditLike && !deductLike) {
    return {
      field: "amountYuan",
      prompt: "请选择充值金额，也可以输入自定义金额。",
      customPrompt: "请直接发送自定义充值金额，例如“88”。",
      choices: amountChoices([10, 50, 100, 500]),
    };
  }
  return {
    field: "amountYuan",
    prompt: "请选择余额调整金额，正数为增加、负数为扣减，也可以输入自定义金额。",
    customPrompt: "请直接发送自定义调整金额，例如“88”或“-30”。",
    choices: amountChoices([50, 100, -50, -100]),
  };
}

export function getManagePresetGroup(context: ManagePresetContext): ManagePresetGroup | null {
  const action = PRESET_ACTIONS.has(context.action as ManagePresetAction)
    ? context.action as ManagePresetAction
    : null;
  if (!action) return null;
  const missing = new Set(context.missingFields);

  if (missing.has("amountYuan")) {
    if (action === "balance_adjust") return balanceAdjustGroup(String(context.sourceText || ""));
    if (action === "balance_set") {
      return {
        field: "amountYuan",
        prompt: "请选择设置后的余额，也可以输入自定义金额。",
        customPrompt: "请直接发送要设置的余额金额，例如“188”。",
        choices: amountChoices([0, 50, 100, 500]),
      };
    }
    if (action === "redeem_code_generate_balance") {
      return {
        field: "amountYuan",
        prompt: "请选择每个兑换码的面额，也可以输入自定义金额。",
        customPrompt: "请直接发送每个兑换码的自定义面额，例如“88”。",
        choices: amountChoices([10, 50, 100, 500]),
      };
    }
  }

  if (missing.has("discountPercent") && action === "discount_code_generate_percent") {
    return {
      field: "discountPercent",
      prompt: "请选择折扣力度，也可以输入自定义折扣。",
      customPrompt: "请直接发送自定义折扣，例如“8.8折”或“减12%”。",
      choices: [
        { label: "9.5 折", value: "5" },
        { label: "9 折", value: "10" },
        { label: "8.5 折", value: "15" },
        { label: "8 折", value: "20" },
      ],
    };
  }

  if (missing.has("duration") && action === "renew") {
    return {
      field: "duration",
      prompt: "请选择续期时长，也可以输入自定义时长。",
      customPrompt: "请直接发送自定义续期时长，例如“45天”、“6个月”或“2年”。",
      choices: [
        { label: "7 天", value: "7d" },
        { label: "1 个月", value: "1m" },
        { label: "3 个月", value: "3m" },
        { label: "1 年", value: "1y" },
      ],
    };
  }

  if (missing.has("codeCount") && (action === "redeem_code_generate_balance" || action === "discount_code_generate_percent")) {
    return {
      field: "codeCount",
      prompt: "请选择生成数量，也可以输入自定义数量。",
      customPrompt: "请直接发送自定义数量，例如“25个”。",
      choices: [1, 10, 50, 100].map((value) => ({ label: `${value} 个`, value: String(value) })),
    };
  }

  return null;
}

export function parseManagePresetSelection(fieldValue: unknown, valueValue: unknown): ManagePresetPatch | null {
  const field = String(fieldValue || "") as ManagePresetField;
  const value = String(valueValue || "").trim();

  if (field === "amountYuan") {
    if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(value)) return null;
    const amountYuan = Number(value);
    if (!Number.isFinite(amountYuan) || Math.abs(amountYuan) > 1_000_000) return null;
    return { amountYuan };
  }

  if (field === "duration") {
    const match = value.match(/^(\d+)([dmy])$/);
    if (!match) return null;
    const durationValue = Number(match[1]);
    if (!Number.isInteger(durationValue) || durationValue <= 0 || durationValue > 10_000) return null;
    const durationUnit = match[2] === "d" ? "day" : match[2] === "y" ? "year" : "month";
    return { durationValue, durationUnit };
  }

  if (field === "codeCount") {
    if (!/^\d+$/.test(value)) return null;
    const codeCount = Number(value);
    if (!Number.isInteger(codeCount) || codeCount <= 0 || codeCount > 500) return null;
    return { codeCount };
  }

  if (field === "discountPercent") {
    if (!/^\d+$/.test(value)) return null;
    const discountPercent = Number(value);
    if (!Number.isInteger(discountPercent) || discountPercent <= 0 || discountPercent > 100) return null;
    return { discountPercent };
  }

  return null;
}

export function normalizeManagePresetCustomPatch<T extends ManagePresetPatch>(
  context: ManagePresetContext,
  patch: T,
): T {
  if (context.action !== "balance_adjust" || !context.missingFields.includes("amountYuan")) return patch;
  const amountYuan = Number(patch.amountYuan);
  if (!Number.isFinite(amountYuan)) return patch;
  const sourceText = String(context.sourceText || "");
  const creditLike = CREDIT_WORDS_RE.test(sourceText);
  const deductLike = DEDUCT_WORDS_RE.test(sourceText);
  if (deductLike && !creditLike) return { ...patch, amountYuan: -Math.abs(amountYuan) } as T;
  if (creditLike && !deductLike) return { ...patch, amountYuan: Math.abs(amountYuan) } as T;
  return patch;
}
