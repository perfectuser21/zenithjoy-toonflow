import { createTrimReadQueue } from "./trimReadQueue";

type TrimJob = { operationId: string; ownerId: string; cwd: string; source: string; start: number; end: number };
type Phase = "queued" | "running";

export function createTrimJobQueue(maxWaiting = 32) {
  const execution = createTrimReadQueue(maxWaiting, "截取排队已满，请稍后重试");
  const jobs = new Map<string, { input: TrimJob; phase: Phase }>();

  function status(input: TrimJob) {
    const job = jobs.get(input.operationId);
    if (!job || input.ownerId !== job.input.ownerId || input.cwd !== job.input.cwd) return undefined;
    if (input.source !== job.input.source || input.start !== job.input.start || input.end !== job.input.end) {
      throw Object.assign(new Error("截取请求与原记录不一致"), { status: 409 });
    }
    return job.phase;
  }

  async function run<T>(input: TrimJob, signal: AbortSignal, operation: () => Promise<T>, progress: (phase: Phase) => void) {
    signal.throwIfAborted();
    if (jobs.has(input.operationId)) {
      throw Object.assign(new Error("截取任务已提交，请检查状态"), { status: 409 });
    }
    const job: { input: TrimJob; phase: Phase } = { input, phase: "queued" };
    jobs.set(input.operationId, job);
    try {
      if (execution.busy) progress("queued");
      return await execution.run(signal, () => {
        job.phase = "running";
        progress("running");
        return operation();
      });
    } finally {
      jobs.delete(input.operationId);
    }
  }

  return { run, status };
}
