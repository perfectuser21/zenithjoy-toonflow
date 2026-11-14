// 独立部署的隔离作业管理器；普通应用不持有 Docker socket。
import { timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { lstat, mkdir, realpath, rmdir } from "@toonflow/file";
import { writeDurableState } from "./trimWorkerState";
import { acquireWorkerFence } from "./trimWorkerFence";
import { trimNeedsFrameNormalization } from "./trimDuration";
import { serveTrimSocket } from "./trimSocketServer";

const socketPath = process.env.TOONFLOW_TRIM_SOCKET;
const token = process.env.TOONFLOW_TRIM_TOKEN;
const image = process.env.TOONFLOW_TRIM_IMAGE;
const statePath = process.env.TOONFLOW_TRIM_STATE;
const docker = process.env.TOONFLOW_TRIM_DOCKER;
if (!socketPath || !socketPath.startsWith("/") || !statePath || !statePath.startsWith("/") || !token || !/^[a-f0-9]{64}$/.test(token)
  || !image || !/^sha256:[a-f0-9]{64}$/.test(image) || !docker || !docker.startsWith("/")) throw new Error("隔离裁剪管理器配置不完整");
if (dirname(resolve(socketPath)) === resolve(statePath)) throw new Error("socket 和状态目录必须分离");
const dockerInfo = await lstat(docker);
if (!dockerInfo.isFile() || dockerInfo.isSymbolicLink() || await realpath(docker) !== docker || dockerInfo.uid !== 0 || (dockerInfo.mode & 0o022) !== 0) throw new Error("容器执行程序无效");
for (let directory = dirname(docker);;) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0) throw new Error("容器执行路径不安全");
  const parent = dirname(directory);
  if (parent === directory) break;
  directory = parent;
}
const dockerEnv = { PATH: "/usr/bin:/bin", HOME: statePath, DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_CONFIG: resolve(statePath, "dockerConfig") };
// 确认所有命令使用同一个 socket 实例；daemon 重启或 socket 被替换时不作终态推断。
const daemonSocket = await lstat("/var/run/docker.sock");
if (!daemonSocket.isSocket() || daemonSocket.isSymbolicLink()) throw new Error("容器服务 socket 无效");
async function sameDaemonSocket() {
  const current = await lstat("/var/run/docker.sock").catch(() => null);
  return !!current && current.isSocket() && !current.isSymbolicLink() && current.dev === daemonSocket.dev && current.ino === daemonSocket.ino;
}
for (const directory of [resolve(statePath)]) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory
    || process.getuid && info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("隔离目录权限不安全");
}
// 状态目录的父级必须由 root 控制，否则同 UID 客户可以替换目录使两个进程各持一把锁。
for (let directory = dirname(resolve(statePath));;) {
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0 || await realpath(directory) !== directory) throw new Error("裁剪状态目录祖先不安全");
  const parent = dirname(directory); if (parent === directory) break; directory = parent;
}
// 持有至进程退出；允许后续恢复进程通过同一把锁证明旧工作进程不再执行。
const workerFence = await acquireWorkerFence(statePath);
const workerFenceIdentity = await workerFence.stat();
const lock = resolve(statePath, "active");
const journal = resolve(lock, "lastJob.json");
async function releaseActive() {
  await unlink(journal).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  await rmdir(lock);
}
const maxInput = 512 * 1024 * 1024, maxOutput = 128 * 1024 * 1024;
const script = String.raw`set -eu
cat > /tmp/input.mp4
probe='-v error -protocol_whitelist file -f mov -format_whitelist mov -enable_drefs 0 -use_absolute_path 0'
duration=$(ffprobe $probe -show_entries format=duration -of default=nw=1:nk=1 /tmp/input.mp4 </dev/null)
geometry=$(ffprobe $probe -select_streams V:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 /tmp/input.mp4 </dev/null)
printf '%s\n' "$duration $geometry" | awk -v s="$START" -v e="$END" 'BEGIN{FS="[ ,/]"} {if ($1+0 < e || $1+0 > 120 || $2+0<1 || $3+0<1 || $2+0>3840 || $3+0>3840 || $2*$3>8294400 || $4+0<1 || $5+0<1 || $4/$5>60) exit 1}'
filter='pad=ceil(iw/2)*2:ceil(ih/2)*2'
if [ "$NORMALIZE_FPS" = 1 ]; then filter='fps=ceil(source_fps),pad=ceil(iw/2)*2:ceil(ih/2)*2'; fi
# AAC 编码和封装的时间基可能让精确 15 秒多出几毫秒；预留 50ms，避免万相拒绝。
encode_duration=$(awk -v d="$DURATION" 'BEGIN { if (d > 14.95 && d <= 15) print 14.95; else print d }')
ffmpeg -hide_banner -v error -nostdin -n -protocol_whitelist file -f mov -format_whitelist mov -enable_drefs 0 -use_absolute_path 0 -ss "$START" -i /tmp/input.mp4 -t "$encode_duration" -map 0:V:0 -map '0:a:0?' -c:v libx264 -threads 2 -preset fast -crf 20 -vf "$filter" -pix_fmt yuv420p -c:a aac -ar 48000 -movflags +faststart -map_metadata -1 -fs 134217728 /tmp/output.mp4
size=$(stat -c %s /tmp/output.mp4)
[ "$size" -gt 0 ] && [ "$size" -lt 134217728 ]
actual=$(ffprobe $probe -show_entries format=duration -of default=nw=1:nk=1 /tmp/output.mp4 </dev/null)
video_duration=$(ffprobe $probe -select_streams V:0 -show_entries stream=duration -of default=nw=1:nk=1 /tmp/output.mp4 </dev/null)
output=$(ffprobe $probe -select_streams V:0 -show_entries stream=width,height -of csv=p=0 /tmp/output.mp4 </dev/null)
printf '%s %s %s\n' "$actual" "$video_duration" "$output" | awk -v expected="$DURATION" 'BEGIN{FS="[ ,]"} {d=$1-expected;if(d<0)d=-d;if(d>0.15 || $1+0<=0 || $2+0<=0 || $3+0<1 || $4+0<1 || (expected<=15.00000001 && ($1+0>15 || $2+0>15)))exit 1}'
printf '%s %s\n' "$actual" "$output"
cat /tmp/output.mp4`;
function denied(status: number) { return new Response(null, { status }); }
await serveTrimSocket(socketPath, "trimWorker", maxInput, async request => {
  const [fenceOnPath, fenceHeld] = await Promise.all([lstat(resolve(statePath!, ".worker.lock")).catch(() => null), workerFence.stat().catch(() => null)]);
  if (workerFence.fd < 0 || !fenceHeld?.isFile() || fenceHeld.dev !== workerFenceIdentity.dev || fenceHeld.ino !== workerFenceIdentity.ino || !fenceOnPath?.isFile() || fenceOnPath.isSymbolicLink() || fenceOnPath.dev !== workerFenceIdentity.dev || fenceOnPath.ino !== workerFenceIdentity.ino || fenceOnPath.nlink !== 1 || (fenceOnPath.mode & 0o077)) return denied(503);
  const url = new URL(request.url);
  const provided = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${token}`;
  const actualBytes = Buffer.from(provided), expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return denied(403);
  if ((request.method === "GET" || request.method === "POST") && url.pathname === "/recovery") {
    // 未知创建状态须独立运维核验，普通应用无权解除。
    return denied(503);
  }
  if (request.method !== "POST" || url.pathname !== "/trim") return denied(404);
  const operationId = request.headers.get("x-trim-operation") ?? "";
  const ownerId = request.headers.get("x-trim-owner") ?? "", workspaceHash = request.headers.get("x-trim-workspace") ?? "";
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(operationId) || !/^[a-zA-Z0-9_-]{1,64}$/.test(ownerId) || !/^[a-f0-9]{64}$/.test(workspaceHash)) return denied(400);
  const rawStart = request.headers.get("x-trim-start"), rawEnd = request.headers.get("x-trim-end");
  const start = Number(rawStart), end = Number(rawEnd);
  const length = Number(request.headers.get("content-length"));
  if (!request.body || rawStart === null || rawEnd === null || !Number.isSafeInteger(length) || length < 1 || length > maxInput || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 120) return denied(400);
  try { await mkdir(lock, { mode: 0o700 }); } catch { return denied(429); }
  const name = `toonflow-trim-${operationId}`;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let containerId: string | undefined;
  // 只有尚未向 daemon 发起创建时可直接释放；发起后须确认终态。
  let safeToUnlock = true;
  let detachAbort = () => {};
  try {
    // active 与当前请求绑定，禁止恢复时把上一次作业的日志当成本次证据。
    const parent = await open(statePath!, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await parent.sync(); } finally { await parent.close(); }
    const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(180000)]);
    deadline.throwIfAborted();
    if (!await sameDaemonSocket()) throw new Error("容器服务连接已变化");
    const aborted = new Promise<never>((_, reject) => {
      const onAbort = () => reject(new Error("裁剪中止"));
      deadline.addEventListener("abort", onAbort, { once: true });
      detachAbort = () => deadline.removeEventListener("abort", onAbort);
      if (deadline.aborted) onAbort();
    });
    // 创建阶段仍须等结果；提前订阅避免断连先发生时产生未处理拒绝。
    void aborted.catch(() => {});
    await writeDurableState(journal, { name, operationId, ownerId, workspaceHash, image, managerPid: process.pid, phase: "creating", protocolVersion: 2, startedAt: Date.now() });
    safeToUnlock = false;
    const creation = Bun.spawn([docker, "create", "--init", "--rm", "--pull=never", "--name", name, "--label", `com.zenithjoy.trim.operation=${operationId}`, "--label", "com.zenithjoy.trim.protocol=2", "--network=none", "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=32", "--memory=1g", "--cpus=1", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=768m,mode=1777", "-i", "--env", `START=${start}`, "--env", `END=${end}`, "--env", `DURATION=${end-start}`, "--env", `NORMALIZE_FPS=${trimNeedsFrameNormalization(start, end) ? 1 : 0}`, image, "timeout", "-k", "5s", "180s", "/bin/sh", "-c", script], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: dockerEnv });
    child = creation;
    // 创建请求已发出后等待明确结果；断连不能取消 daemon 内可能仍在进行的创建。
    const [createdText, creationExit] = await Promise.all([creation.stdout.text(), creation.exited]);
    const created = createdText.trim();
    if (creationExit !== 0 || !/^[a-f0-9]{64}$/.test(created)) throw new Error("容器创建结果未知");
    containerId = created;
    await writeDurableState(journal, { name, operationId, ownerId, workspaceHash, image, containerId, managerPid: process.pid, phase: "created", protocolVersion: 2, startedAt: Date.now() });
    deadline.throwIfAborted();
    // 启动前先持久化启动意图；恢复代码不得把启动结果未知当作未启动。
    await writeDurableState(journal, { name, operationId, ownerId, workspaceHash, image, containerId, managerPid: process.pid, phase: "starting", protocolVersion: 2, startedAt: Date.now() });
    const running = Bun.spawn([docker, "start", "--attach", "--interactive", containerId], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: dockerEnv });
    child = running;
    await writeDurableState(journal, { name, operationId, ownerId, workspaceHash, image, containerId, managerPid: process.pid, childPid: running.pid, phase: "started", protocolVersion: 2, startedAt: Date.now() });
    const input = (async () => { const reader = request.body!.getReader(); let total = 0; try { while (true) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength; if (total > length) throw new Error("输入长度无效"); running.stdin.write(value); await running.stdin.flush(); } if (total !== length) throw new Error("输入长度无效"); running.stdin.end(); } finally { reader.releaseLock(); } })();
    const output = (async () => { const reader = running.stdout.getReader(); const chunks: Uint8Array[] = []; let total = 0; try { while (true) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength; if (total > maxOutput + 256) throw new Error("输出过大"); chunks.push(value); } return Buffer.concat(chunks); } finally { reader.releaseLock(); } })();
    deadline.throwIfAborted();
    const [, bytes, exit] = await Promise.race([Promise.all([input, output, running.exited]), aborted]);
    const check = Bun.spawn([docker, "ps", "-aq", "--no-trunc"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: dockerEnv });
    const ids = await check.stdout.text();
    if (await check.exited !== 0 || !await sameDaemonSocket() || ids.split("\n").some(id => id.trim() === containerId)) return denied(503);
    safeToUnlock = true;
    if (exit !== 0) return denied(422);
    const newline = bytes.indexOf(10);
    if (newline < 1 || newline > 128) return denied(422);
    const match = /^([0-9.]+) ([0-9]+),([0-9]+)$/.exec(bytes.subarray(0, newline).toString("utf8"));
    if (!match || bytes.length - newline - 1 < 1) return denied(422);
    let position = newline + 1, released = false, timer: ReturnType<typeof setTimeout>;
    const release = () => { if (released) return; released = true; clearTimeout(timer); void releaseActive().catch(() => {}); };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { timer = setTimeout(() => { controller.error(new Error("响应超时")); release(); }, 30000); },
      pull(controller) {
        if (position >= bytes.length) { controller.close(); release(); return; }
        const next = Math.min(position + 65536, bytes.length);
        controller.enqueue(bytes.subarray(position, next)); position = next;
      },
      cancel() { release(); },
    });
    safeToUnlock = false;
    return new Response(stream, { headers: { "content-type": "video/mp4", "x-trim-duration": match[1]!, "x-trim-width": match[2]!, "x-trim-height": match[3]! } });
  } catch {
    // Docker CLI 退出并不证明容器退出；先终止具名容器并确认不存在，否则保留锁等待运维处理。
    if (child) {
      if (containerId) { const kill = Bun.spawn([docker, "kill", containerId], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: dockerEnv }); await kill.exited; }
      child.kill();
      await child.exited.catch(() => {});
      // 守护进程可在同一 socket 重启或经代理切换；异常路径不将空列表当作终态证明。
    }
    return denied(503);
  } finally { detachAbort(); if (safeToUnlock) await releaseActive().catch(() => {}); }
});
console.log("隔离裁剪管理器已启动");
