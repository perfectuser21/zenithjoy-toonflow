import { Router } from "express";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { assertAppRequest } from "@/utils/mcp/control";
import { requestIdentity } from "@/utils/multiTenant/runtime";
import {
  addQianchuanAuthorization,
  createInvitation,
  createOrganization,
  createTeam,
  joinOrganization,
  organizationSnapshot,
  replaceQianchuanAccessToken,
  revokeMembership,
  revokeQianchuanAuthorization,
} from "@/utils/multiTenant/qianchuanOrganizations";

const organizationId = z.uuid();
const teamId = z.uuid();
const name = z.string().trim().min(1).max(100);
const request = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("snapshot") }),
  z.strictObject({ action: z.literal("createOrganization"), name }),
  z.strictObject({ action: z.literal("createTeam"), organizationId, name }),
  z.strictObject({ action: z.literal("createInvitation"), organizationId, teamId }),
  z.strictObject({ action: z.literal("joinOrganization"), code: z.string().trim().min(1).max(128) }),
  z.strictObject({ action: z.literal("revokeMembership"), organizationId, memberId: z.uuid(), teamId }),
  z.strictObject({
    action: z.literal("addAuthorization"),
    organizationId,
    name,
    accessToken: z.string().trim().min(1).max(4096),
    accounts: z
      .array(z.strictObject({ name, advertiserId: z.string().regex(/^\d{1,20}$/), teamId: teamId.nullable() }))
      .min(1)
      .max(50),
  }),
  z.strictObject({
    action: z.literal("replaceAuthorization"),
    organizationId,
    authorizationId: z.uuid(),
    accessToken: z.string().trim().min(1).max(4096),
  }),
  z.strictObject({ action: z.literal("revokeAuthorization"), organizationId, authorizationId: z.uuid() }),
]);

export default Router().post("/", async (req, res) => {
  assertAppRequest(req);
  const actor = requestIdentity(req);
  if (actor?.role !== "user") throw Object.assign(new Error("请使用 Toonflow 创作账号登录"), { status: 401 });
  const input = request.safeParse(req.body);
  if (!input.success) throw Object.assign(new Error("组织或千川配置参数无效"), { status: 400 });
  const data = input.data;
  res.set("Cache-Control", "no-store");
  switch (data.action) {
    case "createOrganization":
      await createOrganization(actor.id, data.name);
      break;
    case "createTeam":
      await createTeam(actor.id, data.organizationId, data.name);
      break;
    case "createInvitation": {
      const invitation = await createInvitation(actor.id, data.organizationId, data.teamId);
      return res.json(success(invitation));
    }
    case "joinOrganization":
      await joinOrganization(actor.id, data.code);
      break;
    case "revokeMembership":
      await revokeMembership(actor.id, data.organizationId, data.memberId, data.teamId);
      break;
    case "addAuthorization":
      await addQianchuanAuthorization(actor.id, data.organizationId, {
        name: data.name,
        accessToken: data.accessToken,
        accounts: data.accounts,
      });
      break;
    case "replaceAuthorization":
      await replaceQianchuanAccessToken(actor.id, data.organizationId, data.authorizationId, data.accessToken);
      break;
    case "revokeAuthorization":
      await revokeQianchuanAuthorization(actor.id, data.organizationId, data.authorizationId);
      break;
  }
  return res.json(success(await organizationSnapshot(actor.id)));
});
