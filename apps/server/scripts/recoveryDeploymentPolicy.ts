import { isDeepStrictEqual } from 'node:util';

/** 从 root 管控清单选择固定端点；禁止传入任意 socket。 */
export function recoveryDockerEndpoint(value: unknown): string {
  if (value === undefined || value === 'host') return '/run/docker.sock';
  if (value === 'maintenance') return '/run/toonflow-trim-maintenance/docker.sock';
  throw new Error('恢复部署 Docker 端点不受支持');
}

/** 只接受维护清单内可表示的非 root Linux UID。 */
export function trustedWorkerUid(value: unknown): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error('worker UID 无效');
  const uid = Number(value);
  if (!Number.isSafeInteger(uid) || uid >= 4294967295) throw new Error('worker UID 无效');
  return uid;
}

type Allowed = { id: string; image: string };
type DockerRow = { Id?: unknown; Image?: unknown; Name?: unknown; State?: { Running?: unknown }; HostConfig?: { RestartPolicy?: { Name?: unknown } }; Config?: { Labels?: unknown } };

/** 只豁免清单精确指定且经 daemon 读回停止的非作业容器。 */
export function classifyMaintenanceContainers(rows: DockerRow[], allowed: Allowed[]): string[] {
  if (allowed.length > 32) throw new Error('登记容器过多');
  const expected = new Map<string, string>();
  for (const item of allowed) {
    if (!/^[a-f0-9]{64}$/.test(item.id) || !/^sha256:[a-f0-9]{64}$/.test(item.image) || expected.has(item.id)) throw new Error('登记容器身份无效');
    expected.set(item.id, item.image);
  }
  const seen = new Set<string>(), jobs: string[] = [];
  for (const row of rows) {
    if (typeof row.Id !== 'string' || !/^[a-f0-9]{64}$/.test(row.Id) || seen.has(row.Id)) throw new Error('容器列表不可核验');
    seen.add(row.Id);
    const image = expected.get(row.Id);
    if (!image) { jobs.push(row.Id); continue; }
    const labels = row.Config?.Labels;
    if (row.Image !== image || row.State?.Running !== false || row.HostConfig?.RestartPolicy?.Name !== 'no'
      || typeof row.Name !== 'string' || row.Name.startsWith('/toonflow-trim-')
      || labels !== null && labels !== undefined && (typeof labels !== 'object' || Array.isArray(labels))
      || Object.keys((labels ?? {}) as Record<string, unknown>).some(key => key.startsWith('com.zenithjoy.trim.'))) throw new Error('登记容器状态或身份不符');
  }
  if ([...expected.keys()].some(id => !seen.has(id)) || jobs.length > 1) throw new Error('容器缺失或存在额外容器');
  return jobs;
}

/** 每次操作前先确认屏障，再对 daemon 返回的每个完整 ID 逐一读回。 */
export async function inspectMaintenanceContainers(
  barrier: () => Promise<void>,
  list: () => Promise<string[]>,
  inspect: (id: string) => Promise<DockerRow>,
  allowed: Allowed[],
): Promise<string[]> {
  await barrier();
  const ids = await list();
  if (ids.length > 10000 || ids.some(id => !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('维护 daemon 容器列表异常');
  const rows: DockerRow[] = [];
  for (const id of ids) {
    const row = await inspect(id);
    if (row.Id !== id) throw new Error('维护容器身份不可核验');
    rows.push(row);
  }
  return classifyMaintenanceContainers(rows, allowed);
}

/** 宿主 daemon 必须始终扫描；同机维护 daemon 是额外检查。 */
export async function inspectRecoveryDaemons<T>(
  appDocker: unknown,
  list: (socket: string) => Promise<string[]>,
  inspect: (socket: string, id: string) => Promise<T>,
): Promise<Array<{ socket: string; id: string; row: T }>> {
  const target = recoveryDockerEndpoint(appDocker), host = recoveryDockerEndpoint('host');
  const sockets = target === host ? [host] : [host, target];
  const records: Array<{ socket: string; id: string; row: T }> = [];
  for (const socket of sockets) {
    const ids = await list(socket);
    if (ids.length > 10000 || ids.some(id => !/^[a-f0-9]{64}$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('daemon 容器列表异常');
    for (const id of ids) records.push({ socket, id, row: await inspect(socket, id) });
  }
  return records;
}

export type AdditionalRuntime = {
  workerUnit: string; workerSocketUnit: string; daemonUnit: string; containerdUnit: string; dockerGid: string;
  workerSocket: string; workerState: string; workerVisibleState: string; dockerSocket: string; containerdSocket: string; daemonRoot: string; daemonState: string;
  containerdRoot: string; containerdState: string; knownContainerIds: string[];
  proof: { nonce: string; capturedAt: string; workerExecutable: string; workerScript: string; workerExecutableSha256: string; workerScriptSha256: string;
    workerUnitSha256: string; workerSocketUnitSha256: string; daemonUnitSha256: string; containerdUnitSha256: string; bootId: string; workerPid: string; workerStart: string; daemonPid: string; daemonStart: string; containerdPid: string; containerdStart: string;
    workerStateDev: string; workerStateIno: string; workerLockDev: string; workerLockIno: string; daemonRootDev: string; daemonRootIno: string; containerdRootDev: string; containerdRootIno: string; workerSocketDev: string; workerSocketIno: string; listenerInode: string; daemonStateDev: string; daemonStateIno: string; containerdStateDev: string; containerdStateIno: string; dockerSocketDev: string; dockerSocketIno: string; containerdSocketDev: string; containerdSocketIno: string };

};

/** 附加运行时身份只能来自完整、互相一致的 root 受控维护清单。 */
export function trustedAdditionalRuntime(value: unknown, units: string[]): AdditionalRuntime | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('附加运行时清单异常');
  const v = value as Record<string, unknown>;
  const keys = ['workerUnit', 'workerSocketUnit', 'daemonUnit', 'containerdUnit', 'dockerGid', 'workerSocket', 'workerState', 'workerVisibleState', 'dockerSocket', 'containerdSocket', 'daemonRoot', 'daemonState', 'containerdRoot', 'containerdState', 'knownContainerIds', 'proof'];
  if (Object.keys(v).length !== keys.length || keys.some(key => !(key in v))) throw new Error('附加运行时字段不完整');
  const unitKeys = ['workerUnit', 'workerSocketUnit', 'daemonUnit', 'containerdUnit'];
  const names = unitKeys.map(key => v[key]);
  if (names.some((x, i) => typeof x !== 'string' || !/^[A-Za-z0-9_.@-]+\.(service|socket)$/.test(x) || !x.endsWith(i === 1 ? '.socket' : '.service') || !units.includes(x)) || new Set(names).size !== names.length) throw new Error('附加服务未完整登记');
  trustedWorkerUid(v.dockerGid);
  if (typeof v.workerVisibleState !== 'string' || !/^\/var\/lib\/[A-Za-z0-9_./-]+$/.test(v.workerVisibleState) || v.workerVisibleState.slice(1).split('/').some(part => !part || part === '.' || part === '..')) throw new Error('worker 可见状态路径异常');
  const pathKeys = ['workerSocket', 'dockerSocket', 'containerdSocket', 'workerState', 'daemonRoot', 'daemonState', 'containerdRoot', 'containerdState'];
  const paths = pathKeys.map(key => v[key]);
  if (paths.some((x, i) => typeof x !== 'string' || !/^\/(run|var\/lib)\/[A-Za-z0-9_./-]+$/.test(x) || x.slice(1).split('/').some(part => part === '.' || part === '..' || part === '') || (i < 3 && (!x.startsWith('/run/') || !x.endsWith('.sock'))) || ((i === 3 || i === 4 || i === 6) && !x.startsWith('/var/lib/')) || ((i === 5 || i === 7) && !x.startsWith('/run/')))
    || new Set(paths).size !== paths.length
    || paths.some(x => ['/run/docker.sock', '/run/containerd/containerd.sock', '/run/toonflow-trim-maintenance/docker.sock', '/var/lib/docker', '/var/lib/containerd'].includes(String(x)))) throw new Error('附加运行时路径异常');
  if (!Array.isArray(v.knownContainerIds) || v.knownContainerIds.length > 32 || v.knownContainerIds.some(x => typeof x !== 'string' || !/^[a-f0-9]{64}$/.test(x)) || new Set(v.knownContainerIds).size !== v.knownContainerIds.length) throw new Error('附加运行时容器清单异常');
  if (!v.proof || typeof v.proof !== 'object' || Array.isArray(v.proof)) throw new Error('运行时预检证明异常');
  const proof = v.proof as Record<string, unknown>;
  const numericKeys = ['capturedAt', 'workerPid', 'workerStart', 'daemonPid', 'daemonStart', 'containerdPid', 'containerdStart', 'workerStateDev', 'workerStateIno', 'workerLockDev', 'workerLockIno', 'daemonRootDev', 'daemonRootIno', 'containerdRootDev', 'containerdRootIno', 'workerSocketDev', 'workerSocketIno', 'listenerInode', 'daemonStateDev', 'daemonStateIno', 'containerdStateDev', 'containerdStateIno', 'dockerSocketDev', 'dockerSocketIno', 'containerdSocketDev', 'containerdSocketIno'];
  const digestKeys = ['workerExecutableSha256', 'workerScriptSha256', 'workerUnitSha256', 'workerSocketUnitSha256', 'daemonUnitSha256', 'containerdUnitSha256'];
  const executableKeys = ['workerExecutable', 'workerScript'];
  const proofKeys = ['bootId', 'nonce', ...numericKeys, ...digestKeys, ...executableKeys];
  if (Object.keys(proof).length !== proofKeys.length || proofKeys.some(key => !(key in proof)) || typeof proof.bootId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(proof.bootId)
    || typeof proof.nonce !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(proof.nonce)
    || numericKeys.some(key => typeof proof[key] !== 'string' || !/^[1-9][0-9]*$/.test(proof[key] as string))
    || digestKeys.some(key => typeof proof[key] !== 'string' || !/^[a-f0-9]{64}$/.test(proof[key] as string))
    || executableKeys.some(key => typeof proof[key] !== 'string' || !/^\/(opt|usr)\/[A-Za-z0-9_./-]+$/.test(proof[key] as string) || (proof[key] as string).slice(1).split('/').some(part => !part || part === '.' || part === '..'))
    || !Number.isSafeInteger(Number(proof.capturedAt))
    || ['workerPid', 'daemonPid', 'containerdPid'].some(key => !Number.isSafeInteger(Number(proof[key])) || Number(proof[key]) >= 4294967295)
    || new Set([proof.workerPid, proof.daemonPid, proof.containerdPid]).size !== 3) throw new Error('运行时预检证明无效');
  return v as AdditionalRuntime;
}

/** 识别登记运行时的 daemon 或 shim；无法判定的 shim 一律拒绝。 */
export function runtimeProcessAssociated(runtime: AdditionalRuntime, executable: string, args: string[], cwd: string, journalJobId?: string): boolean {
  if (!['dockerd', 'containerd', 'containerd-shim-runc-v2'].includes(executable)) return false;
  const references = [runtime.dockerSocket, runtime.containerdSocket, runtime.daemonRoot, runtime.daemonState, runtime.containerdRoot, runtime.containerdState];
  if (args.some(value => references.some(ref => value === ref || value.endsWith(`=${ref}`) || value.endsWith(`:${ref}`)))) return true;
  if (executable !== 'containerd-shim-runc-v2') return false;
  const ids = args.flatMap((value, index) => value === '-id' && index + 1 < args.length ? [args[index + 1]!] : []);
  const addresses = args.flatMap((value, index) => value === '-address' && index + 1 < args.length ? [args[index + 1]!] : []);
  if (ids.length !== 1 || !/^[a-f0-9]{64}$/.test(ids[0]!) || addresses.length !== 1 || !addresses[0]!.startsWith('/') || !cwd.startsWith('/')) throw new Error('shim 进程身份不可核验');
  return runtime.knownContainerIds.includes(ids[0]!) || ids[0] === journalJobId || cwd === runtime.containerdState || cwd.startsWith(`${runtime.containerdState}/`);
}

/** /proc/net/unix 的每个网络命名空间均不得保留旧 runtime socket。 */
export function containsOldRuntimeSocket(unix: string, extra?: AdditionalRuntime): boolean {
  const sockets = new Set(['/run/toonflow-trim-docker/docker.sock', '/run/toonflow-trim-containerd/containerd.sock', ...(extra ? [extra.workerSocket, extra.dockerSocket, extra.containerdSocket] : [])]);
  return unix.split('\n').some(line => sockets.has(line.trim().split(/\s+/)[7] ?? ''));
}

/** 新 worker 或同 daemon 应用不得沿用未绑定新运行时的旧维护合同。 */
export function requireRuntimeBinding(workerUid: number, legacyUid: number, maintenanceApp: boolean, runtime?: AdditionalRuntime): void {
  if ((workerUid !== legacyUid || maintenanceApp) && !runtime) throw new Error('新部署缺少完整运行时绑定');
}

/** 维护清单必须等于任务前由 root 采集并持久化的证据。 */
export function requireCapturedRuntimeProof(record: unknown, workerUid: string, runtime: AdditionalRuntime): void {
  if (!isDeepStrictEqual(record, { workerUid, additionalRuntime: runtime })) throw new Error('附加运行时与预检证明不一致');
}

/** 新运行时日志必须由事前记录的 worker 在采集后写出。 */
export function requireJournalAfterPreflight(journal: unknown, runtime: AdditionalRuntime): void {
  if (!journal || typeof journal !== 'object' || Array.isArray(journal)) throw new Error('附加运行时缺少可绑定的任务日志');
  const item = journal as { managerPid?: unknown; startedAt?: unknown; runtimeNonce?: unknown };
  if (item.runtimeNonce !== runtime.proof.nonce || item.managerPid !== Number(runtime.proof.workerPid) || typeof item.startedAt !== 'number' || !Number.isSafeInteger(item.startedAt) || item.startedAt <= Number(runtime.proof.capturedAt)) throw new Error('任务日志不属于事前预检 worker');
}

/** Immutable preflight records survive subsequent worker restarts. */
export function runtimeProofPath(runtime: AdditionalRuntime): string {
  const { bootId, workerPid, workerStart } = runtime.proof;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(bootId)
      || !/^[1-9][0-9]*$/.test(workerPid) || !/^[1-9][0-9]*$/.test(workerStart)) throw new Error('运行时证明身份无效');
  return `/etc/toonflow-trim/runtime-proofs/${bootId}-${workerPid}-${workerStart}.json`;
}

/** Compare with hashes fixed in the root-controlled template before any task can start. */
export function requireExpectedRuntimeHashes(expected: unknown, actual: Record<string, string>): void {
  const names = ['workerExecutableSha256', 'workerScriptSha256', 'workerUnitSha256', 'workerSocketUnitSha256', 'daemonUnitSha256', 'containerdUnitSha256'];
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('缺少预先固定的运行时哈希');
  const values = expected as Record<string, unknown>;
  if (Object.keys(values).length !== names.length || names.some(name => typeof values[name] !== 'string' || !/^[a-f0-9]{64}$/.test(values[name] as string) || values[name] !== actual[name])) throw new Error('运行时与预先固定的候选不一致');
}

/** Dynamic IDs are accepted only from the already identity-checked durable journal. */
export function authorizedJournalJob(journal: unknown, runtime: AdditionalRuntime): string | undefined {
  requireJournalAfterPreflight(journal, runtime);
  const item = journal as { phase?: unknown; containerId?: unknown };
  if (item.phase === 'creating' && item.containerId === undefined) return undefined;
  if (!['created', 'starting', 'started'].includes(String(item.phase)) || typeof item.containerId !== 'string' || !/^[a-f0-9]{64}$/.test(item.containerId)) throw new Error('作业容器缺少可验证日志身份');
  return item.containerId;
}

/** A manual app has no fabricated unit; legacy manifests retain mandatory unit checks. */
export function trustedAppManagement(mode: unknown, unit: unknown): { mode: 'unit'; unit: string } | { mode: 'manual' } {
  if (mode === 'manual' && unit === undefined) return { mode: 'manual' };
  if ((mode === undefined || mode === 'unit') && typeof unit === 'string' && /^[A-Za-z0-9_.@-]+\.service$/.test(unit)) return { mode: 'unit', unit };
  throw new Error('应用管理方式登记无效');
}

export function requireManualEndpoint(mode: unknown, endpoint: unknown): void {
  if (mode === 'manual' && endpoint !== 'maintenance') throw new Error('手动应用必须在专用维护 daemon 中核验');
}
export function requireMatchingAppManagement(left: unknown, right: unknown): void {
  if (!isDeepStrictEqual(left, right)) throw new Error('维护清单与应用部署身份不一致');
}
