import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Router } from "express";
import { z } from "zod";
import { createSkillContext, isWorkspaceSkillName } from "@/agent/skills";
import { validateFields } from "@/lib/middleware";
import { error, success } from "@/lib/responseFormat";
import u from "@/utils";
import { canManageWorkspaceSkills } from "@/utils/multiTenant/runtime";

export default Router().post("/", validateFields({
  directory: z.string().min(1).max(4096),
  content: z.string().min(1).max(128 * 1024),
}), async (req, res) => {
  if (!canManageWorkspaceSkills(u.multiTenant.requestIdentity(req))) {
    return res.status(403).json(error("当前账号尚未开放项目 Skill 管理", null, 403));
  }
  const { directory, content } = req.body;
  const cwd = await u.workspace.resolveWorkspace(req, directory);
  const { frontmatter } = parseFrontmatter(content);
  const { name, description } = frontmatter;
  if (typeof name !== "string" || !isWorkspaceSkillName(name) || typeof description !== "string" || !description.trim()) {
    return res.status(400).json(error("SKILL.md 需要有效的 name 和非空 description", null, 400));
  }
  const skill = await createSkillContext(cwd).create({ scope: "workspace", name, content });
  res.set("Cache-Control", "no-store").status(201).json(success(skill));
});
