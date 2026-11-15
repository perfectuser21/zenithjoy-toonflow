// Root publishes this state while holding the ingress lock exclusively.
// The state is a gate, not proof that the guard checks have succeeded.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const keys = ['attemptId', 'bootId', 'generationId', 'guardInvocationId', 'manifestSha256', 'state', 'version'];

export type IngressGeneration = {
  version: 1;
  state: 'blocked' | 'allowed';
  bootId: string;
  generationId: string;
  attemptId: string | null;
  guardInvocationId: string | null;
  manifestSha256: string | null;
};

export function parseIngressGeneration(raw: string, bootId: string): IngressGeneration {
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      JSON.stringify(value) !== raw || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(keys) ||
      value.version !== 1 || typeof value.bootId !== 'string' || !uuid.test(value.bootId) || value.bootId !== bootId ||
      typeof value.generationId !== 'string' || !uuid.test(value.generationId)) {
    throw new Error('入口代际状态无效');
  }
  if (value.state === 'blocked') {
    if (value.attemptId !== null || value.guardInvocationId !== null || value.manifestSha256 !== null) throw new Error('入口阻断状态无效');
  } else if (value.state === 'allowed') {
    if (typeof value.attemptId !== 'string' || !uuid.test(value.attemptId) ||
        typeof value.guardInvocationId !== 'string' || !/^[0-9a-f]{32}$/.test(value.guardInvocationId) ||
        typeof value.manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.manifestSha256)) throw new Error('入口允许状态无效');
  } else throw new Error('入口代际状态未知');
  return value as IngressGeneration;
}

export function requireAllowedIngressGeneration(raw: string, bootId: string): IngressGeneration {
  const value = parseIngressGeneration(raw, bootId);
  if (value.state !== 'allowed') throw new Error('入口代际尚未放行');
  return value;
}
