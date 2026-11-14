function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }

/** 采用视频流与容器时长的较大值，防止接近边界的素材被低估。 */
export function parseWanProbeDuration(output: string, exitCode: number): number {
  if (exitCode !== 0 || output.length > 100000) invalid('无法读取参考视频时长，请尝试将视频重新封装为 MP4 后重试');
  let value: { streams?: { duration?: string }[]; format?: { duration?: string } };
  try { value = JSON.parse(output); } catch { return invalid('无法读取参考视频时长，请检查文件'); }
  const values = [value.streams?.[0]?.duration, value.format?.duration].map(Number).filter(item => Number.isFinite(item) && item > 0);
  if (!value.streams?.length || !values.length) invalid('无法确认参考视频时长，请尝试将视频重新封装为 MP4 后重试');
  return Math.max(...values);
}

export function assertWanReferenceDuration(total: number, outputDuration?: number) {
  if (!Number.isFinite(total) || total <= 0) invalid('无法确认参考视频时长，请重新选择素材');
  if (total > 15) invalid(`万相参考视频总时长不能超过 15 秒，已达到 ${(Math.ceil(total * 1000) / 1000).toFixed(3)} 秒。请先截取或分段后再生成。`);
  if (typeof outputDuration === 'number' && outputDuration > 0 && total + outputDuration > 30) invalid('万相参考视频与生成视频的总时长不能超过 30 秒，请缩短参考视频或生成时长。');
}
