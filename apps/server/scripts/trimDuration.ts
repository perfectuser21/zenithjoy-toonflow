/** 接近万相 15 秒边界时将分数帧率向上归整，避免最后一帧使封装时长超限。 */
export function trimNeedsFrameNormalization(start: number, end: number) {
  const duration = end - start;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('截取时间范围无效');
  return duration >= 14.85 && duration <= 15 + 1e-8;
}
