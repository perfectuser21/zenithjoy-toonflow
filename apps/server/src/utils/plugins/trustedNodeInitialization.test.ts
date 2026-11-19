import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "@toonflow/file";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { combinationCount, combinationAt, renderBatch, type MashupClip } from "../../../../../packages/nodes/mashupNode/src/mashupBatch";
import { initializeTrustedNodes, trustedNodeNames } from "./initialize";

test("existing workspaces receive trusted nodes from each release", async () => {
  const root = await mkdtemp(join(tmpdir(), "toonflowTrustedNodes"));
  try {
    const source = join(root, "build");
    const target = join(root, "nodes");
    await mkdir(source);
    await mkdir(target);
    const nodeFiles = Object.keys(trustedNodeNames).map(name => `${name}.umd.js`);
    expect(trustedNodeNames.videoConcatNode).toBe("合成成片");
    for (const file of nodeFiles) {
      await writeFile(join(source, file), `candidate:${file}`);
      await writeFile(join(target, file), `old:${file}`);
    }
    await writeFile(join(target, "initialized"), "existing workspace");
    await writeFile(join(target, "textNode.disabled"), "");
    await writeFile(join(source, "customNode.umd.js"), "bundled");
    await writeFile(join(target, "customNode.umd.js"), "customized");
    await initializeTrustedNodes(target, source);
    for (const file of nodeFiles) {
      expect(await readFile(join(target, file), "utf8")).toBe(`candidate:${file}`);
    }
    await writeFile(join(source, "videoNode.umd.js"), "next release");
    await initializeTrustedNodes(target, source);
    expect(await readFile(join(target, "videoNode.umd.js"), "utf8")).toBe("next release");
    expect(await readFile(join(target, "customNode.umd.js"), "utf8")).toBe("customized");
    expect(await readFile(join(target, "initialized"), "utf8")).toBe("existing workspace");
    expect(await readFile(join(target, "textNode.disabled"), "utf8")).toBe("");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function group(prefix: string, count: number): MashupClip[] {
  return Array.from({ length: count }, (_, index) => ({ name: prefix + index, url: prefix + index, mimeType: "video/mp4" }));
}

test("five ordered groups produce 108 distinct combinations and can stop after 102", async () => {
  const groups = [group("A", 3), group("B", 3), group("C", 3), group("D", 2), group("eval", 2)];
  expect(combinationCount(groups)).toBe(108);
  const rendered: string[] = [];
  await renderBatch(groups, 102, 0, async (clips) => { rendered.push(clips.map(clip => clip.name).join("-")); });
  expect(new Set(rendered).size).toBe(102);
  expect(rendered[0]).toBe("A0-B0-C0-D0-eval0");
  expect(combinationAt(groups, 107).map(clip => clip.name)).toEqual(["A2", "B2", "C2", "D1", "eval1"]);
});

test("resumes after the last persisted result, and refuses empty groups or an invalid limit", async () => {
  const groups = [group("A", 2), group("B", 2)];
  const completed: string[] = [];
  const record = async (clips: MashupClip[], index: number) => {
    if (index === 2 && completed.length === 2) throw Error("save failed");
    completed.push(clips.map(clip => clip.name).join("-"));
  };
  await expect(renderBatch(groups, 4, 0, record)).rejects.toThrow("save failed");
  await renderBatch(groups, 4, completed.length, async clips => { completed.push(clips.map(clip => clip.name).join("-")); });
  expect(completed).toEqual(["A0-B0", "A0-B1", "A1-B0", "A1-B1"]);
  expect(combinationCount([[], groups[1]])).toBe(0);
  await expect(renderBatch(groups, 5, 0, record)).rejects.toThrow();
});


test("the four exported MP4s contain the selected pictures and original audio in playback order", async () => {
  const { concatVideo } = await import("../../../../../packages/nodeShared/src/concatVideo");
  const root = await mkdtemp(join(tmpdir(), "toonflowMashupMedia"));
  const colors = ["red", "lime", "blue", "yellow"];
  const tones = [330, 440, 550, 660];
  const ffmpeg = (...args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", ...args]);
  try {
    const sources: Blob[] = [];
    const pixels: Buffer[] = [];
    const samplePicture = (path: string, seconds: number) => ffmpeg("-ss", String(seconds), "-i", path, "-frames:v", "1",
      "-vf", "scale=1:1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1");
    for (const [index, color] of colors.entries()) {
      const path = join(root, `source${index}.mp4`);
      ffmpeg("-f", "lavfi", "-i", `color=${color}:size=64x64:rate=12`, "-f", "lavfi", "-i",
        `sine=frequency=${tones[index]}:sample_rate=48000`, "-t", "1", "-c:v", "libx264", "-c:a", "aac", path);
      sources.push(new Blob([new Uint8Array(await readFile(path))], { type: "video/mp4" }));
      pixels.push(samplePicture(path, 0.3));
    }
    for (const a of [0, 1]) for (const b of [2, 3]) {
      const merged = await concatVideo([sources[a]!, sources[b]!]);
      const path = join(root, `output${a}${b}.mp4`);
      await writeFile(path, new Uint8Array(await merged.arrayBuffer()));
      const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", path], { encoding: "utf8" }).trim());
      expect(Math.abs(duration - 2)).toBeLessThan(0.15);
      for (const [segment, input] of [a, b].entries()) {
        const time = segment + 0.3;
        expect(samplePicture(path, time).equals(pixels[input]!)).toBe(true);
        const samples = ffmpeg("-ss", String(time), "-i", path, "-t", "0.25", "-vn", "-ac", "1",
          "-ar", "8000", "-f", "s16le", "pipe:1");
        expect(samples.length).toBe(4000);
        let crossings = 0;
        for (let offset = 2; offset < samples.length; offset += 2) {
          if (samples.readInt16LE(offset - 2) < 0 && samples.readInt16LE(offset) >= 0) crossings++;
        }
        expect(Math.abs(crossings / 0.25 - tones[input]!)).toBeLessThan(10);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

test("short, overlong and delayed AAC each stay inside their own video segment", async () => {
  const { concatVideo } = await import("../../../../../packages/nodeShared/src/concatVideo");
  const root = await mkdtemp(join(tmpdir(), "toonflowConcatAudio"));
  const ffmpeg = (...args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", ...args]);
  try {
    const sources: Blob[] = [];
    for (const [color, tone, length, delay] of [
      ["red", "330", "0.45", "0"],
      ["lime", "550", "1.45", "0"],
      ["blue", "770", "0.65", "0.35"],
    ]) {
      const path = join(root, color + ".mp4");
      ffmpeg("-f", "lavfi", "-i", `color=${color}:size=64x64:rate=25:duration=1`,
        "-itsoffset", delay!, "-f", "lavfi", "-i", `sine=frequency=${tone}:sample_rate=48000:duration=${length}`,
        "-c:v", "libx264", "-c:a", "aac", path);
      sources.push(new Blob([new Uint8Array(await readFile(path))], { type: "video/mp4" }));
    }
    const path = join(root, "merged.mp4");
    await writeFile(path, new Uint8Array(await (await concatVideo(sources)).arrayBuffer()));
    const duration = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1", path], { encoding: "utf8" }));
    expect(Math.abs(duration - 3)).toBeLessThan(0.045);
    // Decode the entire stream once. Seeking each window independently could hide a discontinuity at a seam.
    const pcm = ffmpeg("-i", path, "-vn", "-af", "aresample=8000:async=1:first_pts=0",
      "-ac", "1", "-f", "s16le", "pipe:1");
    for (const [time, hz] of [[0.10, 330], [0.70, 0], [1.10, 550], [1.80, 550], [2.10, 0], [2.65, 770]] as const) {
      const start = Math.round(time * 8000);
      const length = 800;
      expect(pcm.length).toBeGreaterThanOrEqual(2 * (start + length));
      let peak = 0;
      let crossings = 0;
      for (let i = start; i < start + length; i++) {
        const sample = pcm.readInt16LE(i * 2);
        peak = Math.max(peak, Math.abs(sample));
        if (pcm.readInt16LE((i - 1) * 2) < 0 && sample >= 0) crossings++;
      }
      if (hz === 0) expect(peak).toBeLessThan(100);
      else {
        expect(peak).toBeGreaterThan(1000);
        expect(Math.abs(crossings * 10 - hz)).toBeLessThanOrEqual(10);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
