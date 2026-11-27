import type { Request } from "express";
import { getAppOrigin } from "@/utils/mcp/control";

const managementPaths = new Set([
  "GET /api/multitenant/state",
  "POST /api/multitenant/login",
  "POST /api/multitenant/logout",
  "PUT /api/multitenant/registration",
  "GET /api/multitenant/users/list",
  "POST /api/multitenant/users/create",
  "PUT /api/multitenant/users/password",
  "PUT /api/multitenant/users/state",
  "GET /api/multitenant/sourcemapping/get",
  "PUT /api/multitenant/sourcemapping/save",
  "GET /api/multitenant/models/available",
  "GET /api/multitenant/models/get",
  "POST /api/multitenant/models/cloud",
  "PUT /api/multitenant/models/save",
  "GET /api/multitenant/providers/get",
  "POST /api/multitenant/providers/inspect",
  "PUT /api/multitenant/providers/save",
  "POST /api/multitenant/billing/credit",
  "POST /api/multitenant/billing/release",
  "GET /api/multitenant/billing/user",
]);

export function namedPlatformAdminWebEnabled(req: Request) {
  const origin = process.env.TOONFLOW_PLATFORM_ADMIN_ORIGIN;
  if (!origin || !origin.startsWith("https://") || !process.env.TOONFLOW_PLATFORM_ADMIN_USER_IDS) return false;
  try { return getAppOrigin(req) === origin; }
  catch { return false; }
}

export function isNamedPlatformAdminWeb(req: Request, path: string) {
  return managementPaths.has(`${req.method} ${path}`) && namedPlatformAdminWebEnabled(req);
}
