import {
  AdtsOutputFormat, AudioSample, AudioSampleSink, AudioSampleSource, BlobSource, BufferTarget, CanvasSink,
  EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource,
  canEncodeAudio, canEncodeVideo, Input, MP4, Mp4OutputFormat, NullTarget, Output, QTFF, QUALITY_HIGH, VideoSample, VideoSampleSource, WavOutputFormat,
  type EncodedPacket, type InputTrack,
} from "mediabunny";
import type { WorkspaceFiles } from "@toonflow/nodes-scaffold/runtime";

const workspaceFileLimit = 100 * 1024 * 1024;
export const maxConcatClips = 6;

export async function prepareConcatClip(
  { blob, workspace, path }: { blob: Blob; workspace: Pick<WorkspaceFiles, "normalizeVideo">; path: string },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!blob.size || blob.size > workspaceFileLimit) throw new Error("每个视频须为不超过 100 MB 的非空文件");
  const input = new Input({ source: new BlobSource(blob), formats: [MP4, QTFF] });
  try {
    if (await input.canRead()) {
      const [videos, audios] = await Promise.all([input.getVideoTracks(), input.getAudioTracks()]);
      if (videos.length === 1 && await videos[0]?.getCodec() === "avc"
        && (audios.length === 0 || audios.length === 1 && await audios[0]?.getCodec() === "aac")) return blob;
    }
  } finally { input.dispose(); }

  if (!workspace.normalizeVideo) throw new Error("当前画布不支持转换素材编码");
  try {
    return await workspace.normalizeVideo(path, signal);
  } catch (error) {
    signal.throwIfAborted();
    const response = error && typeof error === "object" && "response" in error ? error.response : undefined;
    const data = response && typeof response === "object" && "data" in response ? response.data : undefined;
    const reason: unknown = data instanceof Blob ? await data.text().then(JSON.parse).catch(() => null) : data;
    const message = reason && typeof reason === "object" && "message" in reason && typeof reason.message === "string" ? reason.message : "";
    throw new Error(message || "无法转换素材编码", { cause: error });
  }
}

async function inspectClip(input: Input, position: number) {
  const label = `第 ${position} 段`;
  if (!await input.canRead()) throw new Error(`${label} 无法读取，请使用 MP4 或 MOV`);
  const videos = await input.getVideoTracks();
  const audios = await input.getAudioTracks();
  const video = videos[0];
  const audio = audios[0];
  if (!video || videos.length !== 1 || await video.getCodec() !== "avc") {
    throw new Error(`${label} 需要一条 H.264 视频轨`);
  }
  if (audios.length > 1 || (audio && await audio.getCodec() !== "aac")) {
    throw new Error(`${label} 仅支持单条 AAC 原声音轨或无声素材`);
  }
  const videoConfig = await video.getDecoderConfig();
  const audioConfig = audio ? await audio.getDecoderConfig() : null;
  if (!videoConfig?.description || (audio && !audioConfig?.description)) {
    throw new Error(`${label} 缺少音视频解码参数，请重新导出素材`);
  }
  const firstFrame = await new EncodedPacketSink(video).getFirstPacket({ verifyKeyPackets: true });
  if (!firstFrame || firstFrame.type !== "key" || firstFrame.timestamp < 0) {
    throw new Error(`${label} 需要从可独立播放的关键帧开始，请重新导出素材`);
  }

  const start = await video.getFirstTimestamp();
  const end = await video.computeDuration();
  const duration = end - start;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`${label} 的播放时长无效`);
  let fitAudio = false;
  let audioEnd = end;
  if (audio && audioConfig) {
    const audioStart = Math.max(0, await audio.getFirstTimestamp());
    audioEnd = await audio.computeDuration();
    const sampleDuration = 1 / audioConfig.sampleRate;
    const boundary = await new EncodedPacketSink(audio).getPacket(start, { metadataOnly: true });
    fitAudio = Math.abs(start - audioStart) > sampleDuration || Math.abs(end - audioEnd) > sampleDuration
      || !!(boundary && boundary.timestamp < start && boundary.microsecondTimestamp + boundary.microsecondDuration > Math.round(start * 1e6));
  }

  const transformationMatrix = await video.getTransformationMatrix();
  const aspect = await video.getPixelAspectRatio();
  return {
    video, audio, videoConfig, audioConfig, transformationMatrix, start, duration, audioEnd, fitAudio,
    videoFingerprint: codecFingerprint({ videoConfig, transformationMatrix, aspect }),
    audioFingerprint: codecFingerprint(audioConfig),
  };
}

function codecFingerprint(config: unknown) {
  return JSON.stringify(config, (key, value) => {
    if (key !== "description" || !value) return value;
    const bytes = ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value);
    return Array.from(bytes);
  });
}

type Segment = Awaited<ReturnType<typeof inspectClip>>;
type AudioFormat = Pick<AudioDecoderConfig, "sampleRate" | "numberOfChannels">;

async function writeFittedAudio(
  segment: Segment,
  offset: number,
  output: AudioSampleSource,
  { sampleRate, numberOfChannels }: AudioFormat,
  signal?: AbortSignal,
) {
  const { audio, audioConfig, start, duration, audioEnd } = segment;
  let cursor = Math.round(offset * sampleRate);
  const end = Math.round((offset + duration) * sampleRate);
  const soundEnd = Math.min(end, Math.round((offset + audioEnd - start) * sampleRate));

  async function padTo(frame: number) {
    while (cursor < frame) {
      signal?.throwIfAborted();
      const count = Math.min(frame - cursor, sampleRate);
      const silence = new AudioSample({ format: "f32", data: new Float32Array(count * numberOfChannels), sampleRate, numberOfChannels, timestamp: cursor / sampleRate });
      try { await output.add(silence); } finally { silence.close(); }
      cursor += count;
    }
  }

  async function writeSample(sample: AudioSample) {
    signal?.throwIfAborted();
    const frame = Math.round((offset + sample.timestamp - start) * sampleRate);
    await padTo(Math.min(end, frame));
    const from = Math.max(0, cursor - frame);
    const to = Math.min(sample.numberOfFrames, soundEnd - frame);
    if (to <= from) return;
    const slice = sample.trim(from, to);
    try {
      slice.setTimestamp(cursor / sampleRate);
      await output.add(slice);
    } finally { slice.close(); }
    cursor += to - from;
  }

  if (audio && audioConfig) {
    const samples = new AudioSampleSink(audio).samples(undefined, Math.min(audioEnd, start + duration));
    if (audioConfig.sampleRate === sampleRate && audioConfig.numberOfChannels === numberOfChannels) {
      for await (const sample of samples) {
        try { await writeSample(sample); } finally { sample.close(); }
      }
    } else {
      await resampleAudio(samples, { sampleRate, numberOfChannels }, writeSample, signal);
    }
  }
  await padTo(end);
}

async function resampleAudio(
  samples: AsyncIterable<AudioSample>,
  format: AudioFormat,
  writeSample: (sample: AudioSample) => Promise<void>,
  signal?: AbortSignal,
) {
  const converter = new Output({ format: new WavOutputFormat(), target: new NullTarget() });
  const source = new AudioSampleSource({
    codec: "pcm-f32",
    transform: { ...format, async process(sample) {
      await writeSample(sample);
      return null;
    } },
  });
  converter.addAudioTrack(source, { decoderConfig: { codec: "pcm-f32", ...format } });
  try {
    await converter.start();
    for await (const sample of samples) {
      try {
        signal?.throwIfAborted();
        await source.add(sample);
      } finally { sample.close(); }
    }
    await converter.finalize();
  } finally {
    if (converter.state === "started") await converter.cancel();
  }
}

async function createVideoRenderer(first: Segment, countBytes: (size: number) => void) {
  const width = Math.ceil(await first.video.getDisplayWidth() / 2) * 2;
  const height = Math.ceil(await first.video.getDisplayHeight() / 2) * 2;
  if (!await canEncodeVideo("avc", { width, height, quality: QUALITY_HIGH })) {
    throw new Error("当前浏览器不支持以首段尺寸编码 H.264 视频，请换一个浏览器后重试");
  }
  const source = new VideoSampleSource({
    codec: "avc",
    quality: QUALITY_HIGH,
    onEncodedPacket(packet) { countBytes(packet.byteLength); },
  });

  return { source, async write(segment: Segment, offset: number, signal?: AbortSignal) {
    const sink = new CanvasSink(segment.video, { width, height, fit: "contain", poolSize: 2 });
    let firstFrame = true;
    for await (const frame of sink.canvases(segment.start, segment.start + segment.duration)) {
      signal?.throwIfAborted();
      const elapsed = frame.timestamp - segment.start;
      const sample = new VideoSample(frame.canvas, {
        timestamp: offset + elapsed,
        duration: Math.min(frame.duration, segment.duration - elapsed),
      });
      try { await source.add(sample, { keyFrame: firstFrame }); } finally { sample.close(); }
      firstFrame = false;
    }
    if (firstFrame) throw new Error("素材轨道没有可拼接的画面");
  } };
}

export async function concatVideo(clips: readonly Blob[], signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  if (clips.length < 2 || clips.length > maxConcatClips) throw new Error("请选择 2 至 6 个视频片段");
  if (clips.some(clip => !clip.size || clip.size > workspaceFileLimit)) {
    throw new Error("每个视频须为不超过 100 MB 的非空文件");
  }

  const inputs = clips.map(blob => new Input({ source: new BlobSource(blob), formats: [MP4, QTFF] }));
  const target = new BufferTarget();
  const output = new Output({ format: new Mp4OutputFormat(), target });
  let audioEncoder: Output | undefined;
  let payloadBytes = 0;
  function countBytes(size: number) {
    payloadBytes += size;
    if (payloadBytes > workspaceFileLimit) throw new Error("成片超过工作区单文件 100 MB 限制");
  }
  async function copyTrack(track: InputTrack, start: number, offset: number, write: (packet: EncodedPacket) => Promise<void>) {
    let copied = false;
    for await (const packet of new EncodedPacketSink(track).packets()) {
      signal?.throwIfAborted();
      // AAC priming packets preceding the edit list must not reappear between clips.
      if (packet.timestamp < start) {
        if (track.isVideoTrack()) throw new Error("素材包含剪切点前的依赖画面，请重新导出素材");
        if (packet.microsecondTimestamp + packet.microsecondDuration > Math.round(start * 1_000_000)) {
          throw new Error("剪切点位于音频采样包中间，请重新导出素材后拼接");
        }
        continue;
      }
      countBytes(packet.byteLength);
      await write(packet.clone({ timestamp: offset + packet.timestamp - start }));
      copied = true;
    }
    if (!copied) throw new Error("素材轨道没有可拼接的音视频数据");
  }

  try {
    const segments = [];
    for (const [index, input] of inputs.entries()) {
      signal?.throwIfAborted();
      segments.push(await inspectClip(input, index + 1));
    }
    const first = segments[0]!;
    const renderer = segments.some(clip => clip.videoFingerprint !== first.videoFingerprint)
      ? await createVideoRenderer(first, countBytes)
      : undefined;
    const videoOutput = renderer ? null : new EncodedVideoPacketSource("avc");
    const firstWithAudio = segments.find(clip => clip.audioConfig);
    const audioConfig = firstWithAudio?.audioConfig;
    const audioOutput = audioConfig ? new EncodedAudioPacketSource("aac") : null;
    const totalDuration = segments.reduce((sum, segment) => sum + segment.duration, 0);
    const packets: { packet: EncodedPacket; meta?: EncodedAudioChunkMetadata }[] = [];
    let fittedAudio: AudioSampleSource | undefined;
    if (audioConfig && segments.some(clip => clip.fitAudio || clip.audioFingerprint !== firstWithAudio?.audioFingerprint)) {
      const { sampleRate, numberOfChannels } = audioConfig;
      if (!await canEncodeAudio("aac", { sampleRate, numberOfChannels, quality: QUALITY_HIGH })) {
        const { registerAacEncoder } = await import("@mediabunny/aac-encoder");
        registerAacEncoder();
      }
      // AAC encoders emit priming and trailing packets; retain priming but end the MP4 track at the final picture.
      audioEncoder = new Output({ format: new AdtsOutputFormat(), target: new NullTarget() });
      fittedAudio = new AudioSampleSource({ codec: "aac", quality: QUALITY_HIGH, onEncodedPacket(packet, meta) {
        if (packet.timestamp >= totalDuration) return;
        countBytes(packet.byteLength);
        const duration = Math.min(packet.duration, totalDuration - packet.timestamp);
        packets.push({ packet: packet.clone({ duration }), meta });
      } });
      audioEncoder.addAudioTrack(fittedAudio);
      await audioEncoder.start();
    }
    if (renderer) output.addVideoTrack(renderer.source);
    else if (videoOutput) output.addVideoTrack(videoOutput, { transformationMatrix: first.transformationMatrix });
    if (audioOutput) output.addAudioTrack(audioOutput);
    await output.start();
    let offset = 0;
    for (const segment of segments) {
      if (renderer) await renderer.write(segment, offset, signal);
      else if (videoOutput) {
        await copyTrack(segment.video, segment.start, offset, packet => videoOutput.add(packet, { decoderConfig: segment.videoConfig }));
      }
      if (fittedAudio && audioConfig) await writeFittedAudio(segment, offset, fittedAudio, audioConfig, signal);
      else if (audioOutput && segment.audio && segment.audioConfig) {
        const decoderConfig = segment.audioConfig;
        await copyTrack(segment.audio, segment.start, offset, packet => audioOutput.add(packet, { decoderConfig }));
      }
      offset += segment.duration;
    }
    signal?.throwIfAborted();
    if (audioEncoder && audioOutput) {
      await audioEncoder.finalize();
      for (const { packet, meta } of packets) {
        signal?.throwIfAborted();
        await audioOutput.add(packet, meta);
      }
    }
    await output.finalize();
    signal?.throwIfAborted();
    if (!target.buffer?.byteLength) throw new Error("合成输出为空");
    if (target.buffer.byteLength > workspaceFileLimit) throw new Error("成片超过工作区单文件 100 MB 限制");
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally {
    inputs.forEach(input => input.dispose());
    if (audioEncoder?.state === "started") await audioEncoder.cancel();
    if (output.state === "started") await output.cancel();
  }
}
