<template>
  <el-dialog
    v-model="visible"
    :title="actionLabels[action]"
    :width="action === 'trim' ? '760px' : '520px'"
    :top="action === 'trim' ? '6vh' : '15vh'"
    appendToBody
    destroyOnClose
    :closeOnClickModal="!processing"
    :closeOnPressEscape="!processing"
    :showClose="!processing"
    @closed="clearPreview"
    :style="{ maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(94vh - 12px)', overflow: 'auto' }">
    <div class="videoActionPanel nodrag nopan nowheel" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop>
      <template v-if="action === 'trim'">
        <p v-if="preparingPreview || previewError" class="actionHint" role="status">{{ preparingPreview ? '正在生成兼容预览…' : previewError }}</p>
        <video ref="preview" class="clipPreview" :src="playbackSrc" controls playsinline preload="metadata" aria-label="截取片段预览" @loadedmetadata="readDuration" @timeupdate="readTime" @play="playSelection" @error="duration = 0; handleError($event)" />
        <div class="clipTimeline" :class="{ unavailable: processing || !duration }">
          <div class="timelineHeader">
            <span>拖动左右边界，选择保留的片段</span>
            <span class="sourceDuration">原视频 {{ formatTime(duration) }}</span>
          </div>
          <div class="timelineBody">
            <div ref="track" class="frameTrack" @pointerdown="seekTrack">
              <div class="filmstrip" aria-hidden="true">
                <div v-for="index in frameCount" :key="index" class="frameCell">
                  <img v-if="frames[index - 1]" :src="frames[index - 1]" alt="" draggable="false" />
                </div>
              </div>
              <div class="discardedArea" :style="{ left: 0, width: `${startPercent}%` }" />
              <div class="discardedArea" :style="{ left: `${endPercent}%`, right: 0 }" />
              <div class="selectedArea" :style="{ left: `${startPercent}%`, width: `${Math.max(0, endPercent - startPercent)}%` }" />
              <div v-if="duration" class="playhead" :style="{ left: `${Math.min(100, currentTime / duration * 100)}%` }" aria-hidden="true" />
              <button
                v-for="edge in (['start', 'end'] as const)"
                :key="edge"
                type="button"
                class="trimHandle"
                :class="{ startHandle: edge === 'start', endHandle: edge === 'end', dragging: dragging === edge }"
                :style="{ left: `${edge === 'start' ? startPercent : endPercent}%` }"
                role="slider"
                :aria-label="edge === 'start' ? '片段开始边界' : '片段结束边界'"
                aria-orientation="horizontal"
                :aria-valuemin="edge === 'start' ? 0 : start + minimumLength"
                :aria-valuemax="edge === 'start' ? Math.max(0, end - minimumLength) : clipLimit"
                :aria-valuenow="edge === 'start' ? start : end"
                :aria-valuetext="Number.isFinite(edge === 'start' ? start : end) ? `${(edge === 'start' ? start : end).toFixed(2)} 秒` : '未设置'"
                :disabled="processing || disabled || !duration"
                @pointerdown.stop.prevent="beginDrag($event, edge)"
                @pointermove.stop.prevent="moveDrag"
                @pointerup="endDrag"
                @pointercancel="endDrag"
                @lostpointercapture="endDrag"
                @keydown="changeBoundary($event, edge)">
                <span aria-hidden="true" />
              </button>
            </div>
            <div class="timeRuler" aria-hidden="true"><span v-for="index in 5" :key="index">{{ formatTime(duration * (index - 1) / 4) }}</span></div>
          </div>
        </div>
        <div class="clipTimes">
          <label><span>开始时间</span><input v-model.number="start" class="timeInput" type="number" min="0" :max="clipLimit" step="0.01" :disabled="processing || !duration" aria-label="片段开始时间" @input="seekPreview(($event.target as HTMLInputElement).valueAsNumber)" /><span>秒</span></label>
          <label><span>结束时间</span><input v-model.number="end" class="timeInput" type="number" min="0" :max="clipLimit" step="0.01" :disabled="processing || !duration" aria-label="片段结束时间" @input="seekPreview(($event.target as HTMLInputElement).valueAsNumber)" /><span>秒</span></label>
          <span class="selectionDuration">时长 {{ validRange ? (end - start).toFixed(2) : '—' }} 秒</span>
        </div>
        <p class="actionHint">{{ accountMode === 'loading' ? '正在确认账号…' : accountMode === 'error' ? accountError : pendingTrim ? '上次截取尚未确认，可检查并恢复结果。' : accountMode === 'customer' && duration > 120 ? '当前客户模式仅支持不超过 120 秒的源视频。' : validRange ? '截取后生成新视频节点，原视频会保留。' : '请选择有效的起止时间。' }}</p>
        <p v-if="accountMode === 'customer' && !pendingTrim && validRange && end - start >= 14.85 && end - start <= 15.00000001" class="actionHint">接近 15 秒的片段会转换为整数帧率，避免实际时长超出万相限制；如需保持原帧率，可截短到 14.85 秒以内。</p>
        <div v-if="accountMode === 'customer' && !pendingTrim && recoveries.length" class="actionHint">
          <p>以下是此工作区的历史截取记录。素材可能已被移动或替换，请根据路径核对结果：</p>
          <el-button v-for="item in recoveries" :key="item.operationId" :disabled="processing" @click="selectRecovery(item)">{{ item.source }} · {{ item.start.toFixed(2) }}–{{ item.end.toFixed(2) }} 秒 · {{ item.state === 'committed' ? '查看结果' : item.state === 'interrupted' ? '已中断' : '检查状态' }}</el-button>
        </div>
      </template>
      <p v-else class="actionHint">{{ action === 'extractAudio' ? '提取音轨并生成音频节点，保留原视频。' : '生成静音视频和音频两个节点，保留原视频。' }}</p>
      <div v-if="processing" class="processingStatus" role="status" aria-live="polite">
        <el-progress :percentage="100" :indeterminate="true" :showText="false" />
        <span>{{ progressLabel }}</span>
      </div>
      <div class="panelActions">
        <el-button v-if="processing && action === 'trim' && !cancelling" @click="visible = false">后台继续</el-button>
        <el-button v-if="accountMode === 'customer' && (pendingTrim?.recoverOnly || (pendingTrim && interruptedOperation === pendingTrim.operationId)) && !processing" @click="clearRecoverySelection">{{ pendingTrim && interruptedOperation === pendingTrim.operationId ? '释放空间并结束' : '放弃查看此记录' }}</el-button>
        <el-button :disabled="cancelling" @click="processing ? cancel() : visible = false">{{ processing ? '取消处理' : '取消' }}</el-button>
        <el-button type="primary" :loading="processing" :disabled="disabled || !file || (action === 'trim' && (accountMode === 'loading' || accountMode === 'error' || (!pendingTrim && !validRange)))" @click="run">{{ action === 'trim' && pendingTrim ? '检查并恢复' : actionLabels[action] }}</el-button>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useNode, useVueFlow, type Node } from "@vue-flow/core";
import { ElButton, ElDialog, ElMessage, ElMessageBox, ElProgress } from "element-plus";
import { useNodeFiles, useNodeFfmpeg, useNodeEvent, type WorkspaceFiles, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { showNodeError } from "@toonflow/node-shared/showNodeError";
import { processVideo } from "../videoProcessing";
import { canClearUnsubmittedTrim } from "./trimNotSubmitted";
import { useMediaPreview } from "@toonflow/node-shared/mediaPreview";
import { useNodePersistence } from "@toonflow/nodes-scaffold/nodeDocument";
import { EventSourceParserStream } from "eventsource-parser/stream";

const props = defineProps<{ file?: NodeMediaValue; src: string; disabled?: boolean }>();
const { node } = useNode();
const { addNodes, addEdges, removeNodes, findNode, getNodes, nodeTypes, removeSelectedElements, addSelectedNodes, nodesSelectionActive, fitView, setCenter } = useVueFlow();
const files = useNodeFiles();
const getPersistence = useNodePersistence();
const loadFfmpeg = useNodeFfmpeg();
const nodeEvent = useNodeEvent();
const getCanvas = inject<(() => { id: string } | undefined) | undefined>("canvas", undefined);
const batchHistory = inject<(action: () => Promise<void>) => Promise<void>>("batchCanvasHistory", action => action());
const actionLabels = { extractAudio: "提取音轨", separate: "分离音视频", trim: "截取片段" };
const action = ref<keyof typeof actionLabels>("trim");
const visible = ref(false);
const accountMode = ref<"loading" | "customer" | "other" | "error">("loading");
const accountError = ref("无法确认账号，请关闭后重试。");
type PendingTrim = { operationId: string; source: string; start: number; end: number; ownerId: string; directory: string; canvasPath: string; recoverOnly?: boolean };
type Recovery = { operationId: string; source: string; start: number; end: number; state: string };
const recoveries = ref<Recovery[]>([]);
const pendingTrim = computed(() => (node.data.pendingTrim ?? null) as PendingTrim | null);
const interruptedOperation = ref("");
let trimUserId = "";
let trimDirectory = "";
let trimCanvasId = "";
let trimCanvasPath = "";
const { src: playbackSrc, preparing: preparingPreview, error: previewError, handleError, handleLoaded } = useMediaPreview(() => visible.value && action.value === "trim" ? props.src : "", "video");
const processing = ref(false);
const trimQueued = ref(false);
const creatingAnalysis = ref(false);
const cancelling = ref(false);
const progressLabel = computed(() => cancelling.value ? "正在取消处理…" : trimQueued.value ? "已排队，等待截取…" : "正在处理视频…");
const backgroundProgress = computed(() => !visible.value && processing.value && action.value === "trim" ? progressLabel.value : "");
const preview = ref<HTMLVideoElement>();
const duration = ref(0);
const start = ref(0);
const end = ref(0);
const track = ref<HTMLDivElement>();
const currentTime = ref(0);
const frames = ref<string[]>([]);
const frameCount = 10;
const dragging = ref<"start" | "end">();
const clipLimit = computed(() => duration.value < 0.01 ? duration.value : Math.floor(duration.value * 100) / 100);
const minimumLength = computed(() => Math.min(0.01, clipLimit.value));
const startPercent = computed(() => duration.value && Number.isFinite(start.value) ? Math.min(100, Math.max(0, start.value / duration.value * 100)) : 0);
const endPercent = computed(() => duration.value && Number.isFinite(end.value) ? Math.min(100, Math.max(0, end.value / duration.value * 100)) : 100);
const validRange = computed(() => accountMode.value !== "loading" && accountMode.value !== "error" && !(accountMode.value === "customer" && duration.value > 120) && Number.isFinite(start.value) && Number.isFinite(end.value) && start.value >= 0 && end.value > start.value && end.value <= duration.value);
let controller: AbortController | undefined;
let job: Promise<void> | undefined;
let thumbnailVideo: HTMLVideoElement | undefined;
let thumbnailTimer: number | undefined;
let drag: { pointerId: number; target: HTMLElement; x: number; time: number; width: number } | undefined;

function cancel() {
  if (!controller) return;
  cancelling.value = true;
  controller.abort();
}

function reset() {
  cancel();
  clearPreview();
  visible.value = false;
  duration.value = 0;
}

watch(() => props.file?.url, reset, { flush: "sync" });
watch(() => props.src, reset, { flush: "sync" });
watch(() => props.disabled, disabled => { if (disabled) reset(); }, { flush: "sync" });
watch(() => getCanvas?.()?.id, reset, { flush: "sync" });
watch(visible, (value, _previous, onCleanup) => {
  if (!value) { clearPreview(); return; }
  if (action.value !== "trim") return;
  accountMode.value = "loading";
  interruptedOperation.value = "";
  recoveries.value = [];
  const check = new AbortController();
  onCleanup(() => check.abort());
  trimUserId = "";
  trimDirectory = "";
  trimCanvasId = "";
  trimCanvasPath = "";
  void usesCustomerAccount(check.signal).then(async userId => {
    if (check.signal.aborted) return;
    if (!userId) { if (pendingTrim.value) throw new Error("请使用原账号恢复未完成的截取"); accountMode.value = "other"; return; }
    const { directory } = await files.getWorkspaceFiles().list();
    const canvas = getCanvas?.()?.id;
    const persistence = getPersistence?.();
    if (!canvas || !persistence || persistence.directory !== directory) throw new Error("无法确认当前画布");
    if (await usesCustomerAccount(check.signal) !== userId || getCanvas?.()?.id !== canvas || getPersistence?.()?.canvasPath !== persistence.canvasPath) throw new Error("账号或画布已变化");
    trimDirectory = directory;
    trimCanvasId = canvas;
    trimCanvasPath = persistence.canvasPath;
    trimUserId = userId;
    const saved = pendingTrim.value;
    if (saved) {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(saved.operationId) || typeof saved.source !== "string" || !Number.isFinite(saved.start) || !Number.isFinite(saved.end)
        || saved.ownerId !== userId || saved.directory !== directory || (saved.source !== props.file?.url && saved.recoverOnly !== true)) throw new Error("裁剪记录与当前账号、工作区或视频不一致");
    }
    if (!saved) {
      const response = await fetch("/api/ffmpeg/trim/recoveries", { method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, body: JSON.stringify({ directory }), signal: check.signal });
      const body = await response.json();
      if (!response.ok || body?.code !== 200 || !Array.isArray(body.data)) throw new Error("无法读取截取记录，请稍后重试");
      if (await usesCustomerAccount(check.signal) !== userId || getCanvas?.()?.id !== canvas || getPersistence?.()?.canvasPath !== persistence.canvasPath) throw new Error("账号或画布已变化");
      recoveries.value = body.data.flatMap((item: any) => {
        const request = item?.trimRequest;
        return /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(item?.operationId) && ["reserved", "committed", "interrupted"].includes(item?.state)
          && typeof request?.source === "string" && request.source.length > 0 && request.source.length <= 4096 && Number.isFinite(request.start) && Number.isFinite(request.end) && request.start >= 0 && request.end > request.start && request.end <= 120
          ? [{ operationId: item.operationId, source: request.source, start: request.start, end: request.end, state: item.state }] : [];
      });
    }
    if (!check.signal.aborted) accountMode.value = "customer";
  })
    .catch(error => { if (!check.signal.aborted) { accountError.value = error instanceof Error ? error.message : "无法确认账号，请关闭后重试。"; accountMode.value = "error"; } });
});
watch(playbackSrc, () => { clearPreview(); duration.value = 0; frames.value = []; });
onBeforeUnmount(() => { cancel(); clearPreview(); });
nodeEvent.on("save", reason => {
  if (reason === "reload" && processing.value) throw new Error("视频处理中，请完成或取消后再刷新节点");
});
nodeEvent.on("delete", async () => { cancel(); await job; if (pendingTrim.value) throw new Error("请先恢复未完成的截取，再删除节点"); });
nodeEvent.on("copy", () => ({ pendingTrim: undefined }));

function open(value: keyof typeof actionLabels) {
  if (processing.value || creatingAnalysis.value || props.disabled || !props.file) return;
  action.value = value;
  duration.value = start.value = end.value = 0;
  currentTime.value = 0;
  frames.value = [];
  visible.value = true;
  if (value !== "trim") run();
}

async function createFrameAnalysis() {
  if (processing.value || creatingAnalysis.value || props.disabled || !props.file) return;
  const type = "remote-frameAnalysisNode";
  const canvasId = getCanvas?.()?.id;
  const source = props.file.url;
  const nodeId = crypto.randomUUID();
  creatingAnalysis.value = true;
  try {
    if (!nodeTypes?.value?.[type]) throw new Error("请先启用逐帧拉片节点插件");
    if (findNode(node.id) !== node) throw new Error("原视频节点已变化，请重新操作");
    const width = Math.max(240, node.dimensions.width || 320);
    const x = node.computedPosition.x + (node.dimensions.width || 320) + 80;
    let y = node.computedPosition.y;
    for (const other of [...getNodes.value].sort((left, right) => left.computedPosition.y - right.computedPosition.y)) {
      const position = other.computedPosition;
      if (position.x < x + width && position.x + (other.dimensions.width || 320) > x
        && position.y < y + 320 && position.y + (other.dimensions.height || 300) > y) {
        y = position.y + (other.dimensions.height || 300) + 40;
      }
    }
    await batchHistory(async () => {
      try {
        // 组内视频使用绝对坐标，新拉片节点直接放到画布，不继承父组的相对位置。
        addNodes({ id: nodeId, type, position: { x, y }, data: { label: `${node.data.label || "视频"} · 逐帧拉片` } });
        await nextTick();
        if (getCanvas?.()?.id !== canvasId || findNode(node.id) !== node || props.file?.url !== source
          || !nodeTypes?.value?.[type] || !findNode(nodeId)) throw new Error("画布或视频已变化，请重新操作");
        addEdges({ id: crypto.randomUUID(), source: node.id, sourceHandle: "video", target: nodeId, targetHandle: "in" });
      } catch (error) {
        removeNodes(nodeId, true, false);
        throw error;
      }
    });
    const created = findNode(nodeId);
    if (!created || getCanvas?.()?.id !== canvasId) return;
    removeSelectedElements();
    addSelectedNodes([created]);
    nodesSelectionActive.value = false;
    await nextTick();
    if (findNode(nodeId) !== created || getCanvas?.()?.id !== canvasId) return;
    if (!await fitView({ nodes: [nodeId], padding: 0.4, maxZoom: 1, duration: 200 })) {
      await setCenter(x + width / 2, y + 160, { zoom: 1, duration: 200 });
    }
  } catch (error) {
    showNodeError(error, "创建逐帧拉片节点失败");
  } finally {
    creatingAnalysis.value = false;
  }
}

defineExpose({ open, processing, backgroundProgress, cancel, createFrameAnalysis, creatingAnalysis });

function readDuration(event: Event) {
  if (!handleLoaded(event)) return;
  const value = (event.currentTarget as HTMLVideoElement).duration;
  duration.value = Number.isFinite(value) && value > 0 ? value : 0;
  end.value = clipLimit.value;
  if (duration.value) loadThumbnails();
}

function formatTime(value: number) {
  const centiseconds = Math.max(0, Math.floor(value * 100));
  return `${String(Math.floor(centiseconds / 6000)).padStart(2, "0")}:${(centiseconds % 6000 / 100).toFixed(2).padStart(5, "0")}`;
}

function stopThumbnails() {
  clearTimeout(thumbnailTimer);
  if (!thumbnailVideo) return;
  thumbnailVideo.onloadeddata = thumbnailVideo.onseeked = thumbnailVideo.onerror = null;
  thumbnailVideo.removeAttribute("src");
  thumbnailVideo.load();
  thumbnailVideo = undefined;
}

function loadThumbnails() {
  stopThumbnails();
  frames.value = [];
  const source = thumbnailVideo = document.createElement("video");
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 96;
  const context = canvas.getContext("2d");
  if (!context) return void stopThumbnails();
  // ACT: 只采样 10 张小图，缩略图数量与内存不随视频时长增长，不生成逐帧缓存。
  const seekFrame = () => {
    clearTimeout(thumbnailTimer);
    thumbnailTimer = window.setTimeout(stopThumbnails, 15000);
    const time = Math.min(duration.value * (frames.value.length + 0.5) / frameCount, Math.max(0, duration.value - 0.001));
    if (source.readyState >= 2 && Math.abs(source.currentTime - time) < 0.000001) captureFrame();
    else source.currentTime = time;
  };
  const captureFrame = () => {
    try {
      const scale = Math.max(canvas.width / source.videoWidth, canvas.height / source.videoHeight);
      context.drawImage(source, (canvas.width - source.videoWidth * scale) / 2, (canvas.height - source.videoHeight * scale) / 2, source.videoWidth * scale, source.videoHeight * scale);
      frames.value.push(canvas.toDataURL("image/jpeg", 0.75));
      if (frames.value.length === frameCount) stopThumbnails();
      else seekFrame();
    } catch { stopThumbnails(); }
  };
  source.onloadeddata = seekFrame;
  source.onseeked = captureFrame;
  source.onerror = stopThumbnails;
  source.muted = true;
  source.preload = "auto";
  source.src = playbackSrc.value;
  thumbnailTimer = window.setTimeout(stopThumbnails, 15000);
  source.load();
}

function clearPreview() {
  preview.value?.pause();
  stopThumbnails();
  endDrag();
}

function seekPreview(value: number) {
  if (!preview.value || !duration.value || !Number.isFinite(value)) return;
  preview.value.pause();
  preview.value.currentTime = Math.min(Math.max(0, duration.value - 0.001), Math.max(0, value));
  currentTime.value = preview.value.currentTime;
}

function readTime() {
  if (!preview.value) return;
  currentTime.value = preview.value.currentTime;
  if (!preview.value.paused && validRange.value && currentTime.value >= end.value) preview.value.pause();
}

function playSelection() {
  if (preview.value && validRange.value && (preview.value.currentTime < start.value || preview.value.currentTime >= end.value)) preview.value.currentTime = start.value;
}

function setBoundary(edge: "start" | "end", value: number) {
  if (processing.value || props.disabled || !duration.value || !Number.isFinite(value) || !Number.isFinite(start.value) || !Number.isFinite(end.value)) return;
  const rounded = Math.round(value * 100) / 100;
  if (edge === "start") start.value = Math.max(0, Math.min(end.value - minimumLength.value, rounded));
  else end.value = Math.min(clipLimit.value, Math.max(start.value + minimumLength.value, rounded));
  if (duration.value >= 0.01 && edge === "start") start.value = Number(start.value.toFixed(2));
  if (duration.value >= 0.01 && edge === "end") end.value = Number(end.value.toFixed(2));
  seekPreview(edge === "start" ? start.value : end.value);
}

function beginDrag(event: PointerEvent, edge: "start" | "end") {
  const width = track.value?.getBoundingClientRect().width;
  if (event.button !== 0 || drag || !width || processing.value || props.disabled || !duration.value) return;
  const target = event.currentTarget as HTMLElement;
  drag = { pointerId: event.pointerId, target, x: event.clientX, time: edge === "start" ? start.value : end.value, width };
  dragging.value = edge;
  target.setPointerCapture(event.pointerId);
  seekPreview(drag.time);
}

function moveDrag(event: PointerEvent) {
  if (!drag || !dragging.value || event.pointerId !== drag.pointerId) return;
  setBoundary(dragging.value, drag.time + (event.clientX - drag.x) / drag.width * duration.value);
}

function endDrag(event?: PointerEvent) {
  if (!drag || (event && event.pointerId !== drag.pointerId)) return;
  const previous = drag;
  drag = undefined;
  dragging.value = undefined;
  if (previous.target.hasPointerCapture(previous.pointerId)) previous.target.releasePointerCapture(previous.pointerId);
}

function changeBoundary(event: KeyboardEvent, edge: "start" | "end") {
  const step = event.shiftKey ? 1 : 0.1;
  const time = edge === "start" ? start.value : end.value;
  const values: Record<string, number> = { ArrowLeft: time - step, ArrowDown: time - step, ArrowRight: time + step, ArrowUp: time + step, Home: 0, End: clipLimit.value };
  if (!(event.key in values)) return;
  event.preventDefault();
  setBoundary(edge, values[event.key]!);
}

function seekTrack(event: PointerEvent) {
  if (event.button !== 0 || processing.value || props.disabled || !duration.value || !track.value) return;
  const rect = track.value.getBoundingClientRect();
  if (rect.width) seekPreview(Math.max(start.value, Math.min(end.value, (event.clientX - rect.left) / rect.width * duration.value)));
}

function run() {
  if (processing.value || props.disabled || !props.file || (action.value === "trim" && !pendingTrim.value && !validRange.value)) return;
  job = process();
}

async function selectRecovery(item: Recovery) {
  if (processing.value || pendingTrim.value || accountMode.value !== "customer") return;
  const current = new AbortController();
  processing.value = true;
  try {
    const persistence = getPersistence?.();
    if (await usesCustomerAccount(current.signal) !== trimUserId || !persistence || persistence.directory !== trimDirectory || persistence.canvasPath !== trimCanvasPath
      || getCanvas?.()?.id !== trimCanvasId || !props.file || !recoveries.value.includes(item)) throw new Error("账号、画布或视频已变化");
    node.data.pendingTrim = { operationId: item.operationId, source: item.source, start: item.start, end: item.end, ownerId: trimUserId, directory: trimDirectory, canvasPath: trimCanvasPath, recoverOnly: true } satisfies PendingTrim;
    await persistence.save(current.signal);
    ElMessage.success("已选中截取记录，请点击检查并恢复");
  } catch (error) { showNodeError(error, "选择截取记录失败"); }
  finally { processing.value = false; }
}

async function usesCustomerAccount(signal: AbortSignal) {
  const response = await fetch("/api/multiTenant/user/session", { headers: { "x-toonflow-workspace": "1" }, signal });
  const body = await response.json();
  if (!response.ok || body?.code !== 200 || typeof body.data?.publicWeb !== "boolean" || typeof body.data?.enabled !== "boolean") throw new Error("无法确认当前账号，请刷新后重试");
  if (body.data?.publicWeb && !body.data?.user) throw new Error("请先登录后重试");
  if (body.data?.publicWeb && !["user", "admin"].includes(body.data?.user?.role)) throw new Error("无法确认当前账号，请刷新后重试");
  if (body.data.publicWeb === true && body.data.user?.role === "user") {
    if (typeof body.data.user.id !== "string" || !/^[a-f0-9-]{36}$/.test(body.data.user.id)) throw new Error("无法确认当前账号，请刷新后重试");
    return body.data.user.id as string;
  }
  return null;
}

async function readTrimResponse(response: Response) {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) return response.json();
  if (!response.body) throw new Error("未收到截取状态，请检查并恢复");
  const reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error("截取连接已结束，请检查并恢复");
      const event = JSON.parse(value.data);
      if (event.phase === "queued") trimQueued.value = true;
      if (event.phase === "running") trimQueued.value = false;
      if (event.result) return event.result;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function trimForCustomer(workspace: WorkspaceFiles, source: string, start: number, end: number, signal: AbortSignal) {
  const { directory } = await workspace.list();
  if (directory !== trimDirectory || getCanvas?.()?.id !== trimCanvasId) throw new Error("工作区或画布已变化，请重新打开裁剪");
  const previous = pendingTrim.value;
  if (!previous) {
    const capabilities = await fetch("/api/ffmpeg/trim/capabilities", { headers: { "x-toonflow-workspace": "1" }, signal });
    const body = await capabilities.json();
    if (!capabilities.ok || body?.code !== 200 || body?.data?.create !== true) throw new Error("截取暂处于只读模式，请稍后重试");
    if (await usesCustomerAccount(signal) !== trimUserId || getCanvas?.()?.id !== trimCanvasId) throw new Error("账号或画布已变化，请重新打开裁剪");
  }
  const pending = previous ? { ...previous, canvasPath: trimCanvasPath } : { operationId: crypto.randomUUID(), source, start, end, ownerId: trimUserId, directory: trimDirectory, canvasPath: trimCanvasPath };
  const persistence = getPersistence?.();
  if (!persistence || persistence.directory !== trimDirectory || persistence.canvasPath !== trimCanvasPath) throw new Error("无法保存裁剪恢复记录");
  node.data.pendingTrim = pending;
  // 每次重试都先确认记录已落盘；之前一次保存失败不能只凭内存标记继续提交。
  await persistence.save(signal);
  if (previous) {
    const check = await fetch("/api/ffmpeg/trim/status", { method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, body: JSON.stringify({ directory, operationId: pending.operationId, source: pending.source, start: pending.start, end: pending.end }), signal });
    const state = await check.json();
    if (!check.ok || state?.code !== 200) throw new Error("无法确认上次裁剪状态，请稍后重试");
    if (state.data?.status === "ready" && state.data.nodeId === pending.operationId && state.data.outputPath === `assets/${pending.operationId}/video.mp4`) return { nodeId: pending.operationId, outputPath: state.data.outputPath as string, duration: pending.end - pending.start, width: preview.value?.videoWidth ?? 0, height: preview.value?.videoHeight ?? 0 };
    if (state.data?.status === "pending") throw new Error(state.data.phase === "queued" ? "上次截取正在排队" : state.data.phase === "running" ? "上次截取正在执行" : "上次裁剪状态尚未确认，请联系管理员");
    if (state.data?.status === "interrupted") { interruptedOperation.value = pending.operationId; throw new Error("上次截取已中断，可放弃查看后重新截取"); }
    if (state.data?.status !== "notFound" || pending.recoverOnly) throw new Error("无法确认上次裁剪状态，请联系管理员");
  }
  const response = await fetch("/api/ffmpeg/trim", { method: "POST", headers: { Accept: "text/event-stream", "Content-Type": "application/json", "x-toonflow-workspace": "1" }, body: JSON.stringify({ directory, operationId: pending.operationId, source: pending.source, start: pending.start, end: pending.end }), signal });
  const body = await readTrimResponse(response);
  if (canClearUnsubmittedTrim(!previous, response.status, body, pending.operationId)) {
    const cleanupSignal = AbortSignal.timeout(10000);
    if (await usesCustomerAccount(cleanupSignal) !== trimUserId || (await workspace.list()).directory !== trimDirectory || getCanvas?.()?.id !== trimCanvasId) throw new Error("账号、工作区或画布已变化，请重新打开裁剪");
    await finishTrimRecord(cleanupSignal, pending.operationId);
    throw new Error("截取暂处于只读模式，请稍后重试");
  }
  if (!response.ok || body?.code !== 200) throw new Error(typeof body?.message === "string" ? body.message : "裁剪暂不可用，请稍后重试");
  const data = body.data;
  if (!data || data.nodeId !== pending.operationId || data.outputPath !== `assets/${data.nodeId}/video.mp4`
    || !Number.isFinite(data.duration) || !Number.isFinite(data.width) || !Number.isFinite(data.height)) throw new Error("裁剪结果无效");
  return data as { nodeId: string; outputPath: string; duration: number; width: number; height: number };
}

async function finishTrimRecord(signal: AbortSignal, expectedOperationId: string) {
  const persistence = getPersistence?.(), saved = pendingTrim.value;
  if (!saved || saved.operationId !== expectedOperationId || saved.ownerId !== trimUserId || !persistence || persistence.directory !== saved.directory || persistence.canvasPath !== saved.canvasPath || getCanvas?.()?.id !== trimCanvasId) throw new Error("账号、画布或裁剪记录已变化，请重新打开");
  delete node.data.pendingTrim;
  try { await persistence.save(signal); }
  catch (error) { if (!pendingTrim.value) node.data.pendingTrim = saved; throw error; }
}

async function clearRecoverySelection() {
  const saved = pendingTrim.value;
  if (processing.value || accountMode.value !== "customer" || !saved || !saved.recoverOnly && interruptedOperation.value !== saved.operationId) return;
  const current = new AbortController();
  processing.value = true;
  try {
    const interrupted = interruptedOperation.value === saved.operationId;
    if (interrupted) {
      try { await ElMessageBox.confirm("此截取已中断且没有可恢复的结果。释放它预留的空间后，可以重新截取。", "释放中断任务空间", { confirmButtonText: "释放空间", cancelButtonText: "取消", type: "warning" }); }
      catch { return; }
    }
    if (await usesCustomerAccount(current.signal) !== trimUserId || saved.ownerId !== trimUserId || saved.directory !== trimDirectory || saved.canvasPath !== trimCanvasPath || getCanvas?.()?.id !== trimCanvasId) throw new Error("账号、工作区或画布已变化，请重新打开裁剪");
    if (pendingTrim.value?.operationId !== saved.operationId) throw new Error("裁剪记录已变化，请重新打开");
    if (interrupted) {
      const response = await fetch("/api/ffmpeg/trim/discard", { method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" }, body: JSON.stringify({ directory: trimDirectory, operationId: saved.operationId, confirm: true }), signal: current.signal });
      const body = await response.json();
      if (!response.ok || body?.code !== 200 || body?.data?.released !== true) throw new Error("暂无法确认空间已释放，请稍后重试");
      if (await usesCustomerAccount(current.signal) !== trimUserId || pendingTrim.value?.operationId !== saved.operationId) throw new Error("账号或裁剪记录已变化，请重新打开");
    }
    await finishTrimRecord(current.signal, saved.operationId);
    interruptedOperation.value = "";
    visible.value = false;
    ElMessage.success(interrupted ? "中断任务空间已释放" : "已放弃查看，原截取记录仍保留");
  } catch (error) { showNodeError(error, "无法放弃查看"); }
  finally { processing.value = false; }
}

async function process() {
  const operation = action.value;
  const requiredTypes = operation === "extractAudio" ? ["remote-audioNode"] : operation === "trim" ? ["remote-videoNode"] : ["remote-videoNode", "remote-audioNode"];
  if (requiredTypes.some(type => !nodeTypes?.value?.[type])) return void ElMessage.error("请先启用所需的视频或音频节点插件");
  const previous = operation === "trim" ? pendingTrim.value : null;
  const source = previous?.source ?? props.file!.url;
  const clipStart = previous?.start ?? start.value;
  const clipEnd = previous?.end ?? end.value;
  const current = controller = new AbortController();
  processing.value = true;
  cancelling.value = false;
  preview.value?.pause();
  let outputs: { id: string; type: string; audio: boolean; path: string }[] = requiredTypes.map(type => {
    const id = crypto.randomUUID();
    const audio = type === "remote-audioNode";
    return { id, type, audio, path: `assets/${id}/${audio ? "audio.m4a" : "video.mp4"}` };
  });
  const createdDirectories: string[] = [];
  let workspace: WorkspaceFiles | undefined;
  let committed = false;
  try {
    workspace = files.getWorkspaceFiles();
    let media: { duration: number; width?: number; height?: number };
    const currentUser = operation === "trim" ? await usesCustomerAccount(current.signal) : null;
    if (operation === "trim" && (currentUser ?? "") !== trimUserId) throw new Error("账号已变化，请重新打开裁剪");
    if (operation === "trim" && currentUser) {
      const result = await trimForCustomer(workspace, source, clipStart, clipEnd, current.signal);
      const existing = findNode(result.nodeId);
      if (existing) {
        if (existing.type !== "remote-videoNode" || existing.data?.outputs?.video?.dataType !== "VIDEO" || existing.data?.outputs?.video?.value?.url !== result.outputPath) throw new Error("裁剪节点编号冲突，请联系管理员");
        await finishTrimRecord(current.signal, result.nodeId);
        visible.value = false;
        ElMessage.success("截取结果已保存");
        return;
      }
      outputs = [{ id: result.nodeId, type: "remote-videoNode", audio: false, path: result.outputPath }];
      media = result;
    } else {
      const ffmpeg = await loadFfmpeg(current.signal);
      current.signal.throwIfAborted();
      await workspace.mkdir("assets").catch(error => { if (error?.response?.data?.data?.code !== "EEXIST") throw error; });
      for (const output of outputs) {
        current.signal.throwIfAborted();
        const directory = `assets/${output.id}`;
        await workspace.mkdir(directory);
        createdDirectories.push(directory);
      }
      current.signal.throwIfAborted();
      media = await processVideo(ffmpeg, source, {
        action: operation,
        audioPath: outputs.find(output => output.audio)?.path,
        videoPath: outputs.find(output => !output.audio)?.path,
        start: clipStart,
        end: clipEnd,
      }, current.signal);
    }
    current.signal.throwIfAborted();
    if (currentUser && ((await usesCustomerAccount(current.signal)) !== trimUserId || (await workspace.list()).directory !== trimDirectory || getCanvas?.()?.id !== trimCanvasId)) throw new Error("账号、工作区或画布已变化，结果可在原画布恢复");
    const width = Math.max(320, media.width && media.height ? 240 * media.width / media.height + 18 : 320);
    const x = node.computedPosition.x + node.dimensions.width + 80;
    const height = outputs.length * 320;
    let y = node.computedPosition.y;
    for (const other of [...getNodes.value].sort((left, right) => left.computedPosition.y - right.computedPosition.y)) {
      const position = other.computedPosition;
      if (position.x < x + width && position.x + other.dimensions.width > x && position.y < y + height && position.y + other.dimensions.height > y) y = position.y + other.dimensions.height + 40;
    }
    const nodes: Node[] = outputs.map((output, index) => ({
      id: output.id,
      type: output.type,
      position: { x, y: y + index * 320 },
      data: {
        label: `${previous?.recoverOnly ? `历史素材 ${source.split(/[\\/]/).pop() || source}` : node.data.label || "视频"} · ${output.audio ? "音轨" : operation === "separate" ? "静音视频" : `${clipStart.toFixed(2)}–${clipEnd.toFixed(2)} 秒`}`,
        outputs: { [output.audio ? "audio" : "video"]: { dataType: output.audio ? "AUDIO" : "VIDEO", value: { url: output.path, mimeType: output.audio ? "audio/mp4" : "video/mp4" } } },
      },
    }));
    await batchHistory(async () => {
      current.signal.throwIfAborted();
      if (findNode(node.id) !== node || requiredTypes.some(type => !nodeTypes?.value?.[type])) throw new Error("画布节点已变化，请重新处理");
      addNodes(nodes);
      committed = true;
    });
    if (currentUser) await finishTrimRecord(current.signal, outputs[0]!.id);
    visible.value = false;
    ElMessage.success(`${actionLabels[operation]}完成，已生成 ${nodes.length} 个节点`);
  } catch (error) {
    if (!current.signal.aborted) showNodeError(error, `${actionLabels[operation]}失败`);
  } finally {
    if (!committed && workspace) {
      const results = await Promise.allSettled(createdDirectories.map(path => workspace!.remove(path, true)));
      if (results.some(result => result.status === "rejected" && result.reason?.response?.data?.data?.code !== "ENOENT")) ElMessage.error("部分临时媒体文件清理失败，未能全部删除。");
    }
    if (current.signal.aborted) visible.value = false;
    trimQueued.value = false;
    processing.value = cancelling.value = false;
    controller = undefined;
  }
}
</script>

<style scoped lang="scss">
.videoActionPanel {
  .clipPreview { display: block; width: 100%; height: min(30vh, 300px); background: #0c0e13; border-radius: 12px; object-fit: contain; }
  .clipTimeline {
    margin-top: 20px;
    padding: 16px 18px 12px;
    border: 1px solid var(--el-border-color-lighter);
    border-radius: 12px;
    background: var(--el-fill-color-light);
    &.unavailable { opacity: 0.55; }
    .timelineHeader {
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 18px;
      color: var(--el-text-color-regular);
      font-size: 12px;
      .sourceDuration { color: var(--el-text-color-secondary); font-variant-numeric: tabular-nums; }
    }
    .timelineBody {
      margin: 0 16px;
      .frameTrack {
        position: relative;
        height: 64px;
        cursor: crosshair;
        touch-action: none;
        user-select: none;
        .filmstrip {
          display: flex;
          height: 100%;
          overflow: hidden;
          border-radius: 5px;
          background: var(--el-fill-color-darker);
          .frameCell {
            flex: 1;
            min-width: 0;
            border-right: 1px solid rgba(255, 255, 255, 0.12);
            background: linear-gradient(135deg, transparent, rgba(0, 0, 0, 0.12));
            img { display: block; width: 100%; height: 100%; object-fit: cover; }
          }
        }
        .discardedArea { position: absolute; top: 0; bottom: 0; background: rgba(9, 12, 20, 0.7); pointer-events: none; }
        .selectedArea { position: absolute; top: 0; bottom: 0; box-sizing: border-box; border-block: 3px solid var(--el-color-primary); background: color-mix(in srgb, var(--el-color-primary) 8%, transparent); pointer-events: none; }
        .playhead {
          position: absolute;
          z-index: 2;
          top: -5px;
          bottom: -5px;
          width: 2px;
          background: #fff;
          box-shadow: 0 0 3px rgba(0, 0, 0, 0.7);
          pointer-events: none;
          &::before { position: absolute; top: 0; left: -3px; width: 8px; height: 7px; border-radius: 2px; background: #fff; content: ""; }
        }
        .trimHandle {
          position: absolute;
          z-index: 3;
          top: 0;
          display: grid;
          place-items: center;
          width: 16px;
          height: 100%;
          padding: 0;
          border: 0;
          background: var(--el-color-primary);
          color: #fff;
          cursor: ew-resize;
          touch-action: none;
          &.startHandle { transform: translateX(-100%); border-radius: 6px 0 0 6px; }
          &.endHandle { border-radius: 0 6px 6px 0; }
          &:hover, &.dragging { filter: brightness(1.15); box-shadow: 0 0 0 3px var(--el-color-primary-light-7); }
          &:focus-visible { outline: 2px solid var(--el-text-color-primary); outline-offset: 3px; }
          &:disabled { cursor: not-allowed; }
          span { width: 3px; height: 22px; border-radius: 2px; background: currentColor; opacity: 0.85; }
        }
      }
      .timeRuler { display: flex; justify-content: space-between; gap: 4px; margin-top: 12px; color: var(--el-text-color-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
    }
  }
  .clipTimes {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px 24px;
    margin-top: 16px;
    color: var(--el-text-color-secondary);
    font-size: 12px;
    label {
      display: flex;
      align-items: center;
      gap: 8px;
      white-space: nowrap;
      .timeInput {
        box-sizing: border-box;
        width: 96px;
        height: 32px;
        padding: 0 10px;
        border: 1px solid var(--el-border-color);
        border-radius: var(--el-border-radius-base);
        background: var(--el-bg-color);
        color: var(--el-text-color-primary);
        font: inherit;
        font-variant-numeric: tabular-nums;
        text-align: center;
        &:hover { border-color: var(--el-border-color-hover); }
        &:focus { border-color: var(--el-color-primary); outline: 1px solid var(--el-color-primary); }
        &:disabled { color: var(--el-text-color-placeholder); cursor: not-allowed; }
      }
    }
    .selectionDuration { margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap; }
  }
  .actionHint { margin: 16px 0; color: var(--el-text-color-secondary); font-size: 13px; }
  .processingStatus {
    display: grid;
    gap: 10px;
    margin: 16px 0;
    span { color: var(--el-text-color-secondary); font-size: 13px; }
  }
  .panelActions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
  @media (max-width: 560px) {
    .clipTimeline {
      padding-inline: 8px;
      .timelineBody .timeRuler span:nth-child(even) { visibility: hidden; }
    }
  }
}
</style>
