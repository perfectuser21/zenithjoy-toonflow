/** 仅新建请求收到服务端对同一 ID 的明确未提交回执时，允许移除恢复标记。 */
export function canClearUnsubmittedTrim(fresh: boolean, status: number, body: unknown, operationId: string) {
  if (!fresh || status !== 503 || !body || typeof body !== 'object') return false;
  const response = body as { code?: unknown; data?: { notSubmitted?: unknown; operationId?: unknown } };
  return response.code === 503 && response.data?.notSubmitted === true && response.data.operationId === operationId;
}
