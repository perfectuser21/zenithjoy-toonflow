import {
  AdtsOutputFormat, AudioSample, AudioSampleSink, AudioSampleSource, BlobSource, BufferTarget, EncodedAudioPacketSource, EncodedPacketSink, EncodedVideoPacketSource,
  Input, MP4, Mp4OutputFormat, NullTarget, Output, QTFF, QUALITY_HIGH,
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
  const fingerprint = JSON.stringify({ videoConfig, audioConfig, transformationMatrix, aspect }, (key, value) => {
    if (key !== "description" || !value) return value;
    const bytes = ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new Uint8Array(value);
    return Array.from(bytes);
  });
  return { video, audio, videoConfig, audioConfig, transformationMatrix, start, duration, audioEnd, fingerprint, fitAudio };
}

async function writeFittedAudio(segment: Awaited<ReturnType<typeof inspectClip>>, offset: number, output: AudioSampleSource, signal?: AbortSignal) {
  const { audio, audioConfig, start, duration } = segment;
  if (!audio || !audioConfig) return;
  const { sampleRate, numberOfChannels } = audioConfig;
  let cursor = Math.round(offset * sampleRate);
  const end = Math.round((offset + duration) * sampleRate);
  const soundEnd = Math.min(end, Math.round((offset + segment.audioEnd - start) * sampleRate));

  async function padTo(frame: number) {
    while (cursor < frame) {
      signal?.throwIfAborted();
      const count = Math.min(frame - cursor, sampleRate);
      const silence = new AudioSample({ format: "f32", data: new Float32Array(count * numberOfChannels), sampleRate, numberOfChannels, timestamp: cursor / sampleRate });
      try { await output.add(silence); } finally { silence.close(); }
      cursor += count;
    }
  }

  for await (const sample of new AudioSampleSink(audio).samples(undefined, Math.min(segment.audioEnd, start + duration))) {
    try {
      signal?.throwIfAborted();
      const frame = Math.round((offset + sample.timestamp - start) * sampleRate);
      await padTo(Math.min(end, frame));
      const from = Math.max(0, cursor - frame);
      const to = Math.min(sample.numberOfFrames, soundEnd - frame);
      if (to <= from) continue;
      const slice = sample.trim(from, to);
      try {
        slice.setTimestamp(cursor / sampleRate);
        await output.add(slice);
      } finally { slice.close(); }
      cursor += to - from;
    } finally { sample.close(); }
  }
  await padTo(end);
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
    const incompatible = segments.findIndex(clip => clip.fingerprint !== first.fingerprint);
    if (incompatible !== -1) {
      throw new Error(`第 ${incompatible + 1} 段的编码参数不同，请统一分辨率、方向、H.264 编码设置和 AAC 音轨后重试`);
    }
    const videoOutput = new EncodedVideoPacketSource("avc");
    const audioOutput = first.audio ? new EncodedAudioPacketSource("aac") : null;
    const totalDuration = segments.reduce((sum, segment) => sum + segment.duration, 0);
    const packets: { packet: EncodedPacket; meta?: EncodedAudioChunkMetadata }[] = [];
    let fittedAudio: AudioSampleSource | undefined;
    if (segments.some(clip => clip.fitAudio)) {
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
    output.addVideoTrack(videoOutput, { transformationMatrix: first.transformationMatrix });
    if (audioOutput) output.addAudioTrack(audioOutput);
    await output.start();
    let offset = 0;
    for (const segment of segments) {
      await copyTrack(segment.video, segment.start, offset, packet => videoOutput.add(packet, { decoderConfig: segment.videoConfig }));
      if (fittedAudio) await writeFittedAudio(segment, offset, fittedAudio, signal);
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
