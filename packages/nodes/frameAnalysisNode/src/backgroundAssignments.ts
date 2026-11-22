import { z } from "@toonflow/nodes-scaffold/nodeTools";

export const maxBackgroundReviewShots = 200;
const assignmentSchema = z.strictObject({
  shot: z.number().int().positive(),
  referenceShot: z.number().int().positive().nullable(),
  evidence: z.string().trim().min(1).max(240),
});
const reviewSchema = z.strictObject({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  reviewedAt: z.iso.datetime(),
  assignments: z.array(assignmentSchema).min(1).max(maxBackgroundReviewShots),
});
export type BackgroundReview = z.infer<typeof reviewSchema>;

export function readBackgroundReview(input: unknown, scenes: readonly { index: number }[]): BackgroundReview {
  const parsed = reviewSchema.safeParse(input);
  if (!parsed.success || parsed.data.assignments.length !== scenes.length) throw new Error("模型返回的背景复核清单不完整或格式有误");
  const anchors = new Set<number>();
  for (const [index, row] of parsed.data.assignments.entries()) {
    if (row.shot !== scenes[index]?.index || row.shot !== index + 1) throw new Error("背景复核的镜头编号与清单不一致");
    if (row.referenceShot === row.shot) anchors.add(row.shot);
    else if (row.referenceShot !== null && !anchors.has(row.referenceShot)) throw new Error("背景复核引用了无效的背景镜头");
  }
  return parsed.data;
}

export function restoreBackgroundReview<T extends { scenes: readonly { index: number }[]; backgroundReview?: BackgroundReview }>(result: T) {
  if (!result.backgroundReview) return result;
  try {
    return { ...result, backgroundReview: readBackgroundReview(result.backgroundReview, result.scenes) };
  } catch {
    return { ...result, backgroundReview: undefined };
  }
}
