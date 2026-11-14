import { z } from "zod";

const identitySchema = z.strictObject({
  jobId: z.uuid(), ownerId: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/), workspaceHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const leaseSchema = identitySchema.extend({ leaseOwner: z.uuid() });
const generationSchema = z.number().int().min(1).max(2147483646);
const ttlSchema = z.number().int().min(1).max(3600000);
const revisionSchema = z.number().int().min(1).max(2147483646);
const payloadSchema = z.record(z.string(), z.json()).superRefine((value, context) => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) context.addIssue({ code: "custom", message: "批次记录不能超过 4MB" });
  const visit = (item: unknown, depth: number): boolean => {
    if (depth > 64) return false;
    if (typeof item === "string" && /^(?:https?:|data:)/i.test(item)) {
      if (/^data:/i.test(item)) return false;
      try { const url = new URL(item); return !url.username && !url.password && !url.search; } catch { return false; }
    }
    if (Array.isArray(item)) return item.every(child => visit(child, depth + 1));
    if (item && typeof item === "object") return Object.entries(item).every(([key, child]) => !/(?:api.?key|secret|token|password|authorization|cookie|credential|signature|private.?key)/i.test(key) && visit(child, depth + 1));
    return true;
  };
  if (!visit(value, 0)) context.addIssue({ code: "custom", message: "批次记录不能包含凭据、签名地址或媒体数据" });
});
export const backgroundJobKeySchema = identitySchema;
export const backgroundJobCreateSchema = identitySchema.extend({ payload: payloadSchema });
export const backgroundJobLeaseSchema = leaseSchema.extend({ ttlMs: ttlSchema });
export const backgroundJobRenewSchema = leaseSchema.extend({ generation: generationSchema, ttlMs: ttlSchema });
export const backgroundJobUpdateSchema = leaseSchema.extend({ generation: generationSchema, expectedRevision: revisionSchema, payload: payloadSchema, requireDisabledUserId: z.uuid().optional(), requireEnabledUserId: z.uuid().optional() });
export const backgroundJobReleaseSchema = leaseSchema.extend({ generation: generationSchema });
export type BackgroundJobKey = z.infer<typeof backgroundJobKeySchema>;
export type BackgroundJobCreate = z.infer<typeof backgroundJobCreateSchema>;
export type BackgroundJobLease = z.infer<typeof backgroundJobLeaseSchema>;
export type BackgroundJobRenew = z.infer<typeof backgroundJobRenewSchema>;
export type BackgroundJobUpdate = z.infer<typeof backgroundJobUpdateSchema>;
export type BackgroundJobRelease = z.infer<typeof backgroundJobReleaseSchema>;
export type BackgroundJobRecord = BackgroundJobKey & { payload: Record<string, unknown>; revision: number; leaseOwner: string | null; leaseUntil: number; leaseGeneration: number };
