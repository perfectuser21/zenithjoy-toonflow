// 实验性屏障编排：仅供隔离验证。没有宿主实现、CLI 或账本入口。
// 调用者必须实际持有同一 worker fence；所有回调必须是受信运维契约下的真实核验。
export type RecoveryJournal = { operationId: string; ownerId: string; workspaceHash: string; image: string; name: string; phase: "creating" | "created" | "starting" | "started"; containerId?: string };
type Match = { operationId: string; name: string; image: string; containerId: string; protocolVersion: 2 };
type BarrierOps = {
  // 关闭 socket 与自动重启，停止 worker 及其整个客户端 cgroup、撤销旧 socket 权限，结束旧 daemon。
  isolateAndStop(): Promise<boolean>;
  // 单独检查专用 daemon 的卷、权限和 cgroup；不是管理员输入的确认框。
  oldClientsGoneAndRevoked(): Promise<boolean>;
  // 仅受限维护 daemon 可使用原数据目录；必须拒绝 live-restore 和共享 daemon。
  startExclusiveMaintenance(): Promise<boolean>;
  stillExclusive(): Promise<boolean>;
  inspect(journal: RecoveryJournal): Promise<{ kind: "unknown" } | { kind: "absent" } | { kind: "found"; match: Match }>;
  stopExact(match: Match): Promise<boolean>;
  // 独立检查 daemon、containerd shim、作业进程/cgroup 全部终止。
  runtimeAbsent(journal: RecoveryJournal): Promise<boolean>;
  // 持久化并同步绑定 owner/workspace/operation 的封禁，已存在时必须验证身份。
  seal(journal: RecoveryJournal): Promise<boolean>;
  // 必须验证同一锁 inode 和 journal 身份，先同步封禁，再清理 active 并同步目录。
  clearActive(journal: RecoveryJournal): Promise<boolean>;
};
export async function recoverUnderBarrier(journal: RecoveryJournal, ops: BarrierOps): Promise<"blocked" | "sealedPending" | "sealed"> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(journal.operationId)
    || journal.name !== `toonflow-trim-${journal.operationId}` || !/^[a-zA-Z0-9_-]{1,64}$/.test(journal.ownerId)
    || !/^[a-f0-9]{64}$/.test(journal.workspaceHash) || !/^sha256:[a-f0-9]{64}$/.test(journal.image)
    || !["creating", "created", "starting", "started"].includes(journal.phase)
    || (journal.phase === "creating" ? journal.containerId !== undefined : !journal.containerId || !/^[a-f0-9]{64}$/.test(journal.containerId))) return "blocked";
  let didSeal = false;
  try {
    if (!await ops.isolateAndStop() || !await ops.oldClientsGoneAndRevoked() || !await ops.startExclusiveMaintenance() || !await ops.stillExclusive()) return "blocked";
    const result = await ops.inspect(journal);
    if (result.kind === "unknown") return "blocked";
    if (result.kind === "found") {
      const m = result.match;
      if (m.operationId !== journal.operationId || m.name !== journal.name || m.image !== journal.image || m.protocolVersion !== 2
        || !/^[a-f0-9]{64}$/.test(m.containerId) || journal.containerId && m.containerId !== journal.containerId) return "blocked";
      if (!await ops.stopExact(m)) return "blocked";
    }
    if (!await ops.stillExclusive() || !await ops.oldClientsGoneAndRevoked() || !await ops.runtimeAbsent(journal)) return "blocked";
    didSeal = true; // 调用一旦发出，异常也可能已经持久化。
    if (!await ops.seal(journal)) return "sealedPending";
    // 封禁成功后如屏障丢失或清理失败，只能报告处理中，不可推断已清理。
    if (!await ops.stillExclusive() || !await ops.oldClientsGoneAndRevoked() || !await ops.runtimeAbsent(journal) || !await ops.clearActive(journal)) return "sealedPending";
    return "sealed";
  } catch { return didSeal ? "sealedPending" : "blocked"; }
}
