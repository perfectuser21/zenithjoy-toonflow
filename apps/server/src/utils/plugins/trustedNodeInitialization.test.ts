import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "@toonflow/file";
import express from "express";
import { unzipSync } from "fflate";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:https";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

test("an existing staff canvas restores its Qianchuan account and downloads all 100 videos", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "toonflowCanvasBrowser")));
  const project = { directory: join(root, "workspaces", "studio"), name: "既有画布", lastOpenedAt: Date.now() };
  const downloads = join(root, "downloads");
  const build = fileURLToPath(new URL("../../../../../build/", import.meta.url));
  const originalFetch = globalThis.fetch;
  const previousEnvironment = Object.fromEntries([
    "NODE_ENV", "TOONFLOW_DATA_DIR", "TOONFLOW_PROJECT_QUOTA_ROOT", "TOONFLOW_TRUSTED_CANVAS_BETA",
    "TOONFLOW_STAFF_ACCESS_ORIGIN", "TOONFLOW_STAFF_ACCESS_ISSUER", "TOONFLOW_STAFF_ACCESS_AUDIENCE",
  ].map(key => [key, process.env[key]]));
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Awaited<ReturnType<typeof import("puppeteer-core").launch>> | undefined;
  try {
    await mkdir(join(project.directory, "assets"), { recursive: true });
    await mkdir(downloads);
    const sample = join(root, "sample.mp4");
    execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=size=64x64:rate=12", "-t", "0.25", "-c:v", "libx264", sample]);
    const video = await readFile(sample);
    const clips: MashupClip[] = [];
    const originals = new Map<string, Buffer>();
    for (let index = 1; index <= 100; index++) {
      const name = `成片-${String(index).padStart(3, "0")}.mp4`;
      const url = `assets/clip${index}.mp4`;
      const freeBox = Buffer.alloc(12);
      freeBox.writeUInt32BE(12);
      freeBox.write("free", 4);
      freeBox.writeUInt32BE(index, 8);
      const original = Buffer.concat([video, freeBox]);
      await writeFile(join(project.directory, url), original);
      clips.push({ name, url, mimeType: "video/mp4" });
      originals.set(name, original);
    }
    const groups = [clips.slice(0, 10), clips.slice(10, 20)];
    await writeFile(join(project.directory, "画布.json"), JSON.stringify({
      toonflowCanvas: true,
      nodes: [
        { id: "mashup", type: "remote-mashupNode", position: { x: 90, y: 90 }, data: { mashup: {
          groups: groups.map((clips, index) => ({ name: ["A", "B"][index], clips })), limit: clips.length,
          batch: { key: JSON.stringify(groups.map(clips => clips.map(clip => clip.url))), target: clips.length, results: clips },
        } } },
        { id: "qianchuan", type: "remote-qianchuanUploadNode", position: { x: 480, y: 90 }, data: {} },
      ],
      edges: [{ id: "batch", source: "mashup", sourceHandle: "videos", target: "qianchuan", targetHandle: "videos" }],
      viewport: { x: 0, y: 0, zoom: 0.8 },
    }));
    await writeFile(join(root, "settings.json"), JSON.stringify({ settings: {
      multiTenantEnabled: false, helloCompleted: true, ui: { language: "zh-CN", startupAnimation: false },
      privacy: { dataCollectionEnabled: false }, stores: { "toonflow.projectList": { project, projectList: [project] } },
    } }));

    const keyPath = join(root, "key.pem"), certPath = join(root, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1", "-subj", "/CN=127.0.0.1", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
    const gateway = express();
    server = createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, gateway).listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw Error("缺少浏览器验收端口");
    const origin = `https://127.0.0.1:${address.port}`;
    const issuer = "https://staff-fixture.cloudflareaccess.com", audience = "a".repeat(64), kid = "fixture-key";
    Object.assign(process.env, { NODE_ENV: "production", TOONFLOW_DATA_DIR: root, TOONFLOW_STAFF_ACCESS_ORIGIN: origin,
      TOONFLOW_STAFF_ACCESS_ISSUER: issuer, TOONFLOW_STAFF_ACCESS_AUDIENCE: audience, TOONFLOW_TRUSTED_CANVAS_BETA: "1" });
    delete process.env.TOONFLOW_PROJECT_QUOTA_ROOT;
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wall = Math.floor(Date.now() / 1000);
    const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const claims = base64({ alg: "RS256", kid }) + "." + base64({
      type: "app", iss: issuer, aud: [audience], sub: "existing-user", email: "existing@example.test", iat: wall, nbf: wall, exp: wall + 120,
    });
    const assertion = `${claims}.${sign("RSA-SHA256", Buffer.from(claims), privateKey).toString("base64url")}`;
    const staffCookie = `fixtureAccess=${randomUUID()}`;
    const prepareResponses: number[] = [];
    const nativeDownloads: number[] = [];
    gateway.use((req, res, next) => {
      if (req.get("cookie")?.split("; ").includes(staffCookie)) req.headers["cf-access-jwt-assertion"] = assertion;
      if (req.method === "POST" && req.path === "/api/workspaces/files/prepareMashupZip") {
        res.once("finish", () => prepareResponses.push(res.statusCode));
      }
      if (req.method === "GET" && req.path === "/api/workspaces/files/mashupZip") {
        const index = nativeDownloads.push(0) - 1;
        res.once("finish", () => { nativeDownloads[index] = res.statusCode; });
      }
      next();
    });
    const { createApp } = await import("../../app");
    gateway.use(await createApp({ webRoot: join(build, "web"), nodesRoot: join(build, "nodes"), dataDirectory: root }));
    globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
      if (String(input) !== `${issuer}/cdn-cgi/access/certs`) throw Error("浏览器回归禁止访问外部服务");
      return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] });
    }, { preconnect: originalFetch.preconnect });

    const { launch } = await import("puppeteer-core");
    browser = await launch({ channel: "chrome", executablePath: process.env.CHROME_BIN,
      args: ["--no-sandbox", "--ignore-certificate-errors", "--lang=zh-CN", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
      defaultViewport: { width: 1600, height: 1000 } });
    const newPage = async (downloadPath?: string) => {
      const context = await browser!.createBrowserContext(downloadPath ? { downloadBehavior: { policy: "allow", downloadPath } } : {});
      const page = await context.newPage();
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await page.setCookie({ url: origin, name: "fixtureAccess", value: staffCookie.split("=")[1]!, secure: true, httpOnly: true });
      return { context, page };
    };
    const existing = await newPage();
    await existing.page.goto(`${origin}/#/workspace`, { waitUntil: "domcontentloaded" });
    const organization = await existing.page.evaluate(async () => {
      async function post(body: unknown) {
        const response = await fetch("/api/ai/media/qianchuan/organizations", {
          method: "POST", headers: { "content-type": "application/json", "x-toonflow-workspace": "1" }, body: JSON.stringify(body),
        });
        if (!response.ok) throw Error(`组织接口返回 ${response.status}: ${await response.text()}`);
        const result: unknown = await response.json();
        if (!result || typeof result !== "object" || !("data" in result)) throw Error("组织接口未返回数据");
        return result.data;
      }
      const created = await post({ action: "createOrganization", name: "已有组织" });
      if (!created || typeof created !== "object" || !("organizations" in created) || !Array.isArray(created.organizations)) throw Error("缺少既有组织");
      const organizationId = created.organizations[0]?.id;
      if (typeof organizationId !== "string") throw Error("缺少既有组织 ID");
      const authorized = await post({ action: "addAuthorization", organizationId, name: "离线授权", accessToken: "local-fixture-only",
        accounts: [{ name: "已有千川账号", advertiserId: "1234567890123456789", teamId: null }] });
      if (!authorized || typeof authorized !== "object" || !("organizations" in authorized) || !Array.isArray(authorized.organizations)) throw Error("缺少既有授权");
      const accountId = authorized.organizations[0]?.accounts?.[0]?.id;
      if (typeof accountId !== "string") throw Error("缺少已授权账户 ID");
      return { organizationId, accountId };
    });
    await existing.context.close();

    const { page } = await newPage(downloads);
    await page.goto(`${origin}/#/workspace`, { waitUntil: "domcontentloaded" });
    const selectedAccount = `.qianchuanUploadNode .accountInput select option:checked[value=${JSON.stringify(organization.accountId)}]`;
    await page.waitForSelector(selectedAccount, { timeout: 15000 });
    await page.waitForSelector(".workspacePage:not([inert]) .canvasPanel:not([inert])", { visible: true, timeout: 10000 });
    const selectedOrganization = `.qianchuanUploadNode .accountInput select option:checked[value=${JSON.stringify(organization.organizationId)}]`;
    expect(await page.$(selectedOrganization)).not.toBeNull();
    async function clickDownload() {
      const button = await page.waitForSelector('xpath=//button[normalize-space(.)="下载 100 条成片 ZIP" and not(@disabled)]', { visible: true, timeout: 10000 })
        .catch(async error => { throw Error((await page.$eval("body", body => Reflect.get(body, "innerText"))).slice(-700), { cause: error }); });
      if (!button) throw Error("找不到批量下载按钮");
      await button.click();
      await button.dispose();
    }
    await clickDownload();
    const deadline = Date.now() + 10000;
    let files = (await readdir(downloads)).filter(file => file.endsWith(".zip"));
    while (!files.length && Date.now() < deadline) {
      await Bun.sleep(50);
      files = (await readdir(downloads)).filter(file => file.endsWith(".zip"));
    }
    if (files.length !== 1) {
      const alert = await page.$eval(".mashupContent", node => Reflect.get(node, "innerText")).catch(() => "未加载混剪节点");
      throw Error(`预检 ${prepareResponses.join(",")}，下载 ${nativeDownloads.join(",")}，${String(alert).slice(-300)}`);
    }
    expect(prepareResponses).toEqual([200]);
    expect(nativeDownloads).toEqual([200]);
    const entries = unzipSync(await readFile(join(downloads, files[0]!)));
    expect(Object.keys(entries)).toHaveLength(100);
    for (const [name, original] of originals) expect(Buffer.from(entries[name]!).equals(original)).toBe(true);

    await rename(join(project.directory, clips[88]!.url), join(root, "missing.mp4"));
    await clickDownload();
    await page.waitForSelector('xpath=//*[@role="alert" and contains(., "成片-089.mp4")]', { visible: true, timeout: 10000 });
    expect(prepareResponses).toEqual([200, 404]);
    expect(nativeDownloads).toEqual([200]);
    expect(await readdir(downloads)).toEqual(files);
  } finally {
    await browser?.close();
    server?.closeAllConnections();
    server?.close();
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 60000);

async function concatInBrowser(sources: Blob[]) {
  const { launch } = await import("puppeteer-core");
  const { outputs, success, logs } = await Bun.build({
    entrypoints: [fileURLToPath(new URL("../../../../../packages/nodeShared/src/concatVideo.ts", import.meta.url))],
    target: "browser",
  });
  if (!success) throw new AggregateError(logs, "拼接模块构建失败");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response("<title>音画拼接</title>", { headers: { "Content-Type": "text/html" } });
    if (path === "/concat.js") return new Response(outputs[0], { headers: { "Content-Type": "text/javascript" } });
    return new Response(sources[Number(path.slice(1))] ?? null);
  } });
  try {
    const browser = await launch({
      channel: "chrome", executablePath: process.env.CHROME_BIN, args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      // Exercise the portable encoder on every runner, including machines with a native AAC encoder.
      await page.evaluateOnNewDocument(() => Object.defineProperty(globalThis, "AudioEncoder", { value: undefined }));
      await page.goto(server.url.href);
      const bytes = await page.evaluate(async (count: number) => {
        const modulePath = "/concat.js";
        const { concatVideo } = await import(modulePath);
        const clips = await Promise.all(Array.from({ length: count }, async (_, i) => (await fetch("/" + i)).blob()));
        return Array.from(new Uint8Array(await (await concatVideo(clips)).arrayBuffer()));
      }, sources.length);
      return new Uint8Array(bytes);
    } finally { await browser.close(); }
  } finally { await server.stop(true); }
}

test("short, overlong and delayed AAC each stay inside their own video segment", async () => {
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
    await writeFile(path, await concatInBrowser(sources));
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
