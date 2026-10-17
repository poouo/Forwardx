import { useState } from "react";
import { Eye } from "lucide-react";
import { t } from "@/i18n";
import { PLAN_DESCRIPTION_MAX_LENGTH } from "@shared/planDescription";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PlanDetails } from "@/components/PlanDetails";

export function PlanDescriptionEditor({ value, onChange }: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor="plan-description">{t("说明")}</Label>
        <Button type="button" variant="ghost" size="sm" className="h-7 gap-1.5 px-2" aria-expanded={preview} aria-controls="plan-description-preview" onClick={() => setPreview(!preview)}>
          <Eye className="h-3.5 w-3.5" />{t(preview ? "收起预览" : "预览")}
        </Button>
      </div>
      <Textarea id="plan-description" className="min-h-48 font-mono text-xs leading-6" value={value} maxLength={PLAN_DESCRIPTION_MAX_LENGTH} onChange={(e) => onChange(e.target.value)} aria-describedby="plan-description-help" placeholder={t("展示给用户看的套餐说明")} />
      <div className="flex flex-wrap items-start justify-between gap-2 text-xs text-muted-foreground">
        <p id="plan-description-help" className="min-w-0 flex-1 basis-64">
          {t("支持 Markdown 和 H5/HTML 排版，脚本和危险内容会被过滤。留空展示默认套餐信息，说明不改变实际权益和价格。")}
        </p>
        <span className="shrink-0 tabular-nums">{value.length} / {PLAN_DESCRIPTION_MAX_LENGTH}</span>
      </div>
      {preview && <div id="plan-description-preview" className="min-w-0 rounded-lg border bg-background/50 p-4">
        <PlanDetails description={value}><p className="text-sm text-muted-foreground">{t("说明为空，将展示系统生成的套餐权益。")}</p></PlanDetails>
      </div>}
    </div>
  );
}
