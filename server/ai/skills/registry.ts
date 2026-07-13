export type AiSkillToolMode = "read" | "write";

export type AiSkillTool = {
  name: string;
  mode: AiSkillToolMode;
  description: string;
  permission: "authenticated" | "self" | "admin";
  requiresConfirmation?: boolean;
  inputFields: readonly string[];
};

export type AiSkillDefinition = {
  id: string;
  version: string;
  name: string;
  description: string;
  instructions: readonly string[];
  tools: readonly AiSkillTool[];
};

export class AiSkillRegistry {
  private readonly skills = new Map<string, AiSkillDefinition>();

  register(skill: AiSkillDefinition) {
    const id = String(skill.id || "").trim();
    if (!id) throw new Error("AI Skill id is required");
    if (this.skills.has(id)) throw new Error(`AI Skill already registered: ${id}`);
    this.skills.set(id, Object.freeze({ ...skill, id }));
    return skill;
  }

  get(id: string) {
    return this.skills.get(String(id || "").trim());
  }

  list() {
    return Array.from(this.skills.values());
  }
}

export const aiSkillRegistry = new AiSkillRegistry();
