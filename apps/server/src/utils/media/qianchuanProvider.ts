import { z } from "zod";

type QianchuanUploadResult = { state: "succeeded"; videoId: string; materialId?: string } | { state: "failed" | "unknown"; error: string };

const uploadResponse = z.object({ code: z.number().int(), data: z.unknown().optional() });
const videoResult = z.object({
  video_id: z.string().trim().min(1).max(255),
  material_id: z
    .string()
    .regex(/^\d{1,20}$/)
    .optional(),
});
const uploadEndpoint = "https://api.oceanengine.com/open_api/2/file/video/ad/";

function preserveIdentifiers(key: string, value: unknown, context?: { source?: string }): unknown {
  if ((key === "material_id" || key === "video_id") && typeof value === "number") {
    const source = context?.source;
    if (source && /^\d{1,20}$/.test(source)) return source;
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  }
  return value;
}

export async function uploadQianchuanVideo({
  token,
  advertiserId,
  name,
  signature,
  file,
}: {
  token: string;
  advertiserId: string;
  name: string;
  signature: string;
  file: Blob;
}): Promise<QianchuanUploadResult> {
  const form = new FormData();
  form.append("advertiser_id", advertiserId);
  form.append("upload_type", "UPLOAD_BY_FILE");
  form.append("filename", name);
  form.append("video_signature", signature);
  form.append("video_file", file, name);

  try {
    const response = await fetch(uploadEndpoint, {
      method: "POST",
      headers: { "Access-Token": token },
      body: form,
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 500 || response.status === 408) {
      return { state: "unknown", error: `千川上传结果不明确（HTTP ${response.status}）` };
    }
    const parsed = uploadResponse.safeParse(JSON.parse(await response.text(), preserveIdentifiers));
    if (parsed.success && parsed.data.code === 50000) {
      return { state: "unknown", error: "千川上传结果不明确（错误码 50000）" };
    }
    if (parsed.success && parsed.data.code !== 0) {
      return { state: "failed", error: `千川拒绝上传（错误码 ${parsed.data.code}）` };
    }
    if (response.ok && parsed.success) {
      const result = videoResult.safeParse(parsed.data.data);
      if (result.success) {
        return { state: "succeeded", videoId: result.data.video_id, materialId: result.data.material_id };
      }
    }
    return { state: "unknown", error: "千川未确认素材编号" };
  } catch {
    return { state: "unknown", error: "千川上传结果不明确，请在千川后台核对" };
  }
}
