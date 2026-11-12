<template>
  <el-dialog v-model="visible" title="换背景" width="680px" alignCenter appendToBody destroyOnClose :style="{ maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100vh - 24px)', boxSizing: 'border-box' }">
    <div class="backgroundPanel nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop>
      <section aria-labelledby="backgroundFrameTitle">
        <h3 id="backgroundFrameTitle">1. 提取视频画面</h3>
        <p v-if="extracting" role="status">正在提取视频画面…</p>
        <p v-else-if="frameError" role="alert">{{ frameError }}</p>
        <template v-else-if="frameUrl">
          <img class="framePreview" :src="frameUrl" alt="提取的视频画面" />
          <p>已提取视频前段画面，原视频会保留。</p>
          <p v-if="duration < 1" role="alert">视频不足 1 秒，请选择至少 1 秒的视频。</p>
          <p v-if="tooLong && batchPreparing" role="status">正在分析并切分视频，请稍候…</p>
          <p v-else-if="tooLong && batchError" role="alert">{{ batchError }}</p>
          <p v-else-if="tooLong && batch?.phase === 'preparing'" role="status">分段结果尚未确认，请复查原任务。</p>
          <p v-else-if="tooLong && batch?.cleaned">临时分段已清理；原视频、背景和最终视频保留。</p>
          <p v-else-if="tooLong && batch">已分为 {{ batch.parts.length }} 段，将按顺序使用同一个背景。</p>
          <el-button v-if="tooLong && !batchPreparing && (batch?.cleaned || batch?.phase === 'preparing' || batchError && !batch)" :disabled="busy || !!pending" @click="prepareBatch">{{ batch?.phase === 'preparing' ? '复查分段' : batch?.cleaned ? '重新准备分段' : '重试分段' }}</el-button>
        </template>
        <el-button v-if="frameError" @click="extractFrame">重新提取</el-button>
      </section>
      <section aria-labelledby="backgroundChoicesTitle">
        <h3 id="backgroundChoicesTitle">2. 选择背景</h3>
        <p>自动推荐 3 张背景图会调用图片模型，费用由您的阿里云账号承担。</p>
        <p v-if="modelsLoaded && !imageModels.length">未找到支持图片参考的图片模型，请联系管理员配置。</p>
        <div class="candidateGrid">
          <button v-for="(candidate, index) in candidates" :key="candidate.path" type="button" :class="{ selected: selectedPath === candidate.path }" :aria-pressed="selectedPath === candidate.path" :disabled="busy || !!pending || batchLocked" @click="selectedPath = candidate.path">
            <img v-if="candidateUrls[candidate.path]" :src="candidateUrls[candidate.path]" :alt="`背景候选 ${index + 1}`" />
            <span>背景 {{ index + 1 }}</span>
          </button>
        </div>
        <el-button :disabled="extracting || !!frameError || invalidDuration || busy || !!pending || batchLocked || !backgroundPrompt || !imageModel" :loading="busy && taskKind === 'image'" @click="generateCandidates">{{ candidates.length >= 3 ? '重新推荐 3 张' : candidates.length ? '继续生成候选' : '生成 3 个候选' }}</el-button>
      </section>
      <section aria-labelledby="backgroundGenerateTitle">
        <h3 id="backgroundGenerateTitle">3. 确认生成</h3>
        <p v-if="modelsLoaded && !videoModels.length">未找到支持视频和图片参考的模型，请联系管理员配置。</p>
        <p v-if="tooLong && selectedVideoModel && selectedVideoModel.providerId !== 'multiTenant'">长视频需要使用平台配置的视频模型。</p>
        <p v-else-if="selectedVideoModel && !durations.length">该模型未提供可用的生成时长。</p>
        <p>生成视频会调用视频模型并产生费用，原视频会保留；费用由您的阿里云账号承担。</p>
        <p class="reviewHint">AI 生成可能改变或新增画面，请播放预览并核对成品。</p>
        <p v-if="tooLong && batch && !batchLocked">确认后将分别生成 {{ batch.parts.length }} 段，逐段产生费用，全部成功后合成为一个视频。</p>
        <p v-if="tooLong && batchProgress" role="status" aria-live="polite">{{ batchProgress }}</p>
        <p v-if="tooLong && batch && ['confirming', 'confirmed'].includes(batch.phase)">可以关闭窗口后重新打开查看；关闭窗口不会停止云端任务。</p>
        <ol v-if="tooLong && batch" class="segmentList">
          <li v-for="(part, index) in batch.parts" :key="part.taskId">第 {{ index + 1 }} 段（{{ part.startSeconds.toFixed(1) }}–{{ part.endSeconds.toFixed(1) }} 秒）：{{ segmentStatus(part.state) }}</li>
        </ol>
        <p v-if="batchError && batch" role="alert">{{ batchError }}</p>
        <el-button v-if="batchLocked && !batchPolling && batch?.phase !== 'completed' && batch?.phase !== 'preparing'" @click="pollBatch">复查长视频任务</el-button>
        <p role="status">{{ statusText }}</p>
        <p v-if="pending && pending.source !== file?.url" role="alert">上次任务使用的是之前的视频，请先复查该任务。</p>
        <p v-if="taskError" role="alert">{{ taskError }}</p>
        <el-button v-if="pending && !busy" @click="resumeTask">复查任务</el-button>
        <div v-if="resultFile" class="resultPreview">
          <h4>成品预览</h4>
          <p>请检查整个视频，原视频仍然保留。</p>
          <video v-if="resultUrl" :src="resultUrl" controls playsinline preload="metadata" aria-label="换背景成品预览" @error="resultPreviewError = '无法播放成品，请在画布的视频节点中重试。'" />
          <p v-if="resultPreviewError" role="alert">{{ resultPreviewError }}</p>
        </div>
        <details v-if="tooLong && batch && !batch.cleaned && batch.parts.some(part => part.state === 'succeeded')" class="segmentPreview" @toggle="onSegmentToggle">
          <summary>逐段预览</summary>
          <p>选择已生成的片段播放，检查是否有意外变化。</p>
          <p v-if="batch.parts.some(part => part.state === 'succeeded' && !part.resultPath)">部分历史任务未保留片段预览，请检查合成成品。</p>
          <div class="segmentButtons">
            <el-button v-for="(part, index) in batch.parts" :key="part.taskId" :disabled="part.state !== 'succeeded' || !part.resultPath" :aria-pressed="selectedSegment?.url === part.resultPath" @click="selectSegment(part)">第 {{ index + 1 }} 段</el-button>
          </div>
          <video v-if="segmentUrl" :src="segmentUrl" controls playsinline preload="metadata" aria-label="换背景片段预览" @error="segmentPreviewError = '无法播放片段，请稍后重试。'" />
          <p v-if="segmentPreviewError" role="alert">{{ segmentPreviewError }}</p>
        </details>
      </section>
      <details class="advancedSettings" @toggle="onAdvancedToggle">
        <summary>高级设置</summary>
        <label>背景要求（可修改后重新推荐） <input v-model.trim="backgroundPrompt" :disabled="busy || !!pending" placeholder="例如：明亮的咖啡馆" /></label>
        <label>图片模型
          <select v-model="imageModel" :disabled="busy || !!pending"><option value="">请选择图片模型</option><option v-for="model in imageModels" :key="modelKey(model)" :value="modelKey(model)">{{ modelLabel(model) }}</option></select>
        </label>
        <label>视频模型
          <select v-model="videoModel" :disabled="busy || !!pending"><option value="">请选择支持视频与图片参考的模型</option><option v-for="model in videoModels" :key="modelKey(model)" :value="modelKey(model)">{{ modelLabel(model) }}</option></select>
        </label>
        <label v-if="!tooLong && durations.length">生成时长
          <select v-model.number="outputDuration" :disabled="busy || !!pending"><option v-for="value in durations" :key="value" :value="value">{{ value }} 秒</option></select>
        </label>
        <p v-if="reservationsLoading" role="status">正在检查任务空间…</p>
        <p v-if="interruptedReservations" role="alert">{{ interruptedReservations }} 项处理中断，请联系管理员处理。</p>
        <p v-if="otherReservations" role="alert">另有 {{ otherReservations }} 项任务空间记录需联系管理员处理。</p>
        <p v-if="interruptedReservations || otherReservations">状态未知的任务不会自动重发，未核实的空间不会自动释放。</p>
        <p v-if="reservationsError" role="alert">{{ reservationsError }}</p>
        <el-button v-if="reservationsError" :loading="reservationsLoading" @click="loadReservations">重新检查任务空间</el-button>
        <template v-if="batch">
          <el-button v-if="!batch.cleaned" :loading="cleanupBusy" :disabled="busy || !!pending || batchPolling || batchPreparing || !canCleanup" @click="cleanupBatch">{{ batch.cleanupPending ? '核查清理结果' : '清理本任务临时文件' }}</el-button>
          <p v-if="!canCleanup && !batch.cleaned">任务仍在执行或状态未确认，暂不能清理，请先核查任务。</p>
          <p v-if="cleanupMessage" role="status">{{ cleanupMessage }}</p>
          <p v-if="cleanupError" role="alert">{{ cleanupError }}</p>
        </template>
      </details>
    </div>
    <template #footer>
      <div class="panelActions">
        <el-button @click="visible = false">关闭</el-button>
        <el-button type="primary" :loading="busy && taskKind === 'video' || batchPolling" :disabled="extracting || invalidDuration || busy || !!pending || batchPreparing || batchLocked || !selectedPath || !selectedVideoModel || (tooLong ? !batch || selectedVideoModel.providerId !== 'multiTenant' : !outputDuration)" @click="tooLong ? confirmBatch() : generateVideo()">确认生成</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { ElButton, ElDialog, ElMessageBox } from "element-plus";
import { useNode, useVueFlow } from "@vue-flow/core";
import { getNodeModelIdentity, useNodeAi, useNodeFiles, type NodeMediaModel, type NodeMediaResult, type NodeMediaValue, type NodeVideoRequest } from "@toonflow/nodes-scaffold/runtime";
import { useNodePersistence, type NodePersistenceContext } from "@toonflow/nodes-scaffold/nodeDocument";
import { getMediaMimeType } from "@toonflow/node-shared/mediaTypes";

const props = defineProps<{ file?: NodeMediaValue; src: string; disabled?: boolean }>();
const visible = defineModel<boolean>({ required: true });
const getCanvas = inject<(() => { id: string } | undefined) | undefined>("canvas", undefined);
const { node, id } = useNode();
const { addNodes, findNode, nodeTypes } = useVueFlow();
const files = useNodeFiles();
const ai = useNodeAi();
const getPersistence = useNodePersistence();
type BackgroundTask = { taskId: string; directory: string; canvasPath: string; source: string; kind: "image" | "video"; outputNodeId: string };
type BatchPart = { startSeconds: number; endSeconds: number; taskId: string; state: "pending" | "submitting" | "submitted" | "succeeded" | "failed" | "unknown" | "cancelled"; resultPath?: string };
type BatchState = { jobId: string; directory: string; canvasPath: string; source: string; outputNodeId: string; phase: "preparing" | "prepared" | "confirming" | "confirmed" | "cancelling" | "cancelled" | "completed"; parts: BatchPart[]; cleanupPending?: boolean; cleaned?: boolean };
type BackgroundState = { source: string; frame?: string; candidates: { path: string; mimeType: string }[]; pending?: BackgroundTask; batch?: BatchState; lastResult?: NodeMediaValue };
const state = computed(() => node.data.backgroundState as BackgroundState | undefined);
const resultFile = computed(() => {
  if (state.value?.source !== props.file?.url) return;
  if (state.value?.lastResult) return state.value.lastResult;
  const job = state.value?.batch;
  const output = job?.phase === "completed" ? findNode(job.outputNodeId)?.data?.outputs?.video : undefined;
  return output?.dataType === "VIDEO" ? output.value as NodeMediaValue : undefined;
});
const resultPreviewError = ref("");
const segmentPreviewError = ref("");
const selectedSegment = ref<NodeMediaValue>();
const resultUrl = files.useFileUrl(resultFile, () => { resultPreviewError.value = "无法读取成品，请在画布的视频节点中重试。"; });
const segmentUrl = files.useFileUrl(selectedSegment, () => { segmentPreviewError.value = "无法读取片段，文件可能已清理。"; });
const candidates = computed(() => state.value?.source === props.file?.url ? state.value?.candidates ?? [] : []);
const pending = computed(() => state.value?.pending);
const batch = computed(() => state.value?.batch);
const batchLocked = computed(() => !!batch.value && (batch.value.phase !== "prepared" || !!batch.value.cleanupPending || !!batch.value.cleaned));
const canCleanup = computed(() => !!batch.value && batch.value.parts.length > 0 && (batch.value.phase === "prepared" && batch.value.parts.every(part => part.state === "pending") || batch.value.phase === "completed" && batch.value.parts.every(part => part.state === "succeeded")));
const batchPreparing = ref(false);
const batchPolling = ref(false);
const batchError = ref("");
const batchProgress = computed(() => {
  const job = batch.value;
  if (!job || !job.parts.length || !["confirming", "confirmed", "completed"].includes(job.phase)) return "";
  const completed = job.parts.filter(part => part.state === "succeeded").length;
  const total = job.parts.length;
  if (job.phase === "completed") return `全部 ${total} 段已完成。`;
  if (batchError.value) return `已完成 ${completed}/${total} 段；当前任务需要复查。`;
  const uncertain = job.parts.findIndex(part => part.state === "unknown" || part.state === "failed" || part.state === "cancelled");
  if (uncertain >= 0) return `第 ${uncertain + 1}/${total} 段需要复查；已完成 ${completed} 段。`;
  if (job.phase === "confirming") return `正在确认任务；共 ${total} 段，已完成 ${completed} 段。`;
  const running = job.parts.findIndex(part => part.state === "submitting" || part.state === "submitted");
  if (running >= 0) return `正在处理第 ${running + 1}/${total} 段；已完成 ${completed} 段。`;
  const next = job.parts.findIndex(part => part.state === "pending");
  return next >= 0 ? `等待处理第 ${next + 1}/${total} 段；已完成 ${completed} 段。` : `全部 ${total} 段已完成，正在核查合成结果。`;
});
const cleanupBusy = ref(false);
const cleanupMessage = ref("");
const cleanupError = ref("");
const reservationsLoading = ref(false);
const reservationsError = ref("");
const interruptedReservations = ref(0);
const otherReservations = ref(0);
const models = shallowRef<NodeMediaModel[]>([]);
const imageModels = computed(() => models.value.filter(item => item.type === "image" && item.mode?.some(mode => mode === "singleImage" || mode === "multiReference")));
function backgroundMode(model: NodeMediaModel) {
  return model.mode?.find((mode): mode is string[] => Array.isArray(mode) && ["image", "video"].every(type =>
    mode.some(value => { const match = value.match(new RegExp(`^${type}Reference:([0-9]+)$`)); return !!match && Number(match[1]) >= 1; })));
}
const videoModels = computed(() => models.value.filter(item => item.type === "video" && backgroundMode(item)));
const imageModel = ref("");
const videoModel = ref("");
const selectedVideoModel = computed(() => videoModels.value.find(item => modelKey(item) === videoModel.value));
const durations = computed(() => [...new Set(selectedVideoModel.value?.durationResolutionMap?.flatMap(item => item.duration) ?? [])].filter(value => value >= 1 && value <= 15).sort((a, b) => a - b));
const outputDuration = ref<number>();
const backgroundPrompt = ref("适合原视频场景的自然背景");
const selectedPath = ref("");
const candidateUrls = ref<Record<string, string>>({});
const busy = ref(false);
const taskKind = ref<"image" | "video">("image");
const statusText = ref("尚未提交生成任务。");
const taskError = ref("");
const extracting = ref(false);
const frameError = ref("");
const frameUrl = ref("");
const tooLong = ref(false);
const duration = ref(0);
const modelsLoaded = ref(false);
const frameTime = ref(0);
const invalidDuration = computed(() => !duration.value || duration.value < 1);
let controller: AbortController | undefined;
let taskController: AbortController | undefined;
let framePreparation: Promise<void> | undefined;
const lifetime = new AbortController();
let automaticHandled = false;

function modelKey(model: NodeMediaModel) { return JSON.stringify(getNodeModelIdentity(model)); }
function modelLabel(model: NodeMediaModel) { return model.providerId === "multiTenant" ? `${model.label}（平台费用；阿里云另计）` : model.label; }
function onAdvancedToggle(event: Event) {
  if ((event.target as HTMLDetailsElement).open) void loadReservations();
}

async function loadReservations() {
  const context = getPersistence?.();
  if (!context || reservationsLoading.value) return;
  if (extracting.value || busy.value || batchPreparing.value) { reservationsError.value = "视频处理中，请稍后检查任务空间。"; return; }
  reservationsLoading.value = true;
  reservationsError.value = "";
  try {
    const response = await fetch("/api/ai/media/background/reservations", {
      method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
      body: JSON.stringify({ directory: context.directory }), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)]),
    });
    const body = await response.json();
    if (!response.ok || body.code !== 200 || !Array.isArray(body.data)) throw new Error("无法检查任务空间，请稍后重试。");
    if (lifetime.signal.aborted || getPersistence?.()?.directory !== context.directory) return;
    interruptedReservations.value = body.data.filter((item: { needsAdministrator?: unknown; state?: unknown }) => item?.needsAdministrator === true && item.state === "reserved").length;
    otherReservations.value = body.data.filter((item: { needsAdministrator?: unknown; state?: unknown }) => item?.needsAdministrator === true && item.state !== "reserved").length;
  } catch {
    if (!lifetime.signal.aborted) {
      interruptedReservations.value = 0;
      otherReservations.value = 0;
      reservationsError.value = "无法检查任务空间，请稍后重试。";
    }
  } finally { reservationsLoading.value = false; }
}
function showTaskFailure(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : "";
  const timedOut = error instanceof Error && error.name === "TimeoutError" || /timed?\s*out|timeout|超时/i.test(message);
  if (pending.value) {
    statusText.value = "任务状态尚未确认。";
    taskError.value = timedOut ? "处理超时，结果尚未确认。任务不会自动重发，请先复查，避免重复扣费。" : "任务结果尚未确认。任务不会自动重发，请先复查，避免重复扣费。";
    return;
  }
  statusText.value = "任务未完成。";
  taskError.value = timedOut ? "处理超时，请重试。" : message || fallback;
}

function segmentStatus(value: BatchPart["state"]) {
  return { pending: "等待生成", submitting: "正在提交", submitted: "生成中", succeeded: "已完成", failed: "生成失败", unknown: "状态未确认", cancelled: "已停止" }[value];
}

async function batchRequest(path: "prepare" | "confirm" | "status" | "finish", data: Record<string, unknown>) {
  const response = await fetch(`/api/ai/media/background/${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
    body: JSON.stringify(data), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(path === "prepare" || path === "finish" ? 1800000 : 30000)]),
  });
  const result = await response.json();
  if (!response.ok || result.code !== 200) throw new Error(typeof result.message === "string" ? result.message : "长视频任务请求失败");
  return result.data as { jobId: string; stage: string; parts: BatchPart[]; resultPath?: string };
}

function validateBatch(value: { jobId: string; stage: string; parts: BatchPart[] }, expectedId?: string) {
  if (!value || typeof value.jobId !== "string" || !value.jobId || expectedId && value.jobId !== expectedId || !Array.isArray(value.parts) || !value.parts.length
    || value.parts.some(part => !part || typeof part.taskId !== "string" || !Number.isFinite(part.startSeconds) || !Number.isFinite(part.endSeconds)
      || part.startSeconds < 0 || part.endSeconds <= part.startSeconds || !["pending", "submitting", "submitted", "succeeded", "failed", "unknown", "cancelled"].includes(part.state))) {
    throw new Error("长视频任务响应不完整，请复查任务");
  }
}

function displayParts(parts: BatchPart[]): BatchPart[] {
  return parts.map(({ startSeconds, endSeconds, taskId, state, resultPath }) => ({ startSeconds, endSeconds, taskId, state, ...(state === "succeeded" && typeof resultPath === "string" && resultPath ? { resultPath } : {}) }));
}

function selectSegment(part: BatchPart) {
  if (batch.value?.cleaned || part.state !== "succeeded" || !part.resultPath) return;
  segmentPreviewError.value = "";
  selectedSegment.value = { url: part.resultPath, mimeType: getMediaMimeType({ name: part.resultPath, type: "" }) || "video/mp4" };
}

function onSegmentToggle(event: Event) {
  if (!(event.target as HTMLDetailsElement).open) selectedSegment.value = undefined;
}

async function prepareBatch() {
  if (!props.file || !tooLong.value || batchPreparing.value || batch.value && !batch.value.cleaned && batch.value.phase !== "preparing" || pending.value) return;
  const context = getPersistence?.();
  if (!context) { batchError.value = "画布尚未就绪，无法准备分段。"; return; }
  const source = props.file.url;
  if (batch.value?.phase === "preparing" && (batch.value.source !== source || batch.value.directory !== context.directory || batch.value.canvasPath !== context.canvasPath)) {
    batchError.value = "原分段任务属于其他视频或工作区，请先返回原画布复查。";
    return;
  }
  if (!state.value || state.value.source !== source) node.data.backgroundState = { source, candidates: [] } satisfies BackgroundState;
  batchPreparing.value = true;
  batchError.value = "";
  cleanupMessage.value = "";
  cleanupError.value = "";
  try {
    await ensureBackgroundFrame(context, source);
    lifetime.signal.throwIfAborted();
    let job = state.value!.batch;
    if (!job || job.cleaned) {
      const previous = job;
      job = { jobId: crypto.randomUUID(), directory: context.directory, canvasPath: context.canvasPath, source, outputNodeId: crypto.randomUUID(), phase: "preparing", parts: [] };
      state.value!.batch = job;
      job = state.value!.batch!;
      try { await saveState(); } catch (error) { state.value!.batch = previous; throw error; }
    }
    lifetime.signal.throwIfAborted();
    if (state.value?.batch?.jobId !== job.jobId || props.file?.url !== source || getPersistence?.()?.directory !== context.directory || getPersistence?.()?.canvasPath !== context.canvasPath) throw new Error("画布或视频已变化，请返回原画布复查分段");
    const result = await batchRequest("prepare", { directory: context.directory, videoPath: source, jobId: job.jobId });
    lifetime.signal.throwIfAborted();
    validateBatch(result, job.jobId);
    if (result.stage !== "prepared" || props.file?.url !== source || state.value?.source !== source || state.value?.batch?.jobId !== job.jobId || getPersistence?.()?.directory !== context.directory || getPersistence?.()?.canvasPath !== context.canvasPath) throw new Error("画布或视频已变化，请返回原画布复查分段");
    job.parts = displayParts(result.parts);
    job.phase = "prepared";
    try { await saveState(); } catch (error) { job.phase = "preparing"; throw error; }
  } catch (error) {
    if (!lifetime.signal.aborted) batchError.value = batch.value?.phase === "preparing" ? "分段结果尚未确认，请复查原任务；如持续无法恢复，请联系管理员。" : error instanceof Error ? error.message : "准备分段失败，请重试";
  } finally { batchPreparing.value = false; }
}

async function ensureBackgroundFrame(context: NodePersistenceContext, source: string) {
  if (state.value?.source === source && state.value.frame) return;
  if (framePreparation) return framePreparation;
  const request = (async () => {
    const response = await fetch("/api/ai/media/background/frame", { method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, body: JSON.stringify({ directory: context.directory, videoPath: source, timeSeconds: frameTime.value }), signal: lifetime.signal });
    const body = await response.json();
    lifetime.signal.throwIfAborted();
    if (!response.ok || body.code !== 200 || typeof body.data?.path !== "string") throw new Error(body.message || "提取画面失败");
    if (state.value?.source !== source || props.file?.url !== source || getPersistence?.()?.directory !== context.directory || getPersistence?.()?.canvasPath !== context.canvasPath) throw new Error("画布或视频已变化，请重新操作");
    state.value.frame = body.data.path;
    await saveState();
  })();
  framePreparation = request;
  try { await request; } finally { if (framePreparation === request) framePreparation = undefined; }
}

async function cleanupBatch() {
  const job = batch.value;
  const context = getPersistence?.();
  if (!job || job.cleaned || !canCleanup.value || !context || context.directory !== job.directory || context.canvasPath !== job.canvasPath || cleanupBusy.value || batchPolling.value || busy.value || pending.value) return;
  if (!job.cleanupPending) {
    try {
      await ElMessageBox.confirm("将清理本任务生成的分段和临时文件，保留原视频、选定背景和最终视频。已提交或状态不明的任务无法清理。确认清理吗？", "清理本任务临时文件", { confirmButtonText: "确认清理", cancelButtonText: "暂不清理", type: "warning" });
    } catch { return; }
  }
  if (lifetime.signal.aborted || batch.value?.jobId !== job.jobId || !canCleanup.value || batchPolling.value || busy.value || pending.value || getPersistence?.()?.directory !== job.directory || getPersistence?.()?.canvasPath !== job.canvasPath) return;
  cleanupBusy.value = true;
  cleanupError.value = "";
  cleanupMessage.value = "正在核查任务并清理临时文件…";
  try {
    if (!job.cleanupPending) {
      job.cleanupPending = true;
      try { await saveState(); } catch (error) { job.cleanupPending = false; throw error; }
    }
    lifetime.signal.throwIfAborted();
    const response = await fetch("/api/ai/media/background/cleanup", { method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, body: JSON.stringify({ directory: job.directory, jobId: job.jobId, confirmed: true }), signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30000)]) });
    const body = await response.json();
    if (!response.ok || body.code !== 200) throw new Error(typeof body.message === "string" ? body.message : "清理请求未完成");
    if (body.data?.cleaned !== true || !Number.isSafeInteger(body.data?.releasedBytes) || body.data.releasedBytes < 0) throw new Error("清理结果尚未确认");
    if (batch.value?.jobId !== job.jobId || findNode(id) !== node) throw new Error("画布已变化，请重新打开后核查清理结果");
    job.cleaned = true;
    job.cleanupPending = false;
    cleanupMessage.value = `本次已清理临时文件，释放 ${body.data.releasedBytes.toLocaleString()} 字节任务空间；原视频、背景和最终视频保留。`;
    try { await saveState(); } catch { cleanupError.value = "清理已完成，但画布状态未保存，请重新打开后核查。"; }
  } catch (error) {
    if (!lifetime.signal.aborted) {
      cleanupMessage.value = "";
      cleanupError.value = `${error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ? error.message : "清理结果尚未确认"}。请先核查清理结果，不要重新生成。`;
    }
  } finally { cleanupBusy.value = false; }
}

async function completeBatch(result: { resultPath?: string }, job: BatchState) {
  if (!result.resultPath || typeof result.resultPath !== "string") throw new Error("合成结果尚未确认，请复查任务");
  const background = state.value;
  if (!background || background.batch?.jobId !== job.jobId || findNode(id) !== node || getPersistence?.()?.directory !== job.directory || getPersistence?.()?.canvasPath !== job.canvasPath) throw new Error("画布已变化，请重新打开后复查任务");
  if (!nodeTypes?.value?.["remote-videoNode"]) throw new Error("请启用视频节点插件，再复查任务");
  if (!findNode(job.outputNodeId)) addNodes({ id: job.outputNodeId, type: "remote-videoNode", position: { x: node.computedPosition.x + (node.dimensions.width || 320) + 80, y: node.computedPosition.y }, data: { label: "换背景视频", outputs: { video: { dataType: "VIDEO", value: { url: result.resultPath, mimeType: "video/mp4" } } } } });
  const previousResult = background.lastResult;
  background.lastResult = { url: result.resultPath, mimeType: "video/mp4" };
  job.phase = "completed";
  try { await saveState(); } catch (error) { job.phase = "confirmed"; background.lastResult = previousResult; throw error; }
  statusText.value = "已合成为新视频，原视频已保留。请播放并检查全部画面。";
}

async function pollBatch() {
  const job = batch.value;
  const context = getPersistence?.();
  if (!job || !context || context.directory !== job.directory || context.canvasPath !== job.canvasPath || batchPolling.value || job.phase === "completed") return;
  batchPolling.value = true;
  batchError.value = "";
  try {
    while (!lifetime.signal.aborted) {
      const result = await batchRequest("status", { directory: job.directory, jobId: job.jobId, resume: true });
      validateBatch(result, job.jobId);
      if (state.value?.batch?.jobId !== job.jobId || getPersistence?.()?.directory !== job.directory || getPersistence?.()?.canvasPath !== job.canvasPath) throw new Error("画布已变化，请重新打开后复查任务");
      job.parts = displayParts(result.parts);
      if (result.stage === "prepared") {
        job.phase = "prepared";
        await saveState();
        statusText.value = "尚未开始生成，请选择背景后确认。";
        return;
      }
      if (result.stage === "completed") { await completeBatch(result, job); return; }
      if (result.stage === "cancelling" || result.stage === "cancelled") {
        job.phase = result.stage;
        await saveState();
        statusText.value = "任务已请求停止；云端任务是否停止及费用情况请先核查。";
        return;
      }
      if (result.stage !== "confirmed") throw new Error("任务状态尚未确认，请稍后复查");
      job.phase = "confirmed";
      await saveState();
      if (job.parts.some(part => part.state === "unknown" || part.state === "failed" || part.state === "cancelled")) {
        batchError.value = "部分片段生成失败或状态未知，不会自动重发；请先核查任务，避免重复扣费。";
        statusText.value = "长视频任务尚未完成，已保留原视频和片段。";
        return;
      }
      if (job.parts.every(part => part.state === "succeeded")) {
        statusText.value = "片段已完成，正在合成视频…";
        const finished = await batchRequest("finish", { directory: job.directory, jobId: job.jobId });
        validateBatch(finished, job.jobId);
        if (finished.stage !== "completed") throw new Error("合成结果尚未确认，请复查任务");
        await completeBatch(finished, job);
        return;
      }
      statusText.value = `正在生成片段：${job.parts.filter(part => part.state === "succeeded").length}/${job.parts.length} 已完成。`;
      await new Promise<void>(resolve => window.setTimeout(resolve, 3000));
    }
  } catch {
    if (!lifetime.signal.aborted) { batchError.value = "长视频任务状态尚未确认；状态未知的片段不会自动重发，请先复查，避免重复扣费。"; statusText.value = "已保留原视频和任务记录。"; }
  } finally { batchPolling.value = false; }
}

async function confirmBatch() {
  const job = batch.value;
  const selected = candidates.value.find(item => item.path === selectedPath.value);
  if (!job || job.phase !== "prepared" || !selected || !selectedVideoModel.value || selectedVideoModel.value.providerId !== "multiTenant" || busy.value || pending.value || batchPolling.value) return;
  job.phase = "confirming";
  batchError.value = "";
  try {
    await saveState();
    lifetime.signal.throwIfAborted();
    const result = await batchRequest("confirm", { directory: job.directory, jobId: job.jobId, confirmed: true, image: { path: selected.path, mimeType: selected.mimeType }, modelId: getNodeModelIdentity(selectedVideoModel.value).modelId, prompt: "使用参考图片更换视频背景，保持原视频人物、动作和镜头运动。" });
    validateBatch(result, job.jobId);
    if (result.stage !== "confirmed") throw new Error("任务确认结果未知");
    job.phase = "confirmed";
    await saveState();
    await pollBatch();
  } catch {
    if (!lifetime.signal.aborted) { batchError.value = "任务确认结果尚未确认。请先复查任务，避免重复扣费。"; statusText.value = "已保留原视频和任务记录。"; }
  }
}

watch([durations, duration], ([values, sourceDuration]) => {
  outputDuration.value = values.includes(outputDuration.value!) ? outputDuration.value : values.reduce<number | undefined>((best, value) => best === undefined || Math.abs(value - sourceDuration) < Math.abs(best - sourceDuration) ? value : best, undefined);
}, { immediate: true });

watch([frameUrl, modelsLoaded], ([frame, loaded]) => {
  if (automaticHandled || !frame || !loaded || invalidDuration.value) return;
  automaticHandled = true;
  if (imageModel.value && !pending.value && !batchLocked.value && state.value?.source !== props.file?.url) void generateCandidates();
  if (tooLong.value && !batch.value && !pending.value) void prepareBatch();
});

async function saveState() {
  const context = getPersistence?.();
  if (!context || findNode(id) !== node) throw new Error("画布已关闭或节点已变化，无法保存任务");
  await context.save();
}

async function clearPending(task: BackgroundTask) {
  if (!state.value || state.value.pending?.taskId !== task.taskId) return;
  state.value.pending = undefined;
  try { await saveState(); } catch (error) { state.value.pending = task; throw error; }
}

async function loadCandidateUrls() {
  const next: Record<string, string> = {};
  const workspace = files.getWorkspaceFiles();
  try {
    for (const candidate of candidates.value) {
      const data = await workspace.read(candidate.path);
      lifetime.signal.throwIfAborted();
      next[candidate.path] = URL.createObjectURL(new Blob([data], { type: candidate.mimeType }));
    }
    for (const url of Object.values(candidateUrls.value)) URL.revokeObjectURL(url);
    candidateUrls.value = next;
  } catch (error) {
    for (const url of Object.values(next)) URL.revokeObjectURL(url);
    throw error;
  }
}

async function applyResult(task: BackgroundTask, results: NodeMediaResult[]) {
  const result = results[0];
  if (!result || result.mediaType !== task.kind) throw new Error("任务未返回对应的媒体文件，请复查任务");
  if (!state.value || state.value.pending?.taskId !== task.taskId || state.value.source !== task.source || findNode(id) !== node) throw new Error("画布或视频已变化，请复查任务");
  const previousResult = state.value.lastResult;
  if (task.kind === "image") {
    if (!state.value.candidates.some(item => item.path === result.path)) state.value.candidates.push({ path: result.path, mimeType: result.mimeType });
  } else {
    if (!nodeTypes?.value?.["remote-videoNode"]) throw new Error("请启用视频节点插件，再复查任务");
    if (!findNode(task.outputNodeId)) addNodes({ id: task.outputNodeId, type: "remote-videoNode", position: { x: node.computedPosition.x + (node.dimensions.width || 320) + 80, y: node.computedPosition.y }, data: { label: "换背景视频", outputs: { video: { dataType: "VIDEO", value: { url: result.path, mimeType: result.mimeType } } } } });
    state.value.lastResult = { url: result.path, mimeType: result.mimeType };
  }
  state.value.pending = undefined;
  try { await saveState(); }
  catch (error) { state.value.pending = task; state.value.lastResult = previousResult; throw error; }
  if (task.kind === "image") await loadCandidateUrls();
}

async function resumeTask() {
  const task = pending.value;
  const context = getPersistence?.();
  if (!task || !context || context.directory !== task.directory || context.canvasPath !== task.canvasPath || busy.value) return;
  busy.value = true;
  taskKind.value = task.kind;
  taskError.value = "";
  statusText.value = "正在复查已提交的任务…";
  const request = taskController = new AbortController();
  let terminalFailed = false;
  try {
    const results = await ai.resumeMedia(task.directory, task.taskId, request.signal, { nodeId: id, canvasPath: task.canvasPath, onStatus: status => { terminalFailed = !!status.result && (status.state === "failed" || status.state === "cancelled"); } });
    lifetime.signal.throwIfAborted();
    await applyResult(task, results);
    statusText.value = task.kind === "image" ? "候选图已生成。" : "生成完成，原视频已保留。请播放并检查全部画面。";
  } catch (error) {
    if (terminalFailed) await clearPending(task).catch(() => {});
    if (!request.signal.aborted) showTaskFailure(error, "任务复查失败");
  } finally { if (taskController === request) taskController = undefined; busy.value = false; }
}

async function submitTask(kind: "image" | "video", input: Parameters<typeof ai.generateImage>[0] | Parameters<typeof ai.generateVideo>[0]) {
  lifetime.signal.throwIfAborted();
  const context = getPersistence?.();
  if (!context || !props.file || !state.value || pending.value) throw new Error("工作区未就绪或仍有待复查任务");
  const task: BackgroundTask = { taskId: crypto.randomUUID(), directory: context.directory, canvasPath: context.canvasPath, source: props.file.url, kind, outputNodeId: crypto.randomUUID() };
  state.value.pending = task;
  try { await saveState(); lifetime.signal.throwIfAborted(); } catch (error) { state.value.pending = undefined; await saveState(); throw error; }
  const request = taskController = new AbortController();
  let terminalFailed = false;
  try {
    const options = { taskId: task.taskId, nodeId: id, canvasPath: task.canvasPath, onStatus: (status: { state?: string; result?: unknown }) => { terminalFailed = !!status.result && (status.state === "failed" || status.state === "cancelled"); } };
    const results = kind === "image" ? await ai.generateImage(input as Parameters<typeof ai.generateImage>[0], request.signal, options) : await ai.generateVideo(input as Parameters<typeof ai.generateVideo>[0], request.signal, options);
    lifetime.signal.throwIfAborted();
    await applyResult(task, results);
  } catch (error) {
    if ((error as { mediaTaskRejected?: boolean })?.mediaTaskRejected || terminalFailed) await clearPending(task);
    throw error;
  } finally { if (taskController === request) taskController = undefined; }
}

async function generateCandidates() {
  if (!props.file || !backgroundPrompt.value || !imageModel.value || invalidDuration.value || busy.value || pending.value || batchLocked.value) return;
  busy.value = true; taskKind.value = "image"; taskError.value = "";
  try {
    const context = getPersistence?.();
    if (!context) throw new Error("画布尚未就绪");
    if (!state.value || state.value.source !== props.file.url) node.data.backgroundState = { source: props.file.url, candidates: [] } satisfies BackgroundState;
    if (!state.value!.frame) {
      statusText.value = "正在提取用于生成的画面…";
      const source = props.file.url;
      await ensureBackgroundFrame(context, source);
    }
    if (tooLong.value && !batch.value && !batchPreparing.value) void prepareBatch();
    const identity = JSON.parse(imageModel.value) as ReturnType<typeof getNodeModelIdentity>;
    const targetCount = candidates.value.length < 3 ? 3 : candidates.value.length + 3;
    while (candidates.value.length < targetCount) {
      lifetime.signal.throwIfAborted();
      statusText.value = `正在生成第 ${candidates.value.length + 1} 张候选图…`;
      await submitTask("image", { ...identity, directory: context.directory, outputDirectory: "assets/generated", prompt: `为参考视频画面设计新的场景背景：${backgroundPrompt.value}。匹配参考画面的光线、色温、透视和镜头角度，仅生成空场景背景，不生成或复制人物、动物、前景主体及文字。`, images: [{ path: state.value!.frame!, mimeType: "image/png" }] });
    }
    statusText.value = "候选图已生成，请选择一张。";
  } catch (error) { if (!lifetime.signal.aborted) showTaskFailure(error, "候选生成失败"); }
  finally { busy.value = false; }
}

async function generateVideo() {
  if (!props.file || !selectedPath.value || !selectedVideoModel.value || !outputDuration.value || invalidDuration.value || busy.value || pending.value) return;
  busy.value = true; taskKind.value = "video"; taskError.value = ""; statusText.value = "正在生成视频，原视频会保留…";
  try {
    const context = getPersistence?.();
    if (!context) throw new Error("画布尚未就绪");
    const selected = candidates.value.find(item => item.path === selectedPath.value);
    if (!selected) throw new Error("所选背景已失效，请重新选择");
    const mode = backgroundMode(selectedVideoModel.value);
    if (!mode) throw new Error("所选模型不支持视频与图片参考");
    await submitTask("video", { ...getNodeModelIdentity(selectedVideoModel.value), directory: context.directory, outputDirectory: "assets/generated", prompt: "使用参考图片更换视频背景，保持原视频人物、动作和镜头运动。", videos: [{ path: props.file.url, mimeType: props.file.mimeType }], images: [{ path: selected.path, mimeType: selected.mimeType }], mode: mode as NodeVideoRequest["mode"], duration: outputDuration.value });
    statusText.value = "生成完成，原视频已保留。请播放并检查全部画面。";
  } catch (error) { if (!lifetime.signal.aborted) showTaskFailure(error, "视频生成失败"); }
  finally { busy.value = false; }
}

function clearFrame() {
  controller?.abort();
  controller = undefined;
  if (frameUrl.value) URL.revokeObjectURL(frameUrl.value);
  frameUrl.value = "";
}

async function extractFrame() {
  clearFrame();
  if (!props.file || !props.src || props.disabled) return;
  const request = new AbortController();
  controller = request;
  extracting.value = true;
  frameError.value = "";
  tooLong.value = false;
  duration.value = 0;
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => finish(new Error("读取视频超时，请重试")), 15000);
      function finish(error?: unknown) {
        clearTimeout(timer);
        video.onloadeddata = null;
        video.onseeked = null;
        video.onerror = null;
        request.signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      }
      function abort() { finish(new DOMException("已取消", "AbortError")); }
      video.onloadeddata = () => {
        if (!Number.isFinite(video.duration) || video.duration <= 0) return finish(new Error("无法读取视频时长，请更换视频后重试"));
        frameTime.value = Math.min(3, video.duration * 0.1);
        video.currentTime = frameTime.value;
      };
      video.onseeked = () => finish();
      video.onerror = () => finish(new Error("无法读取视频画面，请检查视频格式后重试"));
      request.signal.addEventListener("abort", abort, { once: true });
      video.src = props.src;
      video.load();
      if (request.signal.aborted) abort();
    });
    request.signal.throwIfAborted();
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("无法读取视频时长，请更换视频后重试");
    duration.value = video.duration;
    tooLong.value = video.duration > 15;
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext("2d");
    if (!context || !canvas.width || !canvas.height) throw new Error("视频画面尚未准备好，请重试");
    context.drawImage(video, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("提取视频画面失败，请重试")), "image/png"));
    request.signal.throwIfAborted();
    frameUrl.value = URL.createObjectURL(blob);
  } catch (error) {
    if (!request.signal.aborted) frameError.value = error instanceof Error ? error.message : "提取视频画面失败，请重试";
  } finally {
    video.removeAttribute("src");
    video.load();
    if (controller === request) { controller = undefined; extracting.value = false; }
  }
}

watch(() => [props.file?.url, props.src, props.disabled, getCanvas?.()?.id], () => { visible.value = false; clearFrame(); }, { flush: "sync" });
watch(() => [batch.value?.cleaned, batch.value?.cleanupPending], ([cleaned, cleaning]) => { if (cleaned || cleaning) selectedSegment.value = undefined; });
watch(resultFile, () => { resultPreviewError.value = ""; });
onMounted(() => {
  void extractFrame();
  void ai.getMediaModels().then(value => {
    models.value = value;
    imageModel.value = imageModels.value[0] ? modelKey(imageModels.value[0]) : "";
    videoModel.value = videoModels.value[0] ? modelKey(videoModels.value[0]) : "";
  }).catch(error => { taskError.value = error instanceof Error ? error.message : "读取模型失败"; }).finally(() => { modelsLoaded.value = true; });
  if (candidates.value.length) void loadCandidateUrls().catch(() => { taskError.value = "读取候选图片失败，请重新打开后重试"; });
  if (pending.value) statusText.value = "上次任务尚未确认，请先复查任务。";
  if (batch.value?.phase === "completed") statusText.value = "已合成为新视频，原视频已保留。请播放并检查全部画面。";
  if (batch.value && ["cancelling", "cancelled"].includes(batch.value.phase)) statusText.value = "任务已请求停止；云端任务是否停止及费用情况请先核查。";
  if (batch.value && ["confirming", "confirmed"].includes(batch.value.phase)) void pollBatch();
});
onBeforeUnmount(() => { lifetime.abort(); clearFrame(); taskController?.abort(); for (const url of Object.values(candidateUrls.value)) URL.revokeObjectURL(url); });
</script>

<style scoped lang="scss">
.backgroundPanel {
  display: grid;
  gap: 20px;
  max-height: calc(100vh - 210px);
  max-height: calc(100dvh - 210px);
  overflow-y: auto;
  overscroll-behavior: contain;

  section {
    h3 { margin: 0 0 8px; font-size: 15px; }
    p { margin: 8px 0; color: var(--el-text-color-regular); line-height: 1.6; }
    .framePreview { display: block; max-width: 100%; max-height: 240px; border-radius: var(--el-border-radius-base); }
    .candidateGrid { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
    .candidateGrid button { display: grid; gap: 4px; max-width: 150px; padding: 5px; border: 2px solid transparent; background: var(--el-fill-color-light); cursor: pointer; }
    .candidateGrid button.selected { border-color: var(--el-color-primary); }
    .candidateGrid img { max-width: 100%; max-height: 120px; }
    .segmentList { max-height: 150px; margin: 8px 0; padding-left: 24px; overflow-y: auto; line-height: 1.8; }
    .reviewHint { color: var(--el-text-color-primary); font-weight: 600; }
    .resultPreview, .segmentPreview {
      margin-top: 16px;
      h4 { margin: 0; font-size: 14px; }
      summary { cursor: pointer; }
      video { display: block; width: 100%; max-height: 280px; background: var(--el-fill-color-darker); border-radius: var(--el-border-radius-base); }
    }
    .segmentButtons { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; .el-button { margin: 0; } }
  }
  .advancedSettings {
    summary { cursor: pointer; }
    label { display: grid; gap: 4px; margin: 10px 0; }
    input, select { min-width: 0; min-height: 36px; max-width: 100%; }
  }
}
.panelActions { display: flex; justify-content: flex-end; gap: 8px; }
</style>
