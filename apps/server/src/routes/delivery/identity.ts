import { customerPointsPerCny } from "@toonflow/multi-tenant-billing/config";
import { Router } from "express";
import { success, error } from "@/lib/responseFormat";

// 同一应用进程的公网入口与回环入口应返回相同身份，避免验收误指向其他实例。
const bootId = crypto.randomUUID();

export default Router().get("/", (_req, res) => {
  const sourceSha = process.env.TOONFLOW_RELEASE_SHA || "";
  const image = process.env.TOONFLOW_RELEASE_IMAGE || "";
  res.set("Cache-Control", "no-store");
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || !/^ghcr\.io\/perfectuser21\/zenithjoy-toonflow@sha256:[a-f0-9]{64}$/.test(image)) {
    res.status(503).json(error("当前实例尚未配置发布身份", null, 503));
    return;
  }
  res.json(success({ sourceSha, image, bootId, capabilities: { mediaTaskReadOnly: true, directWorkspaceMediaUrls: process.env.TOONFLOW_WEB_MEDIA_STREAMING === "1", customerPointsPerCny } }));
});
