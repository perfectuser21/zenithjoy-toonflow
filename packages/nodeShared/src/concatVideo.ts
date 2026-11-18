import {
  BlobSource, BufferTarget, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource,
  Input, MP4, Mp4OutputFormat, Output, QTFF,
  type EncodedPacket, type InputTrack,
} from "mediabunny";

const workspaceFileLimit = 100 * 1024 * 1024;
export const maxConcatClips = 6;

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
  if (audio && audioConfig) {
    const audioStart = Math.max(0, await audio.getFirstTimestamp());
    const audioEnd = await audio.computeDuration();
    // A gap between AAC packets cannot be represented by stretching encoded AAC samples.
    const sampleDuration = 1 / audioConfig.sampleRate;
    if (Math.abs(start - audioStart) > sampleDuration || Math.abs(end - audioEnd) > sampleDuration) {
      throw new Error(`${label} 的原声与画面起止时间不同，请导出音画对齐的片段后再拼接`);
    }
  }

  const transformationMatrix = await video.getTransformationMatrix();
  const aspect = await video.getPixelAspectRatio();
  const fingerprint = JSON.stringify({ videoConfig, audioConfig, transformationMatrix, aspect }, (key, value) => {
    if (key !== "description" || !value) return value;
    const bytes = ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value);
    return Array.from(bytes);
  });
  return { video, audio, videoConfig, audioConfig, transformationMatrix, start, duration, fingerprint };
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
  let payloadBytes = 0;
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
      payloadBytes += packet.byteLength;
      if (payloadBytes > workspaceFileLimit) throw new Error("成片超过工作区单文件 100 MB 限制");
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
    const incompatible = segments.findIndex(clip => clip.fingerprint !== first.fingerprint);
    if (incompatible !== -1) {
      throw new Error(`第 ${incompatible + 1} 段的编码参数不同，请统一分辨率、方向、H.264 编码设置和 AAC 音轨后重试`);
    }
    const videoOutput = new EncodedVideoPacketSource("avc");
    const audioOutput = first.audio ? new EncodedAudioPacketSource("aac") : null;
    output.addVideoTrack(videoOutput, { transformationMatrix: first.transformationMatrix });
    if (audioOutput) output.addAudioTrack(audioOutput);
    await output.start();
    let offset = 0;
    for (const segment of segments) {
      await copyTrack(segment.video, segment.start, offset, packet => videoOutput.add(packet, { decoderConfig: segment.videoConfig }));
      if (audioOutput && segment.audio && segment.audioConfig) {
        const decoderConfig = segment.audioConfig;
        await copyTrack(segment.audio, segment.start, offset, packet => audioOutput.add(packet, { decoderConfig }));
      }
      offset += segment.duration;
    }
    signal?.throwIfAborted();
    await output.finalize();
    signal?.throwIfAborted();
    if (!target.buffer?.byteLength) throw new Error("合成输出为空");
    if (target.buffer.byteLength > workspaceFileLimit) throw new Error("成片超过工作区单文件 100 MB 限制");
    return new Blob([target.buffer], { type: "video/mp4" });
  } finally {
    inputs.forEach(input => input.dispose());
    if (output.state === "started") await output.cancel();
  }
}
