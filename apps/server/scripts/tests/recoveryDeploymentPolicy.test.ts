import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { recoveryDockerEndpoint, trustedWorkerUid } from '../recoveryDeploymentPolicy.ts';

test('旧清单保持使用宿主 Docker，维护部署仅能选择固定维护 socket', () => {
  assert.equal(recoveryDockerEndpoint(undefined), '/run/docker.sock');
  assert.equal(recoveryDockerEndpoint('host'), '/run/docker.sock');
  assert.equal(recoveryDockerEndpoint('maintenance'), '/run/toonflow-trim-maintenance/docker.sock');
  for (const invalid of ['/tmp/fake.sock', '', 'other', null]) assert.throws(() => recoveryDockerEndpoint(invalid));
});

test('worker UID 必须是受信清单里的非 root Linux UID', () => {
  assert.equal(trustedWorkerUid('999'), 999);
  assert.equal(trustedWorkerUid('1001'), 1001);
  for (const invalid of ['0', '-1', '01', '4294967295', '999999999999999999999', '1.5', 1001, null]) {
    assert.throws(() => trustedWorkerUid(invalid));
  }
});

import { classifyMaintenanceContainers } from '../recoveryDeploymentPolicy.ts';
const app = 'a'.repeat(64), extra = 'b'.repeat(64), job = 'c'.repeat(64), image = 'sha256:' + 'd'.repeat(64);
const row = (id: string, overrides: Record<string, unknown> = {}) => ({ Id: id, Image: image, Name: '/approved', State: { Running: false }, HostConfig: { RestartPolicy: { Name: 'no' } }, Config: { Labels: {} }, ...overrides });
test('仅逐项匹配登记且停用的容器，其他容器保留为待核验任务', () => {
  assert.deepEqual(classifyMaintenanceContainers([row(app), row(extra), row(job)], [{ id: app, image }, { id: extra, image }]), [job]);
  assert.throws(() => classifyMaintenanceContainers([row(app)], [{ id: app, image }, { id: app, image }]));
  assert.throws(() => classifyMaintenanceContainers([], [{ id: app, image }]));
  assert.throws(() => classifyMaintenanceContainers([row(app, { State: { Running: true } })], [{ id: app, image }]));
  assert.throws(() => classifyMaintenanceContainers([row(app, { Image: 'sha256:' + 'e'.repeat(64) })], [{ id: app, image }]));
  assert.throws(() => classifyMaintenanceContainers([row(app, { HostConfig: { RestartPolicy: { Name: 'always' } } })], [{ id: app, image }]));
  assert.throws(() => classifyMaintenanceContainers([row(app), row(app)], [{ id: app, image }]));
  assert.throws(() => classifyMaintenanceContainers([row(app, { Config: { Labels: { 'com.zenithjoy.trim.operation': 'forged' } } })], [{ id: app, image }]));
  assert.throws(() => classifyMaintenanceContainers([row(app, { Name: '/toonflow-trim-forged' })], [{ id: app, image }]));
  assert.throws(() => classifyMaintenanceContainers([row(app), row(job), row(extra)], [{ id: app, image }]));
});

import { inspectMaintenanceContainers } from '../recoveryDeploymentPolicy.ts';
test('屏障失败不访问 daemon，inspect 失败或列表漂移拒绝', async () => {
  let accessed = false;
  await assert.rejects(inspectMaintenanceContainers(async () => { throw new Error('屏障失效'); }, async () => { accessed = true; return []; }, async () => row(app), []));
  assert.equal(accessed, false);
  await assert.rejects(inspectMaintenanceContainers(async () => {}, async () => [app], async () => { throw new Error('404'); }, [{ id: app, image }]));
  await assert.rejects(inspectMaintenanceContainers(async () => {}, async () => [app], async () => row(extra), [{ id: app, image }]));
});

import { inspectRecoveryDaemons } from '../recoveryDeploymentPolicy.ts';
test('维护端点模式仍检查宿主 daemon；宿主 ghost 的 404 必须阻断', async () => {
  const sockets: string[] = [];
  await assert.rejects(inspectRecoveryDaemons('maintenance', async socket => { sockets.push(socket); return socket === '/run/docker.sock' ? [app] : []; }, async () => { throw new Error('404'); }));
  assert.deepEqual(sockets, ['/run/docker.sock']);
  const seen: string[] = [];
  await inspectRecoveryDaemons('maintenance', async socket => { seen.push(socket); return []; }, async () => row(app));
  assert.deepEqual(seen, ['/run/docker.sock', '/run/toonflow-trim-maintenance/docker.sock']);
});

import { trustedAdditionalRuntime } from '../recoveryDeploymentPolicy.ts';
const extraUnits = ['stage-worker.service', 'stage-worker.socket', 'stage-docker.service', 'stage-containerd.service'];
const extraRuntime = { workerUnit: extraUnits[0], workerSocketUnit: extraUnits[1], daemonUnit: extraUnits[2], containerdUnit: extraUnits[3], dockerGid: '1004', workerSocket: '/run/stage/worker.sock', workerState: '/var/lib/stage/worker', workerVisibleState: '/var/lib/toonflow-trim/worker', dockerSocket: '/run/stage/docker.sock', containerdSocket: '/run/stage/containerd.sock', daemonRoot: '/var/lib/stage/docker', daemonState: '/run/stage/docker', containerdRoot: '/var/lib/stage/containerd', containerdState: '/run/stage/containerd', knownContainerIds: [app, extra], proof: { nonce: '00000000-0000-4000-8000-000000000002', capturedAt: '1730000000000', workerExecutable: '/opt/stage/bun', workerScript: '/opt/stage/trimWorker.js', workerExecutableSha256: '1'.repeat(64), workerScriptSha256: '2'.repeat(64), workerUnitSha256: '3'.repeat(64), workerSocketUnitSha256: '4'.repeat(64), daemonUnitSha256: '5'.repeat(64), containerdUnitSha256: '6'.repeat(64), bootId: '00000000-0000-4000-8000-000000000001', workerPid: '101', workerStart: '201', daemonPid: '102', daemonStart: '202', containerdPid: '103', containerdStart: '203', workerStateDev: '1', workerStateIno: '9', workerLockDev: '1', workerLockIno: '10', daemonRootDev: '1', daemonRootIno: '11', containerdRootDev: '1', containerdRootIno: '12', workerSocketDev: '1', workerSocketIno: '13', daemonStateDev: '1', daemonStateIno: '2', containerdStateDev: '1', containerdStateIno: '3', dockerSocketDev: '1', dockerSocketIno: '4', containerdSocketDev: '1', containerdSocketIno: '5' } };
test('新增运行时必须是 root 清单中完整登记的独立隔离身份', () => {
  assert.equal(trustedAdditionalRuntime(undefined, []), undefined);
  assert.deepEqual(trustedAdditionalRuntime(extraRuntime, extraUnits), extraRuntime);
  assert.throws(() => trustedAdditionalRuntime({ ...extraRuntime, dockerGid: '0' }, extraUnits));
  assert.throws(() => trustedAdditionalRuntime({ ...extraRuntime, workerVisibleState: '/var/lib/../etc' }, extraUnits));
  assert.throws(() => trustedAdditionalRuntime({ ...extraRuntime, proof: { ...extraRuntime.proof, bootId: 'bad' } }, extraUnits));
  assert.throws(() => trustedAdditionalRuntime({ ...extraRuntime, proof: { ...extraRuntime.proof, workerPid: '0' } }, extraUnits));
  assert.throws(() => trustedAdditionalRuntime({ ...extraRuntime, proof: { ...extraRuntime.proof, capturedAt: '99999999999999999999' } }, extraUnits));
  assert.throws(() => trustedAdditionalRuntime({ ...extraRuntime, dockerSocket: '/run/docker.sock' }, extraUnits));
  assert.throws(() => trustedAdditionalRuntime({ ...extraRuntime, daemonRoot: '/var/lib/docker' }, extraUnits));
  assert.throws(() => trustedAdditionalRuntime({ ...extraRuntime, daemonState: '/run/stage/../docker' }, extraUnits));
  assert.throws(() => trustedAdditionalRuntime({ ...extraRuntime, knownContainerIds: [app, app] }, extraUnits));
  assert.throws(() => trustedAdditionalRuntime({ ...extraRuntime, workerUnit: 'not-registered.service' }, extraUnits));
  const missing = { ...extraRuntime } as Record<string, unknown>; delete missing.containerdState;
  assert.throws(() => trustedAdditionalRuntime(missing, extraUnits));
});

import { runtimeProcessAssociated } from '../recoveryDeploymentPolicy.ts';
test('已登记 shim ID、运行目录或 socket 仍存在时拒绝；未知 shim 格式不猜测', () => {
  const r = trustedAdditionalRuntime(extraRuntime, extraUnits)!;
  assert.equal(runtimeProcessAssociated(r, 'containerd-shim-runc-v2', ['shim', '-id', app, '-address', '/run/other.sock'], '/tmp'), true);
  assert.equal(runtimeProcessAssociated(r, 'containerd-shim-runc-v2', ['shim', '-id', job, '-address', r.containerdSocket], '/tmp'), true);
  assert.equal(runtimeProcessAssociated(r, 'containerd-shim-runc-v2', ['shim', '-id', job, '-address', '/run/other.sock'], r.containerdState + '/task'), true);
  assert.equal(runtimeProcessAssociated(r, 'containerd-shim-runc-v2', ['shim', '-id', job, '-address', '/run/other.sock'], '/tmp'), false);
  assert.throws(() => runtimeProcessAssociated(r, 'containerd-shim-runc-v2', ['shim', '-id', 'bad'], '/tmp'));
  assert.equal(runtimeProcessAssociated(r, 'containerd-shim-runc-v2', ['shim', '-id', job, '-address', '/run/other.sock'], '/tmp', job), true);
});

import { containsOldRuntimeSocket } from '../recoveryDeploymentPolicy.ts';
test('旧 Docker 和 containerd socket 均视为未完全隔离', () => {
  const r = trustedAdditionalRuntime(extraRuntime, extraUnits)!;
  const line = (path: string) => `000: 000 000 000 000 000 123 ${path}`;
  assert.equal(containsOldRuntimeSocket(line(r.workerSocket), r), true);
  assert.equal(containsOldRuntimeSocket(line(r.containerdSocket), r), true);
  assert.equal(containsOldRuntimeSocket(line(r.dockerSocket), r), true);
  assert.equal(containsOldRuntimeSocket(line('/run/toonflow-trim-containerd/containerd.sock')), true);
  assert.equal(containsOldRuntimeSocket(line('/run/other.sock'), r), false);
});

import { requireRuntimeBinding } from '../recoveryDeploymentPolicy.ts';
test('不同 worker UID 或维护 daemon 的部署必须提供完整新运行时绑定', () => {
  const runtime = trustedAdditionalRuntime(extraRuntime, extraUnits)!;
  assert.doesNotThrow(() => requireRuntimeBinding(999, 999, false, undefined));
  assert.throws(() => requireRuntimeBinding(1001, 999, false, undefined));
  assert.throws(() => requireRuntimeBinding(999, 999, true, undefined));
  assert.doesNotThrow(() => requireRuntimeBinding(1001, 999, true, runtime));
});

import { requireCapturedRuntimeProof } from '../recoveryDeploymentPolicy.ts';
test('附加部署必须匹配事前持久预检证明，不能缺失或更换身份', () => {
  const runtime = trustedAdditionalRuntime(extraRuntime, extraUnits)!;
  assert.doesNotThrow(() => requireCapturedRuntimeProof({ workerUid: '1001', additionalRuntime: runtime }, '1001', runtime));
  assert.throws(() => requireCapturedRuntimeProof(undefined, '1001', runtime));
  assert.throws(() => requireCapturedRuntimeProof({ workerUid: '999', additionalRuntime: runtime }, '1001', runtime));
  assert.throws(() => requireCapturedRuntimeProof({ workerUid: '1001', additionalRuntime: { ...runtime, dockerGid: '9000' } }, '1001', runtime));
});

import { requireJournalAfterPreflight } from '../recoveryDeploymentPolicy.ts';
test('新运行时只接受由预检 worker 在采集后创建的日志', () => {
  const runtime = trustedAdditionalRuntime(extraRuntime, extraUnits)!;
  assert.doesNotThrow(() => requireJournalAfterPreflight({ managerPid: 101, startedAt: 1730000001000, runtimeNonce: runtime.proof.nonce }, runtime));
  assert.throws(() => requireJournalAfterPreflight(undefined, runtime));
  assert.throws(() => requireJournalAfterPreflight({ managerPid: 102, startedAt: 1730000001000 }, runtime));
  assert.throws(() => requireJournalAfterPreflight({ managerPid: 101, startedAt: 1729999999000 }, runtime));
});


test('附加运行时日志必须绑定本次预检 nonce，不能使用其他 worker 的证明', () => {
  const runtime = trustedAdditionalRuntime(extraRuntime, extraUnits)!;
  const journal = { managerPid: 101, startedAt: 1730000001000, runtimeNonce: runtime.proof.nonce };
  assert.doesNotThrow(() => requireJournalAfterPreflight(journal, runtime));
  assert.throws(() => requireJournalAfterPreflight({ ...journal, runtimeNonce: '00000000-0000-4000-8000-000000000003' }, runtime));
  assert.throws(() => requireJournalAfterPreflight({ managerPid: 101, startedAt: 1730000001000 }, runtime));
});

test('见证记录按启动实例定位，拒绝路径注入', async () => {
  const { runtimeProofPath } = await import('../recoveryDeploymentPolicy.ts');
  const runtime = trustedAdditionalRuntime(extraRuntime, extraUnits)!;
  assert.equal(runtimeProofPath(runtime), '/etc/toonflow-trim/runtime-proofs/00000000-0000-4000-8000-000000000001-101-201.json');
  assert.throws(() => runtimeProofPath({ ...runtime, proof: { ...runtime.proof, workerStart: '../bad' } }));
});

test('见证前必须匹配预先登记的程序与单元哈希，不可现场追认旧 worker', async () => {
  const { requireExpectedRuntimeHashes } = await import('../recoveryDeploymentPolicy.ts');
  const expected = { workerExecutableSha256: '1'.repeat(64), workerScriptSha256: '2'.repeat(64), workerUnitSha256: '3'.repeat(64), workerSocketUnitSha256: '4'.repeat(64), daemonUnitSha256: '5'.repeat(64), containerdUnitSha256: '6'.repeat(64) };
  assert.doesNotThrow(() => requireExpectedRuntimeHashes(expected, { ...expected }));
  assert.throws(() => requireExpectedRuntimeHashes(expected, { ...expected, workerScriptSha256: '7'.repeat(64) }));
  assert.throws(() => requireExpectedRuntimeHashes({ ...expected, rogue: 'a' }, expected));
  assert.throws(() => requireExpectedRuntimeHashes({ ...expected, workerScriptSha256: 'bad' }, expected));
});

test('任务后产生的容器只能由同一受信 journal 精确授权', async () => {
  const { authorizedJournalJob } = await import('../recoveryDeploymentPolicy.ts');
  const runtime = trustedAdditionalRuntime(extraRuntime, extraUnits)!;
  const j = { managerPid: 101, startedAt: 1730000001000, runtimeNonce: runtime.proof.nonce, phase: 'started', containerId: job };
  assert.equal(authorizedJournalJob(j, runtime), job);
  assert.equal(authorizedJournalJob({ ...j, phase: 'creating', containerId: undefined }, runtime), undefined);
  assert.throws(() => authorizedJournalJob({ ...j, runtimeNonce: '00000000-0000-4000-8000-000000000003' }, runtime));
  assert.throws(() => authorizedJournalJob({ ...j, containerId: 'bad' }, runtime));
  assert.throws(() => authorizedJournalJob({ ...j, phase: 'creating' }, runtime));
});

test('手动容器模式必须显式声明且不能混入虚构 unit', async () => {
  const { trustedAppManagement } = await import('../recoveryDeploymentPolicy.ts');
  assert.deepEqual(trustedAppManagement(undefined, 'app.service'), { mode: 'unit', unit: 'app.service' });
  assert.deepEqual(trustedAppManagement('manual', undefined), { mode: 'manual' });
  assert.throws(() => trustedAppManagement(undefined, undefined));
  assert.throws(() => trustedAppManagement('manual', 'app.service'));
  assert.throws(() => trustedAppManagement('unit', undefined));
  assert.throws(() => trustedAppManagement('manual', '../app.service'));
});

test('手动容器只允许专用维护端点，两份清单容器身份必须一致', async () => {
  const { requireManualEndpoint, requireMatchingAppManagement } = await import('../recoveryDeploymentPolicy.ts');
  const manual = { mode: 'manual' as const, id: app, image };
  assert.doesNotThrow(() => requireManualEndpoint('manual', 'maintenance'));
  assert.throws(() => requireManualEndpoint('manual', 'host'));
  assert.throws(() => requireManualEndpoint('manual', undefined));
  assert.doesNotThrow(() => requireMatchingAppManagement(manual, { ...manual }));
  assert.throws(() => requireMatchingAppManagement(manual, { ...manual, id: extra }));
  assert.throws(() => requireMatchingAppManagement(manual, { ...manual, image: 'sha256:' + 'f'.repeat(64) }));
  assert.throws(() => requireMatchingAppManagement(manual, { mode: 'unit', unit: 'app.service' }));
});
