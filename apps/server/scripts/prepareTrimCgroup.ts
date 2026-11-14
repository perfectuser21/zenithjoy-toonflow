// 专用执行器启动前验证并预建唯一作业 cgroup；不清理现有进程或目录。
import { lstat, mkdir, readFile, realpath, statfs } from "@toonflow/file";

const [mode, ...extra] = process.argv.slice(2);
if (process.platform !== "linux" || process.getuid?.() !== 0 || extra.length || !["normal", "maintenance"].includes(mode ?? "")) throw new Error("需要 root 及明确的 cgroup 启动模式");
if (mode === "normal") {
  // 维护运行时存在时禁止自动停止它或与其共享数据根。
  for (const unit of ["toonflowTrimMaintenance.service", "toonflowTrimMaintenanceContainerd.service"]) {
    const cmd = Bun.spawn(["/usr/bin/systemctl", "show", unit, "--property=LoadState,ActiveState,MainPID"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [output, status] = await Promise.all([cmd.stdout.text(), cmd.exited]);
    if (status !== 0) throw new Error("无法验证维护服务状态");
    const values = Object.fromEntries(output.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (values.ActiveState !== "inactive" || values.LoadState !== "not-found" && values.MainPID !== "0") throw new Error("维护服务尚未停止");
  }
}
if (mode === "maintenance") {
  // 不使用 systemd Conflicts 自动停服务；未明确停止并屏蔽时不启动维护运行时。
  for (const unit of ["toonflowTrimWorker.socket", "toonflowTrimWorker.service", "toonflowTrimDocker.service", "toonflowTrimContainerd.service"]) {
    const cmd = Bun.spawn(["/usr/bin/systemctl", "show", unit, "--property=ActiveState,UnitFileState,MainPID"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const [output, status] = await Promise.all([cmd.stdout.text(), cmd.exited]);
    if (status !== 0) throw new Error("无法验证普通裁剪服务状态");
    const values = Object.fromEntries(output.trim().split("\n").map(line => { const i = line.indexOf("="); return [line.slice(0, i), line.slice(i + 1)]; }));
    if (values.ActiveState !== "inactive" || !["masked", "masked-runtime"].includes(values.UnitFileState) || unit.endsWith(".service") && values.MainPID !== "0") throw new Error("普通裁剪服务尚未停止并屏蔽");
  }
}
const root = "/sys/fs/cgroup", path = `${root}/toonflow-trim-jobs`;
const mount = await lstat(root);
if (!mount.isDirectory() || mount.isSymbolicLink() || mount.uid !== 0 || await realpath(root) !== root || (await statfs(root, { bigint: true })).type !== 0x63677270n) throw new Error("需要受控 cgroup v2 挂载");
try { await mkdir(path, { mode: 0o755 }); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
const info = await lstat(path);
if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) || await realpath(path) !== path) throw new Error("裁剪作业 cgroup 身份异常");
const events = await readFile(`${path}/cgroup.events`, "utf8");
const fields = events.split("\n").filter(line => line.startsWith("populated "));
if (fields.length !== 1 || !/^populated [01]$/.test(fields[0]!)) throw new Error("裁剪作业 cgroup 状态异常");
if (mode === "normal" && fields[0] !== "populated 0") throw new Error("裁剪作业仍在运行，须先离线核验");
