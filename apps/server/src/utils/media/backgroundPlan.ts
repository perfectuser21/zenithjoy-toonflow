import { constants, copyFile, mkdir, realpath, rm, stat, statfs, withFileAccess } from "@toonflow/file";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareWorkspaceFfmpeg } from "@/utils/ffmpeg";
import { resolveWorkspacePath } from "@/utils/workspace/files";
import { z } from "zod";

export const guidedShotLimit = 24;

type ExactTimeline = { fps: number; frameRate: string; frameCount: number };
type TimeSegment = { startSeconds: number; endSeconds: number };

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

export function planGuidedSegments(source: { fps: number; frameRate: string; frameCount: number; constantRate: boolean; videoStartsAtOrigin: boolean }, cuts: number[], partitionLong = false) {
  if (!source.constantRate) invalid("分镜翻拍需要固定帧率的 MP4 或 MOV", 422);
  if (!source.videoStartsAtOrigin) invalid("原视频画面与媒体起点不一致，请先导出音画起点对齐的版本", 422);
  const edges = [0, ...cuts.map(cut => Math.round(cut * source.fps)), source.frameCount];
  if (edges.some((edge, i) => !Number.isSafeInteger(edge) || i > 0 && edge <= edges[i - 1]!)) invalid("镜头切点须严格递增且落在原视频范围内");
  const maxFrames = Math.floor(15 * source.fps);
  const segments = edges.slice(0, -1).flatMap((start, i) => {
    const span = edges[i + 1]! - start;
    if (!partitionLong && span > maxFrames) invalid("单个生成片段最多 15 秒，请保留长镜头的处理分段", 422);
    const count = Math.ceil(span / maxFrames);
    return Array.from({ length: count }, (_, j) => ({
      startSeconds: (start + Math.floor(j * span / count)) / source.fps,
      endSeconds: (start + Math.floor((j + 1) * span / count)) / source.fps,
    }));
  });
  if (segments.length > guidedShotLimit) invalid(`分镜翻拍最多支持 ${guidedShotLimit} 个片段，请分批处理`);
  return segments;
}

export async function inspectBackgroundVideo(source: string, signal: AbortSignal, detect = true) {
  const sourceInfo = await stat(source);
  if (!sourceInfo.isFile() || !sourceInfo.size || sourceInfo.size > 512 * 1024 * 1024) invalid("源视频须为不超过 512 MB 的普通文件", 413);
  const paths = await prepareWorkspaceFfmpeg(signal);
  return withFileAccess([source], "read", async () => {
    const options = { stdin: "ignore" as const, stdout: "pipe" as const, stderr: "pipe" as const, windowsHide: true,
      signal, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !["FFREPORT", "TOONFLOW_TRIM_TOKEN", "TOONFLOW_TRIM_STORE_TOKEN"].includes(key.toUpperCase()))) };
    const probe = Bun.spawn([paths.ffprobe, "-v", "error", "-protocol_whitelist", "file", "-f", "mov", "-format_whitelist", "mov",
      "-enable_drefs", "0", "-use_absolute_path", "0", "-max_streams", "32", "-show_entries", "stream=codec_type,codec_name,duration,start_time,avg_frame_rate,r_frame_rate,nb_frames,width,height:stream_disposition=attached_pic:stream_side_data=rotation:format=duration,start_time", "-of", "json", source], options);
    const [out, probeExit] = await Promise.all([probe.stdout.text(), probe.exited]);
    if (probeExit !== 0 || out.length > 100000) invalid("无法读取 MP4/MOV 视频信息", 422);
    let data: { streams?: { codec_type?: string; codec_name?: string; disposition?: { attached_pic?: number }; duration?: string; start_time?: string; avg_frame_rate?: string; r_frame_rate?: string; nb_frames?: string; width?: number; height?: number; side_data_list?: { rotation?: number }[] }[]; format?: { duration?: string; start_time?: string } };
    try { data = JSON.parse(out); } catch { return invalid("视频信息无效", 422); }
    const stream = data.streams?.find(item => item.codec_type === "video" && !item.disposition?.attached_pic);
    const audioCodec = data.streams?.find(item => item.codec_type === "audio")?.codec_name;
    const duration = Number(stream?.duration ?? data.format?.duration);
    const frameRate = stream?.avg_frame_rate ?? "0/1";
    const [a, b] = frameRate.split("/").map(Number);
    const fps = a! / b!;
    if (!Number.isFinite(fps) || fps < 16) invalid("视频帧率须至少为 16 帧/秒", 422);
    if (!Number.isFinite(duration) || duration < 1 || duration > 120) invalid("视频时长须在 1 到 120 秒之间", 422);
    const width = stream?.width ?? 0, height = stream?.height ?? 0;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 3840 || height > 3840 || width * height > 8294400) invalid("视频分辨率超过支持范围", 422);
    const frameCount = Number(stream?.nb_frames);
    const swapDimensions = stream?.side_data_list?.some(item => Math.abs(item.rotation ?? 0) % 180 === 90);
    const displayWidth = swapDimensions ? height : width;
    const displayHeight = swapDimensions ? width : height;
    const videoStartsAtOrigin = Math.abs(Number(stream?.start_time) - Number(data.format?.start_time)) <= 0.001;
    const nominalRate = (stream?.r_frame_rate ?? "0/1").split("/").map(Number);
    const constantRate = /^\d{1,8}\/\d{1,8}$/.test(frameRate) && fps <= 120 && Math.abs(fps - nominalRate[0]! / nominalRate[1]!) < 1e-6
      && Number.isSafeInteger(frameCount) && frameCount > 0 && Math.abs(duration * fps - frameCount) < 0.15;
    if (!detect) return { duration, fps, width, height, displayWidth, displayHeight, audioCodec, frameRate, frameCount, constantRate, videoStartsAtOrigin, timestamps: [] as number[], segments: [] as TimeSegment[] };
    const command = Bun.spawn([paths.ffmpeg, "-hide_banner", "-nostdin", "-protocol_whitelist", "file", "-f", "mov", "-format_whitelist", "mov",
      "-enable_drefs", "0", "-use_absolute_path", "0", "-i", source, "-an", "-vf", "setpts=PTS-STARTPTS,select=gt(scene\\,0.3),showinfo", "-f", "null", "-"],
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
    return { duration, fps, width, height, displayWidth, displayHeight, audioCodec, frameRate, frameCount, constantRate, videoStartsAtOrigin, timestamps, segments: planBackgroundSegments(duration, timestamps) };
  }, signal);
}

// 先在私有临时目录切片；成功后独占发布，失败只清理本次临时目录。
export async function splitBackgroundVideo(cwd: string, source: string, planId: string,
  segments: TimeSegment[], signal: AbortSignal, checkLease?: () => Promise<void>, timeline?: ExactTimeline) {
  z.uuid().parse(planId);
  if (!segments.length || segments.length > 24 || segments[0]?.startSeconds !== 0 || segments.some((part, index) =>
    !Number.isFinite(part.startSeconds) || !Number.isFinite(part.endSeconds) || part.endSeconds - part.startSeconds < (timeline ? 1 / (timeline.fps + 0.01) : 1)
      || part.endSeconds - part.startSeconds > 15 + 1e-8 || index > 0 && part.startSeconds !== segments[index - 1]!.endSeconds)) invalid("分段时间轴无效");
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
    const startFrame = timeline ? Math.round(part.startSeconds * timeline.fps) : 0;
    const frameCount = timeline ? Math.round(part.endSeconds * timeline.fps) - startFrame : 0;
    const inputFrames = timeline ? Math.max(frameCount, Math.ceil(timeline.fps * 2)) : 0;
    const seek = timeline ? Math.max(0, part.startSeconds - 0.00001) : part.startSeconds;
    const durationOptions = timeline ? ["-frames:v", String(inputFrames), "-an"] : ["-t", String(duration), "-map", "0:a:0?", "-c:a", "aac"];
    const filter = timeline ? `fps=${timeline.frameRate}:start_time=0,trim=end_frame=${frameCount},tpad=stop=${inputFrames-frameCount}:stop_mode=clone,pad=ceil(iw/2)*2:ceil(ih/2)*2`
      : "fps=30,pad=ceil(iw/2)*2:ceil(ih/2)*2";
    await withFileAccess([source, file], "write", async () => {
      const child = Bun.spawn([tools.ffmpeg, "-hide_banner", "-v", "error", "-nostdin", "-n", "-protocol_whitelist", "file", "-f", "mov", "-format_whitelist", "mov",
        "-enable_drefs", "0", "-use_absolute_path", "0", "-ss", String(seek), "-i", source, "-map", "0:V:0", ...durationOptions,
        "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-vf", filter, "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-fs", String(maximum), file], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true, signal,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !["FFREPORT", "TOONFLOW_TRIM_TOKEN", "TOONFLOW_TRIM_STORE_TOKEN"].includes(key.toUpperCase()))),
      });
      if (await child.exited !== 0) invalid("视频切片失败，已生成的片段已保留", 422);
    }, signal);
    const size = (await stat(file)).size;
    if (!size || size >= maximum) invalid("视频片段为空或超过本次空间上限，已停止处理", 413);
    total += size;
    if (total > 256 * 1024 * 1024) invalid("本次视频片段总量超过 256 MB", 413);
    const measured = await inspectBackgroundVideo(file, signal, false);
    if (timeline ? measured.frameCount !== inputFrames : measured.duration < 1 || measured.duration > 15 || measured.fps < 16 || Math.abs(measured.duration - duration) > 0.12) {
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
  expectedDurations?: number[], outputDirectory = "assets/generated", maxBytes = 512 * 1024 * 1024, timeline?: ExactTimeline) {
  z.uuid().parse(outputId);
  if (!paths.length || paths.length > 100) invalid("合成片段数量无效");
  const original = await inspectBackgroundVideo(source, signal, false);
  const files = [];
  for (const path of paths) files.push((await resolveWorkspacePath(cwd, path)).path);
  const measurements: Awaited<ReturnType<typeof inspectBackgroundVideo>>[] = [];
  for (const file of files) measurements.push(await inspectBackgroundVideo(file, signal, false));
  const durations = expectedDurations ?? measurements.map(value => value.duration);
  if (durations.length !== paths.length || durations.some((value, index) => !Number.isFinite(value) || value < (timeline ? 1 / (timeline.fps + 0.01) : 1) || value > 15 + 1e-8
    || (timeline ? measurements[index]!.duration + 0.5 / timeline.fps < value : measurements[index]!.duration + 0.12 < value || measurements[index]!.duration - value > 1.12))) invalid("生成片段时长不符合原时间轴，请检查结果", 409);
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
  const sourceWidth = timeline ? original.displayWidth : original.width;
  const sourceHeight = timeline ? original.displayHeight : original.height;
  const width = sourceWidth + sourceWidth % 2, height = sourceHeight + sourceHeight % 2;
  // 上游只支持整秒输出；仅裁掉生成片段多出的尾帧，原片时间轴完整保留。
  const filters = files.map((_file, index) => {
    const duration = durations[index]!;
    const timing = timeline ? `fps=${timeline.frameRate}:start_time=0,trim=end_frame=${Math.round(duration * timeline.fps)}` : `trim=duration=${duration},fps=30`;
    return `[${index}:v]${timing},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS-STARTPTS[v${index}]`;
  });
  const joined = files.map((_file, index) => `[v${index}]`).join("");
  const clock = timeline ? `,setpts=N/(${timeline.fps}*TB)` : "";
  filters.push(`${joined}concat=n=${files.length}:v=1:a=0${clock}[v]`);
  const args = files.flatMap(file => ["-protocol_whitelist", "file", "-f", "mov", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", file]);
  args.push("-protocol_whitelist", "file", "-f", "mov", "-format_whitelist", "mov", "-enable_drefs", "0", "-use_absolute_path", "0", "-i", source);
  await withFileAccess([...files, source, target.path], "write", async () => {
    const child = Bun.spawn([tools.ffmpeg, "-hide_banner", "-v", "error", "-nostdin", "-n", ...args, "-filter_complex", filters.join(";"),
      "-map", "[v]", "-map", `${files.length}:a:0?`, "-c:v", "libx264", "-preset", "fast", "-crf", "20", "-pix_fmt", "yuv420p",
      "-c:a", timeline && [undefined, "aac", "mp3", "alac", "ac3", "eac3", "opus"].includes(original.audioCodec) ? "copy" : "aac", ...(timeline ? ["-r", timeline.frameRate] : []), "-movflags", "+faststart", "-map_metadata", "-1", "-fs", String(maxBytes), target.path], {
      stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true, signal,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !["FFREPORT", "TOONFLOW_TRIM_TOKEN", "TOONFLOW_TRIM_STORE_TOKEN"].includes(key.toUpperCase()))),
    });
    if (await child.exited !== 0) invalid("视频合成失败，原片及分段均已保留", 422);
  }, signal);
  if ((await stat(target.path)).size >= maxBytes) invalid("合成结果超过空间额度，请调整素材", 413);
  const result = await inspectBackgroundVideo(target.path, signal, false);
  if (timeline ? result.frameCount !== timeline.frameCount || result.frameRate !== timeline.frameRate || result.displayWidth !== width || result.displayHeight !== height : Math.abs(result.duration - original.duration) > Math.min(1, paths.length * 0.12)) invalid("合成结果时长不一致，请检查保留的文件", 422);
  return { path: relative, mimeType: "video/mp4" as const, duration: result.duration };
}
