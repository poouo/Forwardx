/** Operations history uses Beijing calendar days, independently of server TZ. */
export const OPERATIONS_DAY_SECONDS = 86400;
export const OPERATIONS_OFFSET_SECONDS = 8 * 3600;
export const OPERATIONS_SOURCE_PAGE_SIZE = 10;
export const OPERATIONS_SOURCE_SORTS = ["traffic", "rules", "recent"] as const;
export type OperationsSourceSort = typeof OPERATIONS_SOURCE_SORTS[number];
export function operationsDay(seconds: number) {
  return Math.floor((seconds + OPERATIONS_OFFSET_SECONDS) / OPERATIONS_DAY_SECONDS) * OPERATIONS_DAY_SECONDS - OPERATIONS_OFFSET_SECONDS;
}
export function operationsDate(seconds = Date.now() / 1000) {
  return new Date((seconds + OPERATIONS_OFFSET_SECONDS) * 1000).toISOString().slice(0, 10);
}
export function operationsRange(from: string, to: string, now = Date.now() / 1000) {
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid date");
    const seconds = Date.parse(`${value}T00:00:00+08:00`) / 1000;
    if (!Number.isFinite(seconds) || operationsDate(seconds) !== value) throw new Error("Invalid date");
    return seconds;
  };
  const start = parse(from), end = parse(to) + OPERATIONS_DAY_SECONDS;
  if (end <= start || end - start > 30 * OPERATIONS_DAY_SECONDS || start < operationsDay(now) - 29 * OPERATIONS_DAY_SECONDS || end > operationsDay(now) + OPERATIONS_DAY_SECONDS) throw new Error("Select dates within the last 30 days");
  return { start, end };
}

const provinces: Record<string, string[]> = {
  北京: ["beijing"], 天津: ["tianjin"], 河北: ["hebei"], 山西: ["shanxi"], 内蒙古: ["inner mongolia", "nei mongol"],
  辽宁: ["liaoning"], 吉林: ["jilin"], 黑龙江: ["heilongjiang"], 上海: ["shanghai"], 江苏: ["jiangsu"], 浙江: ["zhejiang"],
  安徽: ["anhui"], 福建: ["fujian"], 江西: ["jiangxi"], 山东: ["shandong"], 河南: ["henan"], 湖北: ["hubei"], 湖南: ["hunan"],
  广东: ["guangdong"], 广西: ["guangxi"], 海南: ["hainan"], 重庆: ["chongqing"], 四川: ["sichuan"], 贵州: ["guizhou"],
  云南: ["yunnan"], 西藏: ["tibet", "xizang"], 陕西: ["shaanxi"], 甘肃: ["gansu"], 青海: ["qinghai"], 宁夏: ["ningxia"],
  新疆: ["xinjiang"], 香港: ["hong kong"], 澳门: ["macao", "macau"], 台湾: ["taiwan"],
};
export const CHINA_PROVINCES = Object.keys(provinces);
export function provinceAliases(name: string) { return provinces[name] ? [name, ...provinces[name]] : []; }
export function chinaProvince(country: string, region: string) {
  const code = String(country || "").toUpperCase();
  if (code === "HK") return "香港";
  if (code === "MO") return "澳门";
  if (code === "TW") return "台湾";
  if (code !== "CN") return null;
  const normalized = String(region || "").trim().toLowerCase();
  for (const [name, aliases] of Object.entries(provinces)) {
    if (normalized.startsWith(name) || aliases.some(alias => normalized === alias || normalized.startsWith(`${alias} `))) return name;
  }
  return null;
}
