import { createHash, randomBytes, randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { openDatabase } from "@toonflow/multi-tenant-db";
import type { AdminDatabase } from "@toonflow/multi-tenant-db";
import { createModelSecret } from "@toonflow/multi-tenant-models";
import type { Request } from "express";
import { z } from "zod";
import conf from "@/utils/conf";
import { assertAppRequest, getAppOrigin } from "@/utils/mcp/control";
import { requestIdentity } from "./runtime";
import { isStaffAccessConfigured, readStaffAccessIdentity, staffUserIdSchema } from "./staffAccess";

export const qianchuanUserIdSchema = z.union([z.uuid(), z.literal("admin"), staffUserIdSchema]);
const nameSchema = z.string().trim().min(1).max(80);
const accountSchema = z.strictObject({ name: nameSchema, advertiserId: z.string().regex(/^\d{1,20}$/), teamId: z.uuid().nullable() });
const accessTokenSchema = z.string().trim().min(1).max(4096).regex(/^[\x21-\x7e]+$/);
const teamSchema = z.strictObject({ id: z.uuid(), name: nameSchema });
const memberSchema = z.strictObject({
  userId: qianchuanUserIdSchema, teamId: z.uuid(), revokedAt: z.number().optional(), staffName: z.email().max(254).optional(),
});
const invitationSchema = z.strictObject({
  digest: z.string().regex(/^[a-f0-9]{64}$/), teamId: z.uuid(), expiresAt: z.number(), acceptedBy: qianchuanUserIdSchema.optional(),
});
const authorizationSchema = z.strictObject({
  id: z.uuid(), name: nameSchema, cipher: z.string(), revokedAt: z.number().optional(),
  accounts: z.array(accountSchema.extend({ id: z.uuid() })),
});
const organizationSchema = z.strictObject({
  id: z.uuid(), name: nameSchema, code: z.string().regex(/^[A-F0-9]{32}$/), ownerId: qianchuanUserIdSchema, teams: z.array(teamSchema),
  members: z.array(memberSchema), invitations: z.array(invitationSchema), authorizations: z.array(authorizationSchema),
});
const newAuthorizationSchema = z.strictObject({ name: nameSchema, accessToken: accessTokenSchema, accounts: z.array(accountSchema).min(1).max(100) });
const secret = createModelSecret(dirname(conf.path));
const invitationLifetimeMs = 24 * 60 * 60 * 1000;
type Organization = z.infer<typeof organizationSchema>;
type NewAuthorization = z.input<typeof newAuthorizationSchema>;

function fail(message: string, status: number): never {
  throw Object.assign(new Error(message), { status });
}

export async function requireQianchuanActor(req: Request) {
  assertAppRequest(req);
  const actor = requestIdentity(req);
  if (req.res?.locals.multiTenantWeb === true) {
    if (!actor || (actor.id === "admin") !== (actor.role === "admin")) fail("请使用 Toonflow 创作账号登录", 401);
    return actor;
  }
  const staff = getAppOrigin(req) === process.env.TOONFLOW_STAFF_ACCESS_ORIGIN ? await readStaffAccessIdentity(req) : undefined;
  if (!staff) fail("请使用 Toonflow 创作账号登录", 401);
  return staff;
}

async function withDatabase<T>(userId: string, run: (db: AdminDatabase) => Promise<T>) {
  if (!qianchuanUserIdSchema.safeParse(userId).success) fail("当前账号无法参与组织", 403);
  const staff = staffUserIdSchema.safeParse(userId).success;
  if (staff && !isStaffAccessConfigured()) fail("当前账号无法参与组织", 403);
  const db = await openDatabase(dirname(conf.path), staff);
  if (!db) fail("组织存储尚未配置", 503);
  try {
    if (userId === "admin") {
      if (!await db.getAdmin()) fail("当前账号不存在", 403);
    } else if (!staff) {
      const user = await db.getUserById(userId);
      if (!user || user.disabled) fail("当前账号已停用或不存在", 403);
    }
    await db.initializeOrganizations();
    return await run(db);
  } finally {
    await db.close();
  }
}

function notMember(): never {
  return fail("当前账号没有该组织权限", 403);
}

async function load(db: AdminDatabase, id: string) {
  const record = await db.getOrganization(id);
  if (!record) notMember();
  const organization = organizationSchema.parse(record.payload);
  if (organization.id !== record.id) fail("组织数据不一致", 503);
  return { organization, revision: record.revision };
}

function assertOwner(organization: Organization, userId: string) {
  if (organization.ownerId !== userId) notMember();
}

function assertTeam(organization: Organization, teamId: string) {
  if (!organization.teams.some(team => team.id === teamId)) fail("找不到该组织的团队", 404);
}

function activeTeams(organization: Organization, userId: string) {
  return new Set(organization.members.filter(member => member.userId === userId && member.revokedAt === undefined).map(member => member.teamId));
}

function staffMemberName(userId: string, userName?: string) {
  return staffUserIdSchema.safeParse(userId).success ? memberSchema.shape.staffName.parse(userName) : undefined;
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

// One revision protects invitation consumption, membership changes, and authorizations for the same organization.
function changeOrganization<T>(userId: string, id: string, change: (organization: Organization) => T | Promise<T>) {
  return withDatabase(userId, async db => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const { organization, revision } = await load(db, id);
      const result = await change(organization);
      if (await db.writeOrganization(id, organization, revision)) return result;
    }
    return fail("组织设置正在更新，请重试", 409);
  });
}

export function organizationSnapshot(userId: string) {
  return withDatabase(userId, async db => {
    const organizations = [];
    for (const record of await db.listOrganizations(userId)) {
      const organization = organizationSchema.parse(record.payload);
      if (organization.id !== record.id) fail("组织数据不一致", 503);
      const owner = organization.ownerId === userId;
      const teamIds = activeTeams(organization, userId);
      if (!owner && !teamIds.size) continue;
      const authorizations = organization.authorizations.filter(item => item.revokedAt === undefined);
      organizations.push({
        id: organization.id,
        name: organization.name,
        code: organization.code,
        role: owner ? "owner" as const : "member" as const,
        teams: organization.teams.filter(team => owner || teamIds.has(team.id)),
        accounts: authorizations.flatMap(authorization => authorization.accounts
          .filter(account => owner || account.teamId === null || teamIds.has(account.teamId))
          .map(account => ({ ...account, authorizationId: authorization.id }))),
        ...(owner ? {
          authorizations: authorizations.map(({ id, name }) => ({ id, name })),
          members: await Promise.all(organization.members.filter(member => member.revokedAt === undefined).map(async ({ userId, teamId, staffName }) => ({
            userId, teamId, owner: organization.ownerId === userId,
            userName: staffName ?? (await (userId === "admin" ? db.getAdmin() : db.getUserById(userId)))?.userName,
          }))),
        } : {}),
      });
    }
    return { organizations };
  });
}

export function createOrganization(userId: string, name: string, userName?: string) {
  const id = randomUUID();
  const teamId = randomUUID();
  const code = id.replaceAll("-", "").toUpperCase();
  const organization: Organization = {
    id, code, name: nameSchema.parse(name), ownerId: userId, teams: [{ id: teamId, name: "默认团队" }],
    members: [{ userId, teamId, staffName: staffMemberName(userId, userName) }], invitations: [], authorizations: [],
  };
  return withDatabase(userId, async db => {
    if (!await db.writeOrganization(id, organization, 0)) fail("组织编码冲突，请重试", 409);
    return { id, code };
  });
}

export function createTeam(userId: string, organizationId: string, name: string) {
  const team = { id: randomUUID(), name: nameSchema.parse(name) };
  return changeOrganization(userId, organizationId, organization => {
    assertOwner(organization, userId);
    if (organization.teams.some(existing => existing.name === team.name)) fail("团队名称已存在", 409);
    organization.teams.push(team);
    return team;
  });
}

export function createInvitation(userId: string, organizationId: string, teamId: string) {
  const code = `${organizationId}.${randomBytes(32).toString("base64url")}`;
  const expiresAt = Date.now() + invitationLifetimeMs;
  return changeOrganization(userId, organizationId, organization => {
    assertOwner(organization, userId);
    assertTeam(organization, teamId);
    organization.invitations.push({ teamId, expiresAt, digest: digest(code) });
    return { code, expiresAt };
  });
}

export function joinOrganization(userId: string, code: string, userName?: string) {
  const [organizationId, randomPart, extra] = code.split(".");
  if (!organizationId || !z.uuid().safeParse(organizationId).success || !randomPart || !/^[A-Za-z0-9_-]{43}$/.test(randomPart) || extra !== undefined) {
    fail("邀请码无效或已失效", 400);
  }
  const hashedCode = digest(code);
  return changeOrganization(userId, organizationId, organization => {
    const invitation = organization.invitations.find(item => item.digest === hashedCode);
    if (!invitation || invitation.expiresAt <= Date.now() || invitation.acceptedBy) fail("邀请码无效或已失效", 400);
    if (organization.ownerId === userId || activeTeams(organization, userId).has(invitation.teamId)) fail("当前账号已加入该团队", 409);
    invitation.acceptedBy = userId;
    organization.members.push({ userId, teamId: invitation.teamId, staffName: staffMemberName(userId, userName) });
    return { organizationId, teamId: invitation.teamId };
  });
}

export function revokeMembership(userId: string, organizationId: string, memberId: string, teamId: string) {
  return changeOrganization(userId, organizationId, organization => {
    assertOwner(organization, userId);
    if (organization.ownerId === memberId) fail("组织所有者不能被移除", 409);
    const member = organization.members.find(item => item.userId === memberId && item.teamId === teamId && item.revokedAt === undefined);
    if (!member) fail("找不到该团队成员", 404);
    member.revokedAt = Date.now();
    return { revoked: true };
  });
}

function authorizationBinding(organizationId: string, authorizationId: string) {
  return `${organizationId}:${authorizationId}`;
}

export function addQianchuanAuthorization(userId: string, organizationId: string, input: NewAuthorization) {
  const { name, accessToken, accounts } = newAuthorizationSchema.parse(input);
  const id = randomUUID();
  const destinations = accounts.map(account => ({ ...account, id: randomUUID() }));
  const advertisers = new Set(destinations.map(account => account.advertiserId));
  if (advertisers.size !== destinations.length) fail("千川账户不能重复", 409);
  return changeOrganization(userId, organizationId, async organization => {
    assertOwner(organization, userId);
    for (const account of destinations) if (account.teamId !== null) assertTeam(organization, account.teamId);
    if (organization.authorizations.some(item => item.revokedAt === undefined && item.accounts.some(account => advertisers.has(account.advertiserId)))) {
      fail("该千川账户已绑定，请更换现有凭据或撤销原授权", 409);
    }
    const cipher = await secret.seal({ accessToken }, "qianchuanAuthorization", authorizationBinding(organizationId, id));
    organization.authorizations.push({ id, name, cipher, accounts: destinations });
    return { id };
  });
}

function activeAuthorization(organization: Organization, id: string) {
  const authorization = organization.authorizations.find(item => item.id === id && item.revokedAt === undefined);
  if (!authorization) fail("找不到生效的千川授权", 404);
  return authorization;
}

export function revokeQianchuanAuthorization(userId: string, organizationId: string, authorizationId: string) {
  return changeOrganization(userId, organizationId, organization => {
    assertOwner(organization, userId);
    activeAuthorization(organization, authorizationId).revokedAt = Date.now();
    return { revoked: true };
  });
}

export function replaceQianchuanAccessToken(userId: string, organizationId: string, authorizationId: string, accessToken: string) {
  const token = accessTokenSchema.parse(accessToken);
  const binding = authorizationBinding(organizationId, authorizationId);
  return changeOrganization(userId, organizationId, async organization => {
    assertOwner(organization, userId);
    const authorization = activeAuthorization(organization, authorizationId);
    await secret.open(authorization.cipher, "qianchuanAuthorization", binding);
    authorization.cipher = await secret.seal({ accessToken: token }, "qianchuanAuthorization", binding);
    return { id: authorizationId };
  });
}

export function resolveQianchuanAccount(userId: string, organizationId: string, accountId: string) {
  return withDatabase(userId, async db => {
    const { organization } = await load(db, organizationId);
    const owner = organization.ownerId === userId;
    const teams = activeTeams(organization, userId);
    if (!owner && !teams.size) notMember();
    for (const authorization of organization.authorizations) {
      if (authorization.revokedAt !== undefined) continue;
      const account = authorization.accounts.find(account => account.id === accountId);
      if (!account || (!owner && account.teamId !== null && !teams.has(account.teamId))) continue;
      const payload = await secret.open(authorization.cipher, "qianchuanAuthorization", authorizationBinding(organizationId, authorization.id));
      const token = accessTokenSchema.parse(payload.accessToken);
      return { advertiserId: account.advertiserId, token, teamId: account.teamId };
    }
    return fail("当前账号没有该千川账户的上传权限", 403);
  });
}
