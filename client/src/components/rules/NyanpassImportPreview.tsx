import { t } from "@/i18n";
import { formatForwardRuleProtocol } from "@shared/forwardTypes";
import type { RuleTransferFileRule } from "@/lib/ruleTransfer";

export function NyanpassImportPreview({rules}: {rules:RuleTransferFileRule[]}) {
  if (!rules.length) return null;
  return <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border border-border/60 p-2 text-xs">
    {rules.map((rule,index)=><div key={index} className="space-y-1 rounded-md bg-muted/25 p-2">
      <p className="break-words font-medium">{rule.name} · {formatForwardRuleProtocol(rule.protocol)} · {t("导入后停用")}</p>
      <p>{t("入口端口")} {rule.sourcePort || t("随机端口")}</p>
      {[{targetIp:rule.targetIp,targetPort:rule.targetPort},...rule.failoverTargets].map((target,i)=><p key={i} className="break-all text-muted-foreground">→ {target.targetIp.includes(":")?`[${target.targetIp}]`:target.targetIp}:{target.targetPort}</p>)}
      {rule.failoverEnabled && <p>{t("出站策略")} · {rule.failoverStrategy}</p>}
      {(rule.proxyProtocolReceive || rule.proxyProtocolSend) && <p>PROXY · {t("接收")} {rule.proxyProtocolReceive?"ON":"OFF"} · {t("发送")} {rule.proxyProtocolSend?`v${rule.proxyProtocolVersion}`:"OFF"}</p>}
      {!!rule.rateLimitMbps && <p>{t("限速")} · {rule.rateLimitMbps} Mbps</p>}
    </div>)}
  </div>;
}
