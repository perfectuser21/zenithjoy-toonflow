import { createHash } from "node:crypto";

export function assertSingleManagedReference(references: { path: string }[], managedPaths: ReadonlySet<string>) {
  if (references.filter(item => managedPaths.has(item.path)).length > 1) throw Object.assign(new Error("每次生成目前最多使用一个托管裁剪素材"), { status: 400 });
}

/** 只在读取/上传期间持有素材读取限额，之后使用上传地址等待生成。 */
export async function useUploadedTrim<T>(
  readManaged: (upload: (bytes: Buffer) => Promise<string>) => Promise<{ managed: false } | { managed: true; value: string }>,
  upload: (bytes: Buffer) => Promise<string>,
  generate: (url: string) => Promise<T>,
): Promise<{ managed: false } | { managed: true; value: T }> {
  const uploaded = await readManaged(upload);
  if (!uploaded.managed) return { managed: false };
  return { managed: true, value: await generate(uploaded.value) };
}

export function assertVideoHashes(items: { type: string; data?: unknown; url?: unknown }[] | undefined, expected: string[] | undefined, uploaded: ReadonlyMap<string, string>) {
  if (!expected) return;
  if (!items || items.length !== expected.length || items.some((item, index) => {
    if (item.type === "url") return typeof item.url !== "string" || uploaded.get(item.url) !== expected[index];
    if (item.type !== "base64" || typeof item.data !== "string") return true;
    return createHash("sha256").update(Buffer.from(item.data, "base64")).digest("hex") !== expected[index];
  })) throw Object.assign(new Error("参考视频在校验后发生变化，请重新确认素材再生成"), { status: 400 });
}

/** 上传 policy 和 OSS 请求前分别复核账号；只包住上传，不影响后续轮询。 */
export function guardedTrimUploadFetch(fetcher: typeof fetch, authorize: () => Promise<void>, signal?: AbortSignal): typeof fetch {
  return Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    signal?.throwIfAborted();
    await authorize();
    signal?.throwIfAborted();
    return fetcher(input, init);
  }, { preconnect: fetcher.preconnect }) as typeof fetch;
}

/** 上传私有视频前按万相规则验证其余素材，避免已知无效请求产生远端副本。 */
export function assertWanReferenceMeta(type: string, mime: string, size: number, dimensions?: { width?: number; height?: number }) {
  const allowed: Record<string, { limit: number; formats: string[] }> = {
    image: { limit: 20, formats: ['image/jpeg', 'image/jpg', 'image/png', 'image/bmp', 'image/webp'] },
    video: { limit: 100, formats: ['video/mp4', 'video/quicktime'] },
    audio: { limit: 15, formats: ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3'] },
  };
  const rule = allowed[type];
  if (!rule || !Number.isSafeInteger(size) || size < 1 || size > rule.limit * 1024 * 1024 || !rule.formats.includes(mime)) {
    throw Object.assign(new Error('参考素材格式或大小不符合万相要求'), { status: 400 });
  }
  if (type === 'image') {
    const width = dimensions?.width ?? 0, height = dimensions?.height ?? 0;
    if (!Number.isFinite(width) || !Number.isFinite(height) || Math.min(width, height) < 240 || Math.max(width, height) > 8000 || Math.max(width, height) / Math.min(width, height) > 8) {
      throw Object.assign(new Error('参考图片尺寸不符合万相要求'), { status: 400 });
    }
  }
}

export function assertReferenceHash(expected: string | undefined, base64: string) {
  if (!expected || createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex') !== expected) {
    throw Object.assign(new Error('参考媒体在检查后发生变化，请重新选择'), { status: 400 });
  }
}
