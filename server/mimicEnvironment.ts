export type MimicEnvironmentHost = {
  id?: number;
  name?: string | null;
  ip?: string | null;
  isOnline?: boolean | null;
  mimicAvailable?: boolean | null;
  mimicStatus?: string | null;
  mimicMessage?: string | null;
};

function hostLabel(host: MimicEnvironmentHost) {
  return String(host.name || host.ip || (host.id ? `主机 ${host.id}` : "未知主机")).trim();
}

export function mimicEnvironmentProblem(host: MimicEnvironmentHost) {
  const label = hostLabel(host);
  if (!host.isOnline) {
    return `${label} 当前离线，无法检测 Mimic 环境；请等待 Agent 在线后重试。`;
  }
  if (host.mimicAvailable === true) return null;
  const status = String(host.mimicStatus || "").trim();
  if (!status) {
    return `${label} 尚未上报 Mimic 环境检测结果；请先升级 Agent 并等待一次心跳后重试。`;
  }
  const reason = (() => {
    switch (status) {
      case "unsupported-os":
        return "当前系统不支持 Mimic";
      case "command-missing":
        return "未检测到 mimic 命令";
      case "command-unusable":
        return "mimic 命令无法正常运行";
      case "kernel-module-missing":
        return "未检测到可用的 mimic 内核模块";
      case "kernel-module-load-failed":
        return "mimic 内核模块加载失败";
      case "module-check-unavailable":
        return "无法检测 mimic 内核模块";
      default:
        return "Mimic 环境不可用";
    }
  })();
  const detail = String(host.mimicMessage || "").trim();
  return `${label}：${reason}${detail ? `（${detail}）` : ""}。请手动安装或修复 mimic/mimic-dkms 后重试。`;
}

export function assertMimicEnvironment(hosts: MimicEnvironmentHost[]) {
  const problems = hosts.map(mimicEnvironmentProblem).filter((value): value is string => !!value);
  if (problems.length === 0) return;
  throw new Error(`无法启用 mimic UDP 混淆：${problems.slice(0, 5).join("；")}`);
}
