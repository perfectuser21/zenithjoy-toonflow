import { constants, open } from "@toonflow/file";
import type { FileHandle, Stats } from "@toonflow/file";
import { makeZip, predictLength } from "client-zip";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { getAppOrigin } from "@/utils/mcp/control";
import { requestIdentity } from "@/utils/multiTenant/runtime";
import { isStaffAccessHost, readStaffAccessIdentity } from "@/utils/multiTenant/staffAccess";
import { isWithin, resolveWorkspacePath } from "@/utils/workspace/files";

type Item = { name: string; path: string };
type PreparedFile = { item: Item; path: string; info: Stats };
type Ticket = { actor: string; directory: string; files: PreparedFile[]; expiresAt: number; starts: number; active: boolean };

// The browser may restart a truncated download with the same link.
const tickets = new Map<string, Ticket>();
const ticketLifetimeMs = 120_000;
const retryLifetimeMs = 300_000;
const maxStarts = 3;
const openFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function fail(message: string, status: number): never {
  throw Object.assign(new Error(message), { status });
}

export async function mashupZipActor(req: Request) {
  if (req.res?.locals.multiTenantWeb === true) {
    const user = requestIdentity(req);
    if (!user) fail("请先登录 Toonflow", 401);
    return JSON.stringify(["web", user.role, user.id]);
  }
  if (!isStaffAccessHost(req)) fail("当前入口不支持服务端批量下载", 501);
  const staff = await readStaffAccessIdentity(req);
  if (!staff) fail("请登录当前 Toonflow 工作站后再下载", 401);
  return JSON.stringify(["staff", staff.id]);
}

export function assertMashupZipNavigation(req: Request) {
  const site = req.get("sec-fetch-site");
  if (site && site !== "same-origin") fail("只能从 Toonflow 页面下载成片", 403);
  if (site !== "same-origin" || req.get("origin") || req.get("referer")) getAppOrigin(req);
}

function sameFile(left: Stats, right: Stats) {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

async function inspectFile(directory: string, item: Item): Promise<PreparedFile> {
  const assets = resolve(directory, "assets");
  if (!isWithin(assets, resolve(directory, item.path))) fail(`成片「${item.name}」不在当前项目的素材目录内`, 403);
  try {
    const { path } = await resolveWorkspacePath(directory, item.path);
    if (!isWithin(assets, path)) fail(`成片「${item.name}」不在当前项目的素材目录内`, 403);
    const file = await open(path, openFlags);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size === 0) fail(`成片「${item.name}」为空或不是普通文件`, 422);
      const header = Buffer.alloc(8);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      if (bytesRead !== header.length || header.toString("ascii", 4) !== "ftyp") fail(`成片「${item.name}」不是有效的 MP4 文件`, 422);
      return { item, path, info };
    } finally {
      await file.close();
    }
  } catch (cause) {
    if (cause && typeof cause === "object" && "status" in cause) {
      if (cause.status === 400 || cause.status === 403) fail(`成片「${item.name}」的文件路径不可访问`, cause.status);
      throw cause;
    }
    const code = cause && typeof cause === "object" && "code" in cause ? cause.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") fail(`找不到成片「${item.name}」`, 404);
    if (code === "EACCES" || code === "EPERM" || code === "ELOOP") fail(`无法读取成片「${item.name}」`, 403);
    fail(`读取成片「${item.name}」失败`, 500);
  }
}

export async function prepareMashupZip(actor: string, directory: string, items: Item[]) {
  const files: PreparedFile[] = [];
  const names = new Set<string>();
  for (const item of items) {
    const name = item.name.toLowerCase();
    if (names.has(name)) fail(`成片名称重复「${item.name}」`, 400);
    names.add(name);
    files.push(await inspectFile(directory, item));
  }
  const now = Date.now();
  for (const [id, ticket] of tickets) {
    if (!ticket.active && (ticket.expiresAt <= now || ticket.starts >= maxStarts)) tickets.delete(id);
  }
  let pendingFiles = files.length;
  let actorTickets = 0;
  const idleRetries: [string, Ticket][] = [];
  for (const [id, ticket] of tickets) {
    pendingFiles += ticket.files.length;
    if (ticket.actor === actor && (ticket.active || !ticket.starts)) actorTickets++;
    if (!ticket.active && ticket.starts) idleRetries.push([id, ticket]);
  }
  if (tickets.size >= 128 || pendingFiles > 4096) {
    for (const [id, ticket] of idleRetries) {
      tickets.delete(id);
      pendingFiles -= ticket.files.length;
      if (tickets.size < 128 && pendingFiles <= 4096) break;
    }
  }
  if (tickets.size >= 128 || pendingFiles > 4096 || actorTickets >= 4) {
    fail("已有过多等待中的下载，请稍后重试", 429);
  }
  const ticket = randomUUID();
  tickets.set(ticket, { actor, directory, files, expiresAt: now + ticketLifetimeMs, starts: 0, active: false });
  return ticket;
}

export function takeMashupZip(ticket: string, actor: string) {
  const batch = tickets.get(ticket);
  if (!batch || batch.actor !== actor) fail("下载已失效，请重新点击下载", 404);
  if (batch.active) fail("成片正在下载，请稍后重试", 409);
  if (batch.expiresAt <= Date.now() || batch.starts >= maxStarts) fail("下载已失效，请重新点击下载", 404);
  batch.active = true;
  batch.starts++;
  return batch;
}

export function releaseMashupZip(batch: Ticket) {
  batch.expiresAt = Date.now() + retryLifetimeMs;
  batch.active = false;
}

export async function streamMashupZip(batch: Ticket, directory: string, response: Response) {
  if (directory !== batch.directory) fail("项目位置已变更，请重新点击下载", 409);
  for (const expected of batch.files) {
    const current = await inspectFile(directory, expected.item);
    if (current.path !== expected.path || !sameFile(expected.info, current.info)) fail(`成片「${expected.item.name}」在下载前发生了变化`, 409);
  }

  const controller = new AbortController();
  const { signal } = controller;
  const abort = () => { if (!response.writableFinished) controller.abort(); };
  response.once("close", abort);
  if (response.destroyed) controller.abort();
  let active: FileHandle | undefined;

  async function* readFileEntry(expected: PreparedFile) {
    const file = await open(expected.path, openFlags);
    active = file;
    try {
      signal.throwIfAborted();
      if (!sameFile(expected.info, await file.stat())) fail(`成片「${expected.item.name}」在下载时发生了变化`, 409);
      for (let offset = 0; offset < expected.info.size;) {
        signal.throwIfAborted();
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, expected.info.size - offset));
        const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) fail(`成片「${expected.item.name}」在下载时发生了变化`, 409);
        offset += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
      if (!sameFile(expected.info, await file.stat())) fail(`成片「${expected.item.name}」在下载时发生了变化`, 409);
    } finally {
      if (active === file) {
        active = undefined;
        await file.close();
      }
    }
  }

  const entries = batch.files.map(file => ({
    name: file.item.name,
    size: file.info.size,
    lastModified: file.info.mtime,
    input: readFileEntry(file),
  }));
  response.attachment("混剪成片.zip").set({
    "Accept-Ranges": "none",
    "Cache-Control": "no-store, no-transform",
    "Content-Length": String(predictLength(entries)),
    "Referrer-Policy": "no-referrer",
  });
  try {
    await pipeline(makeZip(entries), response, { signal });
  } catch (cause) {
    if (!signal.aborted || response.headersSent) throw cause;
  } finally {
    response.off("close", abort);
    const file = active;
    active = undefined;
    await file?.close();
  }
}
