import { constants, copyFile, mkdir, realpath, rm, stat, statfs, withFileAccess } from "@toonflow/file";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { z } from "zod";

function invalid(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }

// 返回连续时间区间；短尾段向前调整，任何时间都不被省略。
export function planBackgroundSegments(duration: number, scenes: number[]) {
  if (!Number.isFinite(duration) || duration < 1 || duration > 120) invalid("视频时长须在 1 到 120 秒之间");
  const changes = scenes.filter(value => Number.isFinite(value) && value >= 1 && value <= duration - 1).sort((a, b) => a - b);
  const result: { startSeconds: number; endSeconds: number }[] = [];
  let start = 0;
  while (duration - start > 15) {
    const upper = Math.min(start + 15, duration - 1);
    const candidates = changes.filter(value => value >= start + 1 && value <= upper);
    const end = candidates.at(-1) ?? upper;
    if (end <= start || end - start > 15) invalid("无法规划视频片段");
    result.push({ startSeconds: start, endSeconds: end });
    start = end;
  }
  result.push({ startSeconds: start, endSeconds: duration });
  return result;
}

export async function inspectBackgroundVideo(source: string, signal: AbortSignal) {
  const sourceInfo = await stat(source);
  if (!sourceInfo.isFile() || !sourceInfo.size || sourceInfo.size > 512 * 1024 * 1024) invalid("源视频须为不超过 512 MB 的普通文件", 413);
  const paths = await prepareWorkspaceFfmpeg(signal);
  return withFileAccess([source], "read", async () => {
    const options = { stdin: "ignore" as const, stdout: "pipe" as const, stderr: "pipe" as const, windowsHide: true,
      signal, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "FFREPORT")) };
    const probe = Bun.spawn([paths.ffprobe, "-v", "error", "-protocol_whitelist", "file", "-f", "mov", "-format_whitelist", "mov",
      "-enable_drefs", "0", "-use_absolute_path", "0", "-select_streams", "V:0", "-show_entries", "stream=duration,avg_frame_rate,width,height:format=duration", "-of", "json", source], options);
    const [out, probeExit] = await Promise.all([probe.stdout.text(), probe.exited]);
    if (probeExit !== 0 || out.length > 100000) invalid("无法读取 MP4/MOV 视频信息", 422);
    let data: { streams?: { duration?: string; avg_frame_rate?: string; width?: number; height?: number }[]; format?: { duration?: string } };
    try { data = JSON.parse(out); } catch { return invalid("视频信息无效", 422); }
    const stream = data.streams?.[0];
    const duration = Number(stream?.duration ?? data.format?.duration);
    const [a, b] = (stream?.avg_frame_rate ?? "0/1").split("/").map(Number);
    const fps = a! / b!;
    if (!Number.isFinite(fps) || fps < 16) invalid("视频帧率须至少为 16 帧/秒", 422);
    if (!Number.isFinite(duration) || duration < 1 || duration > 120) invalid("视频时长须在 1 到 120 秒之间", 422);
    const width = stream?.width ?? 0, height = stream?.height ?? 0;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 3840 || height > 3840 || width * height > 8294400) invalid("视频分辨率超过支持范围", 422);
    const command = Bun.spawn([paths.ffmpeg, "-hide_banner", "-nostdin", "-protocol_whitelist", "file", "-f", "mov", "-format_whitelist", "mov",
      "-enable_drefs", "0", "-use_absolute_path", "0", "-i", source, "-an", "-vf", "select=gt(scene\\,0.3),showinfo", "-f", "null", "-"],
      { ...options, stdout: "ignore" });
    const timestamps: number[] = [];
    const decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of command.stderr) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop()?.slice(-4096) ?? "";
      for (const line of lines) {
        const match = /pts_time:([0-9.]+)/.exec(line);
        if (match && timestamps.length < 100000) timestamps.push(Number(match[1]));
      }
    }
    if (await command.exited !== 0) invalid("场景检测失败，请检查视频", 422);
    return { duration, fps, width, height, segments: planBackgroundSegments(duration, timestamps) };
  }, signal);
}

// 先在私有临时目录切片；成功后独占发布，失败只清理本次临时目录。
export async function splitBackgroundVideo(cwd: string, source: string, planId: string,
  segments: { startSeconds: number; endSeconds: number }[], signal: AbortSignal, checkLease?: () => Promise<void>) {
  z.uuid().parse(planId);
  if (!segments.length || segments.length > 24 || segments[0]?.startSeconds !== 0 || segments.some((part, index) =>
    !Number.isFinite(part.startSeconds) || !Number.isFinite(part.endSeconds) || part.endSeconds - part.startSeconds < 1
      || part.endSeconds - part.startSeconds > 15 || index > 0 && part.startSeconds !== segments[index - 1]!.endSeconds)) invalid("分段时间轴无效");
  const tools = await prepareWorkspaceFfmpeg(signal);
  const folder = `assets/generated/background${planId.replaceAll("-", "")}`;
  const root = await resolveWorkspacePath(cwd, "assets/generated", true);
  await mkdir(root.path, { recursive: true });
  const disk = await statfs(root.path);
  if (disk.bavail * disk.bsize < 2 * 1024 * 1024 * 1024) invalid("可用磁盘空间不足，请联系管理员", 507);
  const output: { path: string; mimeType: "video/mp4"; duration: number; startSeconds: number; endSeconds: number }[] = [];
  const tempRoot = await realpath(tmpdir());
  const temporary = join(tempRoot, `toonflowBackground${planId.replaceAll("-", "")}`);
  await checkLease?.();
  await mkdir(temporary, { mode: 0o700 });
  let total = 0;
  try {
  for (const [index, part] of segments.entries()) {
    await checkLease?.();
    signal.throwIfAborted();
    const relative = `${folder}/segment${String(index + 1).padStart(4, "0")}.mp4`;
    const file = join(temporary, `segment${String(index + 1).padStart(4, "0")}.mp4`);
    const free = await statfs(temporary);
    if (free.bavail * free.bsize < 2 * 1024 * 1024 * 1024) invalid("可用磁盘空间不足，请联系管理员", 507);
    const duration = part.endSeconds - part.startSeconds;
    // 临时与发布副本可能同时存在，单侧上限 256MiB，确保峰值不超过 512MiB 预留。
    const maximum = Math.min(100 * 1024 * 1024, 256 * 1024 * 1024 - total);
    if (maximum <= 0) invalid("本次视频片段总量超过 256 MB", 413);
    await withFileAccess([source, file], "write", async () => {
      const child = Bun.spawn([tools.ffmpeg, "-hide_banner", "-v", "error", "-nostdin", "-n", "-protocol_whitelist", "file", "-f", "mov", "-format_whitelist", "mov",
        "-enable_drefs", "0", "-use_absolute_path", "0", "-ss", String(part.startSeconds), "-i", source, "-t", String(duration), "-map", "0:V:0",
        "-map", "0:a:0?", "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-vf", "fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-movflags", "+faststart", "-fs", String(maximum), file], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true, signal,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "FFREPORT")),
      });
      if (await child.exited !== 0) invalid("视频切片失败，已生成的片段已保留", 422);
    }, signal);
    const size = (await stat(file)).size;
    if (!size || size >= maximum) invalid("视频片段为空或超过本次空间上限，已停止处理", 413);
    total += size;
    if (total > 256 * 1024 * 1024) invalid("本次视频片段总量超过 256 MB", 413);
    const measured = await inspectBackgroundVideo(file, signal);
    if (measured.duration < 1 || measured.duration > 15 || measured.fps < 16 || Math.abs(measured.duration - duration) > 0.12) {
      invalid("切片时长或帧率不符合要求，已停止处理", 422);
    }
    output.push({ path: relative, mimeType: "video/mp4", duration: measured.duration, ...part });
  }
  signal.throwIfAborted();
  await checkLease?.();
  const target = await resolveWorkspacePath(cwd, folder);
  await mkdir(target.path);
  for (const [index, part] of output.entries()) {
    await checkLease?.();
    signal.throwIfAborted();
    const free = await statfs(root.path);
    if (free.bavail * free.bsize < 2 * 1024 * 1024 * 1024) invalid("可用磁盘空间不足，请联系管理员", 507);
    const file = await resolveWorkspacePath(cwd, part.path);
    await copyFile(join(temporary, `segment${String(index + 1).padStart(4, "0")}.mp4`), file.path, constants.COPYFILE_EXCL);
  }
  return output;
  } finally {
    if (dirname(temporary) === tempRoot) await rm(temporary, { recursive: true, force: true });
  }
}

export async function mergeBackgroundVideo(cwd: string, source: string, paths: string[], outputId: string, signal: AbortSignal,
  expectedDurations?: number[], outputDirectory = "assets/generated", maxBytes = 512 * 1024 * 1024) {
  z.uuid().parse(outputId);
  if (!paths.length || paths.length > 100) invalid("合成片段数量无效");
  const original = await inspectBackgroundVideo(source, signal);
  const files = [];
  for (const path of paths) files.push((await resolveWorkspacePath(cwd, path)).path);
  const measurements: Awaited<ReturnType<typeof inspectBackgroundVideo>>[] = [];
  for (const file of files) measurements.push(await inspectBackgroundVideo(file, signal));
  const durations = expectedDurations ?? measurements.map(value => value.duration);
  if (durations.length !== paths.length || durations.some((value, index) => !Number.isFinite(value) || value < 1 || value > 15
    || measurements[index]!.duration + 0.12 < value || measurements[index]!.duration - value > 1.12)) invalid("生成片段时长不符合原时间轴，请检查结果", 409);
  const combined = durations.reduce((total, value) => total + value, 0);
  if (Math.abs(original.duration - combined) > Math.min(1, paths.length * 0.12)) invalid("片段总时长与原视频不一致，请检查生成结果", 409);
  const tools = await prepareWorkspaceFfmpeg(signal);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024 * 1024 || maxBytes > 512 * 1024 * 1024) invalid("合成空间额度不足", 413);
  const folder = await resolveWorkspacePath(cwd, outputDirectory, true);
  await mkdir(folder.path, { recursive: true });
  const disk = await statfs(folder.path);
  if (disk.bavail * disk.bsize < 2 * 1024 * 1024 * 1024) invalid("可用磁盘空间不足，请联系管理员", 507);
  const relative = `${outputDirectory}/backgroundResult${outputId.replaceAll("-", "")}.mp4`;
  const target = await resolveWorkspacePath(cwd, relative);
  const width = original.width + original.width % 2, height = original.height + original.height % 2;
  // 上游只支持整秒输出；仅裁掉生成片段多出的尾帧，原片时间轴完整保留。
  const filters = files.map((_file, index) => `[${index}:v]trim=duration=${durations[index]},fps=30,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS[v${index}]`);
  filters.push(`${files.map((_file, index) => `[v${index}]`).join("")}concat=n=${files.length}:v=1:a=0[v]`);
  const args = files.flatMap(file => ["-protocol_whitelist", "file", "-f", "mov", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", file]);
  args.push("-protocol_whitelist", "file", "-f", "mov", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", source);
  await withFileAccess([...files, source, target.path], "write", async () => {
    const child = Bun.spawn([tools.ffmpeg, "-hide_banner", "-v", "error", "-nostdin", "-n", ...args, "-filter_complex", filters.join(";"),
      "-map", "[v]", "-map", `${files.length}:a:0?`, "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-movflags", "+faststart", "-map_metadata", "-1", "-fs", String(maxBytes), target.path], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true, signal,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "FFREPORT")),
    });
    if (await child.exited !== 0) invalid("视频合成失败，原片及分段均已保留", 422);
  }, signal);
  if ((await stat(target.path)).size >= maxBytes) invalid("合成结果超过空间额度，请调整素材", 413);
  const result = await inspectBackgroundVideo(target.path, signal);
  if (Math.abs(result.duration - original.duration) > Math.min(1, paths.length * 0.12)) invalid("合成结果时长不一致，请检查保留的文件", 422);
  return { path: relative, mimeType: "video/mp4" as const, duration: result.duration };
}
