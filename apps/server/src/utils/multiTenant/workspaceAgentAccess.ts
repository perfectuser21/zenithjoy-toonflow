import type { AuthIdentity } from "@toonflow/multi-tenant-auth";

export function canManageWorkspaceSkills(user: AuthIdentity | null | undefined) {
  return user?.role === "user" && process.env.TOONFLOW_WORKSPACE_AGENT_USER_IDS?.split(",").some(id => id.trim() === user.id) === true;
}

export function canUseWorkspaceAgent(user: AuthIdentity | null) {
  return user?.role === "admin" || canManageWorkspaceSkills(user)
    || (user?.role === "user" && process.env.TOONFLOW_TRUSTED_CANVAS_BETA === "1");
}
