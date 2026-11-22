import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "@toonflow/file";
import express from "express";
import { unzipSync } from "fflate";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
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

test("staff canvas generates images, analyzes and edits videos, and exports 100 authorized uploads", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "toonflowCanvasBrowser")));
  const project = { directory: join(root, "workspaces", "studio"), name: "既有画布", lastOpenedAt: Date.now() };
  const downloads = join(root, "downloads");
  const build = fileURLToPath(new URL("../../../../../build/", import.meta.url));
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  const previousEnvironment = Object.fromEntries([
    "NODE_ENV", "TOONFLOW_DATA_DIR", "TOONFLOW_PROJECT_QUOTA_ROOT", "TOONFLOW_TRUSTED_CANVAS_BETA",
    "TOONFLOW_STAFF_ACCESS_ORIGIN", "TOONFLOW_STAFF_ACCESS_ISSUER", "TOONFLOW_STAFF_ACCESS_AUDIENCE",
  ].map(key => [key, process.env[key]]));
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Awaited<ReturnType<typeof import("puppeteer-core").launch>> | undefined;
  try {
    console.error = (...args: unknown[]) => {
      const [error] = args;
      // Each upload ensures these directories exist, and the client handles this response.
      if (error instanceof Error && "status" in error && error.status === 403
        && ["当前账号没有该组织权限", "长视频换背景尚未在此环境开放"].includes(error.message)) return;
      if (error instanceof Error && "code" in error && error.code === "EEXIST" && "path" in error
        && (error.path === join(project.directory, "assets") || error.path === join(project.directory, "assets", "mashup"))) return;
      originalConsoleError(...args);
    };
    await mkdir(project.directory, { recursive: true });
    await mkdir(downloads);
    const ffmpeg = (...args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-loglevel", "error", ...args]);
    const groups = [
      { name: "A", color: "red", duration: "0.25" },
      { name: "B", color: "blue", duration: "0.50" },
    ].map(({ name, color, duration }) => {
      const files = Array.from({ length: 10 }, (_, index) => {
        const path = join(root, `${name}${String(index + 1).padStart(2, "0")}.mp4`);
        ffmpeg("-f", "lavfi", "-i", `color=${color}:size=64x64:rate=12`, "-vf",
          `drawbox=x=${index * 4}:y=0:w=4:h=12:color=white:t=fill`, "-t", duration, "-c:v", "libx264", "-bf", "0", path);
        return path;
      });
      return { name, files };
    });
    await mkdir(join(project.directory, "assets"));
    const sceneSource = "assets/threeShots.mp4";
    ffmpeg(...["red", "lime", "blue"].flatMap(color => ["-f", "lavfi", "-i", `color=${color}:size=64x64:rate=12:duration=1`]),
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=3", "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
      "-map", "[v]", "-map", "3:a", "-c:a", "aac", "-c:v", "libx264", "-bf", "0", join(project.directory, sceneSource));
    const png = ffmpeg("-f", "lavfi", "-i", "color=red:size=64x64", "-frames:v", "1", "-c:v", "png", "-threads", "1", "-f", "image2pipe", "pipe:1");
    const sourceVideoBytes = await readFile(join(project.directory, sceneSource));
    const replacementVideo = ffmpeg("-f", "lavfi", "-i", "color=purple:size=64x64:rate=12:duration=3",
      "-c:v", "libx264", "-bf", "0", "-movflags", "frag_keyframe+empty_moov", "-f", "mp4", "pipe:1");
    await mkdir(join(root, "providers"));
    await writeFile(join(root, "providers", "fixtureMedia.ts"), `
      export default {
        id: "fixtureMedia", label: "离线模型",
        models: [
          { id: "fixture-image", label: "离线图片", type: "image", mode: ["text", "singleImage"], imageSizes: ["1K"], imageRatios: ["1:1"] },
          { id: "fixture-video", label: "离线视频", type: "video", mode: [["imageReference:1", "videoReference:1"]],
            durationResolutionMap: [{ duration: [3], resolution: ["720P"] }] }
        ],
        async generateImage(request) {
          if (request.model !== "fixture-image") throw Error("图片模型不匹配");
          if (request.prompt !== "一张红色背景图" && (!request.prompt.includes("设计新的场景背景") || request.images?.[0]?.mimeType !== "image/png")) throw Error("缺少用于换背景的参考帧");
          return [{ type: "base64", data: "${png.toString("base64")}", mimeType: "image/png", mediaType: "image" }];
        },
        async generateVideo(request) {
          if (request.model !== "fixture-video" || request.duration !== 3 ||
            request.images?.[0]?.data !== "${png.toString("base64")}" || request.videos?.[0]?.data !== "${sourceVideoBytes.toString("base64")}") {
            throw Error("换背景未收到原视频和已选背景图");
          }
          return [{ type: "base64", data: "${replacementVideo.toString("base64")}", mimeType: "video/mp4", mediaType: "video" }];
        }
      };
    `);
    const videoNodes = await Promise.all(groups.map(async ({ name, files }, index) => {
      const url = `assets/${name}.mp4`;
      await writeFile(join(project.directory, url), await readFile(files[0]!));
      return { id: name, type: "remote-videoNode", position: { x: 350 + index * 320, y: 1000 },
        data: { label: name, outputs: { video: { dataType: "VIDEO", value: { url, mimeType: "video/mp4" } } } } };
    }));
    const canvas = join(project.directory, "画布.json");
    await writeFile(canvas, JSON.stringify({
      toonflowCanvas: true,
      nodes: [
        { id: "mashup", type: "remote-mashupNode", position: { x: 90, y: 90 }, data: { mashup: {
          groups: groups.map(({ name }) => ({ name, clips: [] })), limit: 100,
        } } },
        { id: "qianchuan", type: "remote-qianchuanUploadNode", position: { x: 480, y: 90 }, data: {} },
        ...videoNodes,
        { id: "concat", type: "remote-videoConcatNode", position: { x: 850, y: 550 }, data: { videoConcat: { segmentCount: 2 } } },
        { id: "backgroundSource", type: "remote-videoNode", position: { x: 1240, y: 570 },
          data: { outputs: { video: { dataType: "VIDEO", value: { url: sceneSource, mimeType: "video/mp4" } } } } },
        { id: "analysis", type: "remote-frameAnalysisNode", position: { x: 1240, y: 115 },
          data: { frameAnalysis: { source: { url: sceneSource, mimeType: "video/mp4" }, aiEnabled: false } } },
        { id: "imageGeneration", type: "remote-imageGenerationNode", position: { x: 850, y: 90 },
          data: { prompt: "一张红色背景图", promptModel: [[{ type: "Write", text: "一张红色背景图" }]],
            model: JSON.stringify(["fixtureMedia", "fixture-image"]), ratio: "1:1" } },
      ],
      edges: [
        { id: "batch", source: "mashup", sourceHandle: "videos", target: "qianchuan", targetHandle: "videos" },
        ...videoNodes.map(({ id }, index) => ({ id: "segment" + index, source: id, sourceHandle: "video", target: "concat", targetHandle: "segment" + index })),
      ],
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
    const staff = new Map(["owner", "member", "outsider"].map(identity => {
      const claims = base64({ alg: "RS256", kid }) + "." + base64({
        type: "app", iss: issuer, aud: [audience], sub: identity, email: identity + "@example.test", iat: wall, nbf: wall, exp: wall + 300,
      });
      return [identity, { cookie: randomUUID(), assertion: `${claims}.${sign("RSA-SHA256", Buffer.from(claims), privateKey).toString("base64url")}` }];
    }));
    const uploads = new Map<string, Buffer>();
    const ownerToken = "local-shared-fixture";
    const advertiserId = "1234567890123456789";
    const prepareResponses: number[] = [];
    const nativeDownloads: number[] = [];
    gateway.use((req, res, next) => {
      for (const { cookie, assertion } of staff.values()) {
        if (req.get("cookie")?.split("; ").includes(`fixtureAccess=${cookie}`)) req.headers["cf-access-jwt-assertion"] = assertion;
      }
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
    globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === "https://api.oceanengine.com/open_api/2/file/video/ad/") {
        if (!(init?.body instanceof FormData) || init.method !== "POST" || new Headers(init.headers).get("Access-Token") !== ownerToken
          || init.body.get("advertiser_id") !== advertiserId || init.body.get("upload_type") !== "UPLOAD_BY_FILE") {
          throw Error("上传未使用目标账户授权");
        }
        const name = init.body.get("filename"), file = init.body.get("video_file");
        if (typeof name !== "string" || !(file instanceof Blob) || uploads.has(name)) throw Error("重复提交或素材缺失");
        const bytes = Buffer.from(await file.arrayBuffer());
        if (createHash("md5").update(bytes).digest("hex") !== init.body.get("video_signature")) throw Error("素材签名不一致");
        uploads.set(name, bytes);
        return new Response('{"code":0,"data":{"video_id":"fixture-video","material_id":1234567890123456789}}');
      }
      if (String(input) !== `${issuer}/cdn-cgi/access/certs`) throw Error("浏览器回归禁止访问外部服务");
      return Response.json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }] });
    }, { preconnect: originalFetch.preconnect });

    const { launch } = await import("puppeteer-core");
    browser = await launch({ channel: "chrome", executablePath: process.env.CHROME_BIN,
      args: ["--no-sandbox", "--ignore-certificate-errors", "--lang=zh-CN", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"],
      defaultViewport: { width: 2200, height: 1100 } });
    const newPage = async (downloadPath?: string, identity = "owner") => {
      const context = await browser!.createBrowserContext(downloadPath ? { downloadBehavior: { policy: "allow", downloadPath } } : {});
      const page = await context.newPage();
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await page.setCookie({ url: origin, name: "fixtureAccess", value: staff.get(identity)!.cookie, secure: true, httpOnly: true });
      return { context, page };
    };
    const existing = await newPage();
    await existing.page.goto(`${origin}/#/workspace`, { waitUntil: "domcontentloaded" });
    const organization = await existing.page.evaluate(async (accessToken, advertiser) => {
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
      const teamId = created.organizations[0]?.teams[0]?.id;
      await post({ action: "createTeam", organizationId, name: "独立团队" });
      const snapshot = await post({ action: "snapshot" }) as { organizations: { teams: { id: string; name: string }[] }[] };
      const anotherTeam = snapshot.organizations[0]?.teams.find(team => team.name === "独立团队");
      if (!teamId || !anotherTeam) throw Error("缺少团队");
      await post({ action: "addAuthorization", organizationId, name: "独立授权", accessToken: "separate-local-fixture",
        accounts: [{ name: "独立账号", advertiserId: "2", teamId: anotherTeam.id }] });
      const authorized = await post({ action: "addAuthorization", organizationId, name: "离线授权", accessToken,
        accounts: [{ name: "已有千川账号", advertiserId: advertiser, teamId }] });
      if (!authorized || typeof authorized !== "object" || !("organizations" in authorized) || !Array.isArray(authorized.organizations)) throw Error("缺少既有授权");
      const accountId = authorized.organizations[0]?.accounts?.find((account: { name: string }) => account.name === "已有千川账号")?.id;
      if (typeof accountId !== "string") throw Error("缺少已授权账户 ID");
      const invitation = await post({ action: "createInvitation", organizationId, teamId }) as { code: string };
      return { organizationId, accountId, invitation: invitation.code };
    }, ownerToken, advertiserId);
    await existing.context.close();

    const selectedAccount = `.qianchuanUploadNode .accountInput select option:checked[value=${JSON.stringify(organization.accountId)}]`;
    const selectedOrganization = `.qianchuanUploadNode .accountInput select option:checked[value=${JSON.stringify(organization.organizationId)}]`;
    async function openCanvas(downloadPath?: string) {
      const session = await newPage(downloadPath, "member");
      await session.page.goto(`${origin}/#/workspace`, { waitUntil: "domcontentloaded" });
      await session.page.waitForSelector(".workspacePage:not([inert]) .canvasPanel:not([inert])", { visible: true, timeout: 15000 });
      await session.page.waitForSelector(selectedAccount, { timeout: 15000 });
      expect(await session.page.$(selectedOrganization)).not.toBeNull();
      return session;
    }
    async function postFrom(identity: string, endpoint: string, body: object) {
      const session = await newPage(undefined, identity);
      try {
        await session.page.goto(`${origin}/#/workspace`, { waitUntil: "domcontentloaded" });
        return await session.page.evaluate(async (path, payload) => {
          const response = await fetch("/api/ai/media/qianchuan/" + path, {
            method: "POST", headers: { "content-type": "application/json", "x-toonflow-workspace": "1" }, body: JSON.stringify(payload),
          });
          const result = await response.json() as { data?: unknown };
          return { status: response.status, data: result.data };
        }, endpoint, body);
      } finally {
        await session.context.close();
      }
    }
    const joined = await postFrom("member", "organizations", { action: "joinOrganization", code: organization.invitation });
    expect(joined.status).toBe(200);
    expect(joined.data).toMatchObject({ organizations: [{ role: "member", accounts: [{ id: organization.accountId }] }] });
    const memberOrganizations = (joined.data as { organizations: { accounts: unknown[]; authorizations?: unknown }[] }).organizations;
    expect(memberOrganizations).toHaveLength(1);
    expect(memberOrganizations[0]!.accounts).toHaveLength(1);
    expect(memberOrganizations[0]!.authorizations).toBeUndefined();
    expect((await postFrom("member", "organizations", { action: "createTeam", organizationId: organization.organizationId, name: "越权操作" })).status).toBe(403);
    const outsider = await postFrom("outsider", "organizations", { action: "snapshot" });
    expect(outsider.status).toBe(200);
    expect(outsider.data).toEqual({ organizations: [] });

    async function savedNodeData(id: string) {
      const state = JSON.parse(await readFile(canvas, "utf8"));
      return state.nodes.find((node: { id: string }) => node.id === id)?.data;
    }
    async function waitForSaved<T>(read: () => Promise<T | undefined>): Promise<T> {
      const expires = Date.now() + 5000;
      do {
        const result = await read();
        if (result !== undefined) return result;
        await Bun.sleep(50);
      } while (Date.now() < expires);
      throw Error("画布未保存验收产物");
    }
    const generating = await openCanvas();
    for (const { name, files } of groups) {
      const input = await generating.page.waitForSelector(`input[type=file][aria-label="${name} 组视频"]`, { timeout: 10000 });
      if (!input) throw Error(`找不到 ${name} 组视频入口`);
      await input.uploadFile(...files);
      await generating.page.waitForSelector(`xpath=//section[div/strong="${name}" and div/span="10 个片段" and ancestor::fieldset[not(@disabled)]]`, { timeout: 10000 });
    }
    await generating.page.locator('xpath=//button[normalize-space(.)="生成成片" and not(@disabled)]').setTimeout(5000).click();
    const downloadButton = 'xpath=//button[normalize-space(.)="下载 100 条成片 ZIP" and not(@disabled)]';
    const completed = await generating.page.waitForSelector(`${downloadButton} | //*[@role="alert" and ancestor::*[contains(@class,"mashupContent")]]`, { visible: true, timeout: 30000 });
    if (!completed || await completed.evaluate(element => element.tagName) !== "BUTTON") {
      throw Error(`100 条混剪未生成完成：${await completed?.evaluate(element => element.textContent)}`);
    }
    const resultSelector = '.mashupContent select[aria-label="选择成片"]';
    const names = await generating.page.$$eval(`${resultSelector} option`, options => options.map(option => option.textContent));
    expect(names).toHaveLength(100);
    expect(new Set(names).size).toBe(100);
    expect(names[0]).toBe("001_A01-B01.mp4");
    expect(names[49]).toBe("050_A05-B10.mp4");
    expect(names.at(-1)).toBe("100_A10-B10.mp4");
    const saved: { nodes: { id: string; data: { mashup?: { batch: { results: MashupClip[] } } } }[] }
      = JSON.parse(await readFile(canvas, "utf8"));
    const clips = saved.nodes.find(node => node.id === "mashup")?.data.mashup?.batch.results;
    if (!clips) throw Error("已保存画布缺少成片");
    expect(clips.map(clip => clip.name)).toEqual(names);
    const originals = new Map(await Promise.all(clips.map(async clip => [clip.name, await readFile(join(project.directory, clip.url))] as const)));
    for (const index of [0, 49, 99]) {
      const path = join(project.directory, clips[index]!.url);
      const details = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,duration",
        "-of", "default=noprint_wrappers=1", path], { encoding: "utf8" });
      expect(details).toContain("codec_name=h264");
      expect(Number(details.match(/duration=(.+)/)?.[1])).toBeCloseTo(0.75, 2);
    }
    const concat = generating.page.locator(".videoConcatNode button.primary:not([disabled])");
    await concat.setTimeout(5000).click();
    await generating.page.waitForSelector('.videoConcatNode a[download="合成成片.mp4"]');
    const imageNode = '.vue-flow__node[data-id="imageGeneration"]';
    await generating.page.locator(`${imageNode} .imageContent`).setTimeout(5000).click();
    await generating.page.locator('button[aria-label="生成图片"]:not([disabled])').setTimeout(5000).click();
    await generating.page.waitForFunction(selector => {
      const image = Reflect.get(globalThis, "document").querySelector(selector + ' img[alt="生成图片"]');
      return image?.naturalWidth === 64 && image.naturalHeight === 64;
    }, {}, imageNode);

    const concatPath = join(project.directory, (await savedNodeData("concat")).videoConcat.result.url);
    const readPixel = (path: string, seconds: string) => ffmpeg("-ss", seconds, "-i", path, "-vf", "crop=4:4:28:28,scale=1:1",
      "-frames:v", "1", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1");
    expect(readPixel(concatPath, "0.1")).toEqual(readPixel(groups[0]!.files[0]!, "0.1"));
    expect(readPixel(concatPath, "0.4")).toEqual(readPixel(groups[1]!.files[0]!, "0.1"));
    const generatedImage = await waitForSaved<string>(async () => (await savedNodeData("imageGeneration"))?.outputs?.image?.value.url);
    expect(await readFile(join(project.directory, generatedImage))).toEqual(png);
    const backgroundNode = '.vue-flow__node[data-id="backgroundSource"]';
    await generating.page.locator(`${backgroundNode} .titleBar`).setTimeout(5000).click();
    await generating.page.locator(`${backgroundNode} button[title^="自动生成背景候选"]:not([disabled])`).setTimeout(5000).click().catch(async error => {
      throw Error(await generating.page.$eval(backgroundNode, node => Reflect.get(node, "innerText")), { cause: error });
    });
    const dialog = '.backgroundPanel';
    await generating.page.waitForFunction(selector => {
      const candidates = Array.from(Reflect.get(globalThis, "document").querySelectorAll(selector + " .candidateGrid img")) as { naturalWidth: number }[];
      return candidates.length === 3 && candidates.every(image => image.naturalWidth === 64);
    }, { timeout: 12000 }, dialog).catch(async error => {
      throw Error(await generating.page.$eval(dialog, node => Reflect.get(node, "innerText")), { cause: error });
    });
    await generating.page.locator(`${dialog} .candidateGrid button:nth-child(2)`).click();
    await generating.page.locator('xpath=//button[normalize-space(.)="确认生成" and not(@disabled)]').click();
    await generating.page.waitForFunction(() => {
      const video = Reflect.get(globalThis, "document").querySelector('video[aria-label="换背景成品预览"]');
      return video?.videoWidth === 64 && video.duration === 3;
    }, { timeout: 12000 }).catch(async error => {
      throw Error(await generating.page.$eval(dialog, node => Reflect.get(node, "innerText")), { cause: error });
    });
    const replacementPath = await waitForSaved<string>(async () => (await savedNodeData("backgroundSource"))?.backgroundState?.lastResult?.url);
    expect((await savedNodeData("backgroundSource")).backgroundState.candidates).toHaveLength(3);
    expect(await readFile(join(project.directory, replacementPath))).toEqual(replacementVideo);
    expect(await readFile(join(project.directory, sceneSource))).toEqual(sourceVideoBytes);
    await generating.page.locator('xpath=//button[normalize-space(.)="关闭" and ancestor::*[@role="dialog"]]').click();
    const shotNode = '.vue-flow__node[data-id="analysis"]';
    await generating.page.locator(`${shotNode} .titleBar`).setTimeout(5000).click();
    await generating.page.locator('xpath=//button[normalize-space(.)="开始拉片" and not(@disabled)]').setTimeout(5000).click();
    const shotResult = await generating.page.waitForSelector(
      `${shotNode} :is(.resultSummary, [role="alert"])`, { visible: true, timeout: 10000 }).catch(async error => {
      throw Error(await generating.page.$eval(shotNode, node => Reflect.get(node, "innerText")), { cause: error });
    });
    expect(await shotResult?.evaluate(element => element.textContent)).toContain("3 个镜头");
    const manifestPath = await waitForSaved<string>(async () => (await savedNodeData("analysis"))?.frameAnalysis?.lastResult?.manifest);
    const manifest = JSON.parse(await readFile(join(project.directory, manifestPath), "utf8"));
    expect(manifest.scenes).toHaveLength(3);
    for (const [index, shot] of manifest.scenes.entries()) {
      expect(Math.abs(shot.start - index)).toBeLessThanOrEqual(1 / 12);
      expect(Math.abs(shot.end - index - 1)).toBeLessThanOrEqual(1 / 12);
      expect((await readFile(join(project.directory, shot.image))).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(readPixel(join(project.directory, shot.video), "0.3")).toEqual(readPixel(join(project.directory, sceneSource), String(index + 0.3)));
    }
    expect(execFileSync("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type",
      "-of", "csv=p=0", join(project.directory, manifest.audio)], { encoding: "utf8" }).trim()).toBe("audio");
    await generating.context.close();

    const { page } = await openCanvas(downloads);
    expect(await page.$$eval(`${resultSelector} option`, options => options.map(option => option.textContent))).toEqual(names);
    await page.waitForFunction(selector => {
      const image = Reflect.get(globalThis, "document").querySelector(selector + ' img[alt="生成图片"]');
      const video = Reflect.get(globalThis, "document").querySelector('.videoConcatNode video[aria-label="成片预览"]');
      return image?.naturalWidth === 64 && !!video?.duration && Math.abs(video.duration - 0.75) < 0.05;
    }, {}, imageNode);
    await page.locator(".qianchuanUploadNode button.primary:not([disabled])").wait();
    async function clickDownload() {
      const button = await page.waitForSelector(downloadButton, { visible: true, timeout: 10000 })
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

    const denied = await postFrom("outsider", "start", {
      directory: project.directory, organizationId: organization.organizationId, accountId: organization.accountId,
      jobId: randomUUID(), items: [clips[0]!],
    });
    expect(denied.status).toBe(403);
    expect(uploads.size).toBe(0);
    await page.locator(".qianchuanUploadNode button.primary:not([disabled])").click();
    await page.waitForSelector('xpath=//*[@role="status" and contains(.,"成功 100 / 100")]', { timeout: 35000 });
    expect(uploads.size).toBe(100);
    expect(await page.$$eval(".uploadItems small", items => items.map(item => item.textContent)))
      .toEqual(Array(100).fill("素材编号 " + advertiserId));
    for (const [name, original] of originals) expect(uploads.get(name)?.equals(original)).toBe(true);

    const resumed = await openCanvas();
    await resumed.page.waitForSelector('xpath=//*[@role="status" and contains(.,"成功 100 / 100")]', { timeout: 10000 });
    expect(uploads.size).toBe(100);
    await resumed.context.close();

    await rename(join(project.directory, clips[88]!.url), join(root, "missing.mp4"));
    await clickDownload();
    await page.waitForSelector(`xpath=//*[@role="alert" and contains(., ${JSON.stringify(clips[88]!.name)})]`, { visible: true, timeout: 10000 });
    expect(prepareResponses).toEqual([200, 404]);
    expect(nativeDownloads).toEqual([200]);
    expect(await readdir(downloads)).toEqual(files);
  } finally {
    console.error = originalConsoleError;
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
}, 120000);

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
