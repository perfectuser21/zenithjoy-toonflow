import { remakeMovieOptions } from "./remakeMovieOptions";
import { callRemakeApi, remakeJobSchema, type RemakeState } from "./remakeWorkflow";

type MovieAction = "continue" | "finish" | "retry";

export async function runRemakeMovie(input: {
  action: MovieAction;
  partIndex?: number;
  view: RemakeState;
  modelId?: string;
  signal: AbortSignal;
  confirmCharge(message: string, signal: AbortSignal): Promise<boolean>;
  save(view: RemakeState, signal: AbortSignal): Promise<void>;
  completeMovie(path: string, view: RemakeState, signal: AbortSignal): Promise<void>;
  progress(message: string): void;
}) {
  const { action, partIndex, view, modelId, signal, confirmCharge, save, completeMovie, progress } = input;
  const options = remakeMovieOptions(view);
  if (!view.job) {
    if (!modelId) throw new Error("请选择成片模型");
    if (!await confirmCharge(`按原切点生成 ${options.length} 段${view.productSwap ? "换品" : ""}视频。每段将按模型规则计费。`, signal)) return;
    view.job = { id: crypto.randomUUID(), outputId: crypto.randomUUID(), modelId, phase: "preparing", parts: [] };
    try { await save(view, signal); } catch (error) { view.job = undefined; throw error; }
  }
  const job = view.job;
  const key = { directory: view.directory, jobId: job.id };
  const read = async (operation: "prepare" | "confirm" | "status" | "finish" | "retry", fields: object = {}) => {
    const result = await callRemakeApi(operation, { ...key, ...fields }, remakeJobSchema, signal);
    if (result.jobId !== job.id || result.parts.length !== view.shots.length || result.parts.some((part, index) => {
      const shot = view.analysis.scenes[index]!;
      return Math.abs(part.startSeconds - shot.start) > 0.005 || Math.abs(part.endSeconds - shot.end) > 0.005;
    })) throw new Error("成片任务与确认的镜头时间轴不一致，请复查任务");
    job.parts = result.parts;
    return result;
  };
  if (job.phase === "preparing") {
    await read("prepare", { videoPath: view.source, sourceRevision: view.analysis.sourceRevision, cuts: view.analysis.scenes.slice(1).map(shot => shot.start) });
    job.phase = "confirming";
    await save(view, signal);
  }
  if (job.phase === "confirming") {
    const existing = await read("status");
    if (existing.stage === "prepared") await read("confirm", { ...options[0], modelId: job.modelId, confirmed: true, shots: options });
    else if (!["confirmed", "completed"].includes(existing.stage)) throw new Error("成片确认结果需要复查");
    job.phase = "confirmed";
    await save(view, signal);
  }
  if (action === "retry" && !job.retry && partIndex !== undefined) {
    const part = job.parts[partIndex];
    if (part?.state !== "failed" && part?.state !== "succeeded") throw new Error("该片段的供应商状态不确定，请先复查原任务");
    if (!await confirmCharge(`单独重做第 ${partIndex + 1} 段，并按模型规则计费。`, signal)) return;
    job.retry = { index: partIndex, id: crypto.randomUUID(), ...(job.phase === "completed" ? { nextOutputId: crypto.randomUUID() } : {}) };
    try { await save(view, signal); } catch (error) { job.retry = undefined; throw error; }
  }
  if (job.retry) {
    const retry = job.retry;
    await read("retry", { partIndex: retry.index, requestId: retry.id });
    const previous = { phase: job.phase, result: job.result, outputId: job.outputId };
    job.retry = undefined;
    job.phase = "confirmed";
    job.result = undefined;
    if (retry.nextOutputId) job.outputId = retry.nextOutputId;
    try { await save(view, signal); } catch (error) { Object.assign(job, previous, { retry }); throw error; }
  }
  if (job.phase === "review" && action === "finish") {
    const result = await read("finish");
    if (result.stage !== "completed" || !result.resultPath) throw new Error("合成状态待确认，请复查原任务");
    await completeMovie(result.resultPath, view, signal);
    return;
  }
  while (job.phase === "confirmed") {
    signal.throwIfAborted();
    const result = await read("status", { resume: true });
    if (result.stage === "completed" && result.resultPath) {
      await completeMovie(result.resultPath, view, signal);
      return;
    }
    if (result.stage !== "confirmed") throw new Error("成片任务状态需要复查");
    if (result.parts.some(part => part.state === "unknown" || part.state === "cancelled")) {
      await save(view, signal);
      throw new Error("部分片段的供应商状态待确认，已保留原任务，复查前不会重新提交");
    }
    if (result.parts.some(part => part.state === "failed")) {
      await save(view, signal);
      throw new Error("部分片段生成失败，可以单独重做已确认失败的片段");
    }
    const finished = result.parts.filter(part => part.state === "succeeded").length;
    if (finished === result.parts.length) {
      job.phase = "review";
      await save(view, signal);
      progress("所有片段已生成。预览确认后可以合成。");
      return;
    }
    progress(`正在处理片段 ${finished}/${result.parts.length}`);
    await new Promise<void>(resolve => window.setTimeout(resolve, 2500));
  }
}
