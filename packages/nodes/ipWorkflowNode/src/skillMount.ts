import type { Skill } from "./workflow";

export function activeMountedSkill(versions: readonly Skill[] = [], version: string | undefined) {
  return versions.find(entry => entry.version === version);
}

export function appendSkillVersion(versions: readonly Skill[], name: string, body: string, version: string, source = "画布 Skill") {
  const rule = body.trim();
  if (!rule || rule.length > 16000) throw new Error("Skill 需要包含正文且不能超过 16,000 字");
  return [...versions, { name: name.trim() || "公众号长文 Skill", body: rule, version, source }];
}
