import { t } from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MAX_PRODUCT_STOCK, productStock, productStockText } from "@shared/productStock";
import { useId } from "react";

export function ProductStockBadge({ product }: { product: { stockLimit?: number; stockUsed?: number } }) {
  return <Badge variant={productStock(product).soldOut ? "destructive" : "outline"} className="whitespace-nowrap"
    title={t("已占用 {0} / 总量 {1}", [product.stockUsed || 0, Number(product.stockLimit) || "∞"])}>
    {t("库存")}：{productStockText(product)}
  </Badge>;
}

export function ProductStockField({ value, onChange, metered = false }: { value: string; onChange: (value: string) => void; metered?: boolean }) {
  const id = useId();
  const hint = metered ? t("0 为不限；每名用户占 1 份，删除该用户全部逻辑规则后释放。") : t("0 为不限；新购及待支付订单占库存，续费不占，关闭未支付订单后释放。补货请增加总量。");
  return <div className="space-y-2" title={hint}>
    <Label htmlFor={id}>{t("库存总量")}</Label>
    <Input id={id} type="number" min={0} max={MAX_PRODUCT_STOCK} step={1} value={value} onChange={(event) => onChange(event.target.value)} aria-description={hint} placeholder={t("0 为不限")} />
  </div>;
}

export function MeteredRuleLimitBadge({ config }: { config: { maxRulesPerUser?: number; currentUserRuleCount?: number } }) {
  const limit = Number(config.maxRulesPerUser) || 0;
  return <Badge variant="outline" className="whitespace-nowrap">{t("每用户规则")}：{config.currentUserRuleCount !== undefined ? `${config.currentUserRuleCount} / ` : ""}{limit || "∞"}</Badge>;
}
