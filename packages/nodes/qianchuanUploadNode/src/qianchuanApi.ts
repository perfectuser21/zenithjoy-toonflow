import { z } from "zod";

const teamSchema = z.object({ id: z.uuid(), name: z.string() });
const accountSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  advertiserId: z.string().regex(/^\d{1,20}$/),
  teamId: z.uuid().nullable(),
  authorizationId: z.uuid().optional(),
});
const organizationSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string(),
  role: z.enum(["owner", "member"]),
  teams: z.array(teamSchema),
  accounts: z.array(accountSchema),
  authorizations: z.array(z.object({ id: z.uuid(), name: z.string() })).optional(),
  members: z.array(z.object({ userId: z.string(), userName: z.string().optional(), teamId: z.uuid(), owner: z.boolean().optional() })).optional(),
});
export const organizationSnapshotSchema = z.object({ organizations: z.array(organizationSchema) });
const responseSchema = z.object({ code: z.number().optional(), message: z.string().optional(), data: z.unknown().optional() });
export type Organization = z.infer<typeof organizationSchema>;

export class QianchuanRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function requestQianchuan(operation: "organizations" | "start" | "status" | "retry", payload: object, signal: AbortSignal) {
  const response = await fetch(`/api/ai/media/qianchuan/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
    body: JSON.stringify(payload),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  const parsed = responseSchema.safeParse(await response.json().catch(() => undefined));
  if (!response.ok || !parsed.success || parsed.data.code !== 200) {
    throw new QianchuanRequestError(parsed.success && parsed.data.message ? parsed.data.message : "千川请求失败", response.status);
  }
  return parsed.data.data;
}
