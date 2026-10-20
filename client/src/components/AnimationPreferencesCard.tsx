import { useId } from "react";
import { Sparkles } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { t } from "@/i18n";
import { areAnimationsEnabled } from "@/lib/motionPreference";
import { toast } from "@/lib/localizedToast";
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Label } from "./ui/label";
import { HintSwitch } from "./ui/hint-switch";

export function AnimationPreferenceControl({ checked, disabled, onChange }: {
  checked: boolean;
  disabled?: boolean;
  onChange: (enabled: boolean) => void;
}) {
  const id = useId();
  return <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-muted/15 p-3">
    <Label htmlFor={id} className="min-w-0 text-sm font-medium">{t("界面动画")}</Label>
    <HintSwitch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange}
      hint={t("关闭切换、悬浮和图表动画，降低设备负担。仅影响当前账号。")} />
  </div>;
}

export default function AnimationPreferencesCard() {
  const { user, loading } = useAuth();
  const utils = trpc.useUtils();
  const update = trpc.auth.updateProfile.useMutation({
    onMutate: async (input) => {
      await utils.auth.me.cancel();
      const previous = utils.auth.me.getData();
      if (previous) utils.auth.me.setData(undefined, { ...previous, animationsEnabled: input.animationsEnabled });
      return { previous };
    },
    onError: (error, _input, context) => {
      if (context?.previous?.id === utils.auth.me.getData()?.id) utils.auth.me.setData(undefined, context?.previous);
      toast.error(error.message);
    },
    onSettled: () => utils.auth.me.invalidate(),
  });
  return <Card className="border-border/50 bg-card/70">
    <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Sparkles className="h-4 w-4 text-primary" />{t("界面偏好")}</CardTitle></CardHeader>
    <CardContent><AnimationPreferenceControl checked={areAnimationsEnabled(user)} disabled={loading || !user || update.isPending}
      onChange={animationsEnabled => update.mutate({ animationsEnabled })} /></CardContent>
  </Card>;
}
