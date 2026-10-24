export type RuleBatchManageMode = "operate" | "copy" | "edit" | "export" | "import" | "groups";
export type RuleBatchCategory = "manage" | "transfer";
export type RuleBatchAccess = { hasRules: boolean; canAdd: boolean; isOwnRuleScope: boolean };
export type RuleBatchStage = "selectRules" | "importSource" | "configureTarget" | "editRules" | "confirm" | "operate" | "export" | "groups";

export function ruleBatchCategory(mode: RuleBatchManageMode): RuleBatchCategory {
  return mode === "import" || mode === "export" ? "transfer" : "manage";
}

export function ruleBatchModes(category: RuleBatchCategory, isOwnRuleScope: boolean): RuleBatchManageMode[] {
  if (category === "transfer") return ["import", "export"];
  return isOwnRuleScope ? ["operate", "copy", "edit", "groups"] : ["operate", "copy", "edit"];
}

export function ruleBatchModeAvailable(mode: RuleBatchManageMode, access: RuleBatchAccess): boolean {
  if (mode === "import") return access.canAdd;
  if (mode === "groups") return access.isOwnRuleScope;
  return access.hasRules;
}

export function ruleBatchStages(mode: RuleBatchManageMode): readonly RuleBatchStage[] {
  switch (mode) {
    case "copy": return ["selectRules", "configureTarget", "confirm"];
    case "edit": return ["selectRules", "editRules"];
    case "import": return ["importSource", "configureTarget", "confirm"];
    default: return [mode];
  }
}

export function ruleBatchCanAdvance(mode: RuleBatchManageMode, step: number, state: {
  busy: boolean; selectedRules: number; selectedTargets: number; importSourceReady: boolean; importTargetReady: boolean;
}) {
  if (state.busy || step < 1 || step >= ruleBatchStages(mode).length) return false;
  if (mode === "import") return step === 1 ? state.importSourceReady : state.importSourceReady && state.importTargetReady;
  return state.selectedRules > 0 && (step === 1 || state.selectedTargets > 0);
}
