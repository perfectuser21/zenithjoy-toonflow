import { createHash } from "node:crypto";
import { lstat, readFile } from "@toonflow/file";
import { Router } from "express";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { assertAppRequest } from "@/utils/mcp/control";
import { resolveWorkspace } from "@/utils/workspace";

const input = z.strictObject({ directory: z.string().min(1).max(4096), url: z.url().max(2048) });
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const bindingConfig = z.strictObject({
  token: z.string().min(1).max(256),
  bindings: z.array(z.strictObject({
    userId: z.string().regex(new RegExp(`^${uuid}$`)),
    directory: z.string().refine(isAbsolute),
    pageIds: z.array(z.string().regex(new RegExp(`^${uuid}$`))).min(1).max(500),
  })).min(1).max(50),
});
const richText = z.object({ plain_text: z.string() });
const pageResponse = z.object({
  object: z.literal("page"),
  id: z.string(),
  archived: z.boolean().optional(),
  in_trash: z.boolean().optional(),
  last_edited_time: z.iso.datetime(),
  properties: z.record(z.string(), z.object({ type: z.string(), title: z.array(richText).optional() })),
});
const markdownResponse = z.object({
  object: z.literal("page_markdown"),
  id: z.string(),
  markdown: z.string(),
  truncated: z.boolean(),
  unknown_block_ids: z.array(z.string()),
});

function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function pageIdFromUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port
      || !["www.notion.so", "notion.so", "app.notion.com"].includes(url.hostname)) {
    fail(400, "请输入 Notion 页面链接");
  }
  const name = url.pathname.replace(/\/$/, "").split("/").at(-1) ?? "";
  const suffix = name.match(new RegExp(`(?:^|-)(${uuid}|[a-f0-9]{32})$`, "i"))?.[1];
  if (!suffix) fail(400, "这个链接里没有 Notion 页面 ID");
  const plain = suffix.toLowerCase().replace(/-/g, "");
  return `${plain.slice(0, 8)}-${plain.slice(8, 12)}-${plain.slice(12, 16)}-${plain.slice(16, 20)}-${plain.slice(20)}`;
}

async function readConfig() {
  const path = process.env.TOONFLOW_IP_NOTION_CONFIG;
  if (!path || !isAbsolute(path)) fail(503, "此环境尚未配置 Notion 素材连接");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.mode & 0o077 || info.size > 128 * 1024) throw new Error();
    return bindingConfig.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    fail(503, "Notion 素材连接配置不可用");
  }
}

async function notionRead(path: string, token: string, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`https://api.notion.com/v1/pages/${path}`, {
      headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2026-03-11" },
      redirect: "error", signal,
    });
  } catch {
    fail(502, "暂时无法读取 Notion，请重试");
  }
  if ([403, 404].includes(response.status)) fail(403, "Notion 未向此连接共享该页面");
  if (response.status === 401) fail(503, "Notion 素材连接需要重新配置");
  if (!response.ok || !response.body) fail(502, "Notion 暂时无法返回素材，请重试");
  const reader = response.body.getReader();
  try {
    let bytes = 0;
    let body = "";
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 256 * 1024) {
        await reader.cancel();
        fail(413, "Notion 页面过长，请先整理成一条选题素材");
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } catch (cause) {
    if ((cause as { status?: number })?.status === 413) throw cause;
    fail(502, "Notion 素材读取未完成，请重试");
  } finally {
    reader.releaseLock();
  }
}

export default Router().post("/", async (req, res) => {
  assertAppRequest(req);
  const user = res.locals.multiTenantUser;
  if (user?.role !== "user") fail(403, "请使用已绑定的 IP 工作区账号");
  const parsed = input.safeParse(req.body);
  if (!parsed.success) fail(400, "请选择工作区并填写有效的 Notion 链接");
  const id = pageIdFromUrl(parsed.data.url);
  const directory = await resolveWorkspace(req, parsed.data.directory);
  const { token, bindings } = await readConfig();
  if (!bindings.some(entry => entry.userId === user.id && entry.directory === directory && entry.pageIds.includes(id))) {
    fail(403, "这个 Notion 页面尚未授权给当前 IP 工作区");
  }
  const signal = AbortSignal.timeout(12000);
  const before = pageResponse.safeParse(await notionRead(id, token, signal));
  if (!before.success || before.data.id !== id || before.data.archived || before.data.in_trash) fail(404, "未找到可读取的 Notion 原文");
  const markdown = markdownResponse.safeParse(await notionRead(`${id}/markdown?markdown_version=v2`, token, signal));
  if (!markdown.success || markdown.data.id !== id) fail(502, "Notion 返回的素材格式无法识别");
  if (markdown.data.truncated || markdown.data.unknown_block_ids.length) fail(422, "Notion 未返回完整正文，请整理素材页后重读");
  const content = markdown.data.markdown
    .replace(/https:\/\/[^\s<>"')]+\?[^\s<>"')]*(?:X-Amz-Signature|X-Goog-Signature|Signature=|X-Amz-Credential)[^\s<>"')]*/gi, "[临时附件链接已省略]")
    .trim();
  if (!content || content.length > 16000) fail(422, "Notion 正文为空或超过 16,000 字，请整理后重读");
  const after = pageResponse.safeParse(await notionRead(id, token, signal));
  if (!after.success || after.data.id !== id || after.data.archived || after.data.in_trash
      || before.data.last_edited_time !== after.data.last_edited_time) fail(409, "Notion 页面刚刚有更新，请重新读取");
  const title = Object.values(after.data.properties).find(property => property.type === "title")?.title?.map(value => value.plain_text).join("").trim();
  res.set("Cache-Control", "no-store").json(success({
    id, url: `https://www.notion.so/${id.replace(/-/g, "")}`, title: title?.slice(0, 240) || "Notion 素材",
    editedAt: after.data.last_edited_time, version: createHash("sha256").update(content).digest("hex"), content,
  }));
});
