/** 在执行任何清理前确认同 ID 预留属于准备任务；不能用旧任务误释放裁剪素材。 */
export function assertPreparedCleanupReservation(reservations: { operationId: string; kind?: string }[], jobId: string) {
  const matched = reservations.find(item => item.operationId === jobId);
  if (matched && matched.kind !== "prepare") throw Object.assign(new Error("资源预留类型不匹配，不能清理"), { status: 409 });
}
