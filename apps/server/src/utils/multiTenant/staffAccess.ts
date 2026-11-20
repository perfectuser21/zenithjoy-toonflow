import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import type { Request } from "express";
import { z } from "zod";
import { isEnabled } from "./mode";

const accessHeaderSchema = z.object({
  alg: z.literal("RS256"),
  kid: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
});
const accessClaimsSchema = z.object({
  type: z.literal("app"),
  iss: z.string(),
  aud: z.array(z.string()).min(1).max(32),
  sub: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/),
  email: z.email().max(254),
  exp: z.int(),
  nbf: z.int(),
  iat: z.int(),
  common_name: z.undefined().optional(),
  service_token_id: z.undefined().optional(),
  service_token_status: z.literal(false).optional(),
});
const jwksSchema = z.object({
  keys: z
    .array(
      z.object({
        kid: accessHeaderSchema.shape.kid,
        kty: z.literal("RSA"),
        alg: z.literal("RS256"),
        use: z.literal("sig"),
        n: z.string().regex(/^[a-zA-Z0-9_-]{342,1366}$/),
        e: z.string().regex(/^[a-zA-Z0-9_-]{1,8}$/),
      }),
    )
    .min(1)
    .max(16),
});
const keyCacheLifetimeMs = 5 * 60 * 1000;
const keyRefreshCooldownMs = 15 * 1000;
const maxJwksBytes = 256 * 1024;

export const staffUserIdSchema = z.string().regex(/^staff-[a-f0-9]{64}$/);

type SigningKeys = {
  issuer: string;
  keys: Map<string, KeyObject>;
  expiresAt: number;
  nextRefreshAt: number;
  pending?: Promise<void>;
};

let signingKeys: SigningKeys | undefined;

function httpsOrigin(value?: string) {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.origin === value) return url;
  } catch {}
}

function accessConfiguration() {
  const origin = httpsOrigin(process.env.TOONFLOW_STAFF_ACCESS_ORIGIN);
  const issuer = httpsOrigin(process.env.TOONFLOW_STAFF_ACCESS_ISSUER);
  const audience = process.env.TOONFLOW_STAFF_ACCESS_AUDIENCE;
  if (!origin || !issuer || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.host) || !audience || !/^[a-f0-9]{64}$/.test(audience) || isEnabled())
    return;
  return { origin, issuer: issuer.origin, audience };
}

export function isStaffAccessConfigured() {
  return !!accessConfiguration();
}

export function isStaffAccessHost(req: Request) {
  const config = accessConfiguration();
  return !!config && req.get("host") === config.origin.host;
}

async function fetchSigningKeys(issuer: string) {
  const response = await fetch(new URL("/cdn-cgi/access/certs", issuer), {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !response.body) throw new Error("员工登录公钥不可用");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxJwksBytes) throw new Error("员工登录公钥响应过大");
      chunks.push(value);
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const { keys } = jwksSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  const result = new Map<string, KeyObject>();
  for (const { kid, kty, n, e } of keys) {
    const key = createPublicKey({ format: "jwk", key: { kty, n, e } });
    if (result.has(kid) || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw new Error("员工登录公钥无效");
    result.set(kid, key);
  }
  return result;
}

async function signingKey(issuer: string, kid: string) {
  if (signingKeys?.issuer !== issuer) signingKeys = { issuer, keys: new Map(), expiresAt: 0, nextRefreshAt: 0 };
  const cache = signingKeys;
  const now = Date.now();
  const current = cache.keys.get(kid);
  if (current && now < cache.expiresAt) return current;
  if (!cache.pending && now >= cache.nextRefreshAt) {
    cache.nextRefreshAt = now + keyRefreshCooldownMs;
    cache.pending = fetchSigningKeys(issuer)
      .then((keys) => {
        cache.keys = keys;
        cache.expiresAt = Date.now() + keyCacheLifetimeMs;
      })
      .finally(() => {
        cache.pending = undefined;
      });
  }
  try {
    await cache.pending;
  } catch {
    throw Object.assign(new Error("暂时无法验证员工登录，请稍后重试"), { status: 503 });
  }
  if (Date.now() < cache.expiresAt) return cache.keys.get(kid);
  throw Object.assign(new Error("暂时无法验证员工登录，请稍后重试"), { status: 503 });
}

export async function readStaffAccessIdentity(req: Request): Promise<{ id: string; userName: string } | undefined> {
  const config = accessConfiguration();
  const assertion = req.get("cf-access-jwt-assertion");
  if (!config || req.get("host") !== config.origin.host || !assertion || assertion.length > 16 * 1024) return;
  const match = /^([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)\.([a-zA-Z0-9_-]+)$/.exec(assertion);
  if (!match) return;
  const [, headerValue, claimsValue, signature] = match;
  if (!headerValue || !claimsValue || !signature) return;
  const token = (() => {
    try {
      return {
        header: accessHeaderSchema.parse(JSON.parse(Buffer.from(headerValue, "base64url").toString("utf8"))),
        claims: accessClaimsSchema.parse(JSON.parse(Buffer.from(claimsValue, "base64url").toString("utf8"))),
      };
    } catch {
      return undefined;
    }
  })();
  if (!token) return;
  const { header, claims } = token;
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== config.issuer || !claims.aud.includes(config.audience) || claims.exp <= now || claims.nbf > now + 30 || claims.iat > now + 30)
    return;
  const key = await signingKey(config.issuer, header.kid);
  if (!key || !verify("RSA-SHA256", Buffer.from(`${headerValue}.${claimsValue}`), key, Buffer.from(signature, "base64url"))) return;
  const id = `staff-${createHash("sha256").update(config.issuer).update("\0").update(claims.sub).digest("hex")}`;
  return { id, userName: claims.email };
}
