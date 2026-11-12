import { dirname } from "node:path";
import type { Request } from "express";
import { createUserProviderKeys } from "@toonflow/multi-tenant-models";
import conf from "@/utils/conf";
import { requestIdentity } from "./runtime";
import { isEnabled } from "./mode";

const keys = createUserProviderKeys(dirname(conf.path));

function ownUserId(req: Request) {
  const user = requestIdentity(req);
  if (!isEnabled() || !user || user.role !== "user") {
    throw Object.assign(new Error("请使用客户账号登录后管理自己的密钥"), { status: 403 });
  }
  return user.id;
}

export function readOwnProviderKeyStatus(req: Request) {
  return keys.status(ownUserId(req), "aliyun");
}

export function saveOwnProviderKey(req: Request, apiKey: string, expectedRevision: number) {
  return keys.save(ownUserId(req), "aliyun", apiKey, expectedRevision);
}

export function unbindOwnProviderKey(req: Request, expectedRevision: number) {
  return keys.unbind(ownUserId(req), "aliyun", expectedRevision);
}
