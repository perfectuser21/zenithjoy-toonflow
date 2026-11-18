export function createTrimReadQueue(maxWaiting = 32, fullMessage = "裁剪预览请求过多，请稍后重试") {
  let busy = false;
  const pending = new Set<() => void>();

  async function acquire(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!busy) {
      busy = true;
      return;
    }
    if (pending.size >= maxWaiting) {
      throw Object.assign(new Error(fullMessage), { status: 429 });
    }
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        signal.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        pending.delete(start);
        reject(signal.reason);
      };
      pending.add(start);
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  async function run<T>(signal: AbortSignal, operation: () => T | Promise<T>) {
    await acquire(signal);
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      const next = pending.values().next().value;
      if (next) {
        pending.delete(next);
        next();
      } else busy = false;
    }
  }

  return { get busy() { return busy; }, run };
}
