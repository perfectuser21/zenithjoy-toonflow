<template>
  <nodeSkeleton v-bind="nodeProps" class="qianchuanUploadNode" :fullscreenVisible="false">
    <div class="uploadContent nodrag nopan nowheel" @pointerdown.stop @dblclick.stop @keydown.stop>
      <label class="accountInput">千川账户 ID
        <input v-model.trim="state.advertiserId" type="text" inputmode="numeric" maxlength="20"
          :disabled="busy || active" aria-label="千川账户 ID" />
      </label>
      <p v-if="!clips.length">连接「批量混剪」的「整批成片」端口。</p>
      <p v-else>已连接 {{ clips.length }} 条成片<span v-if="clips.length > batchLimit">，单批最多 {{ batchLimit }} 条</span>。</p>
      <div class="uploadActions">
        <button type="button" class="primary" :disabled="!canStart" @click="startUpload">上传这批成片</button>
        <button v-if="state.job" type="button" :disabled="busy" @click="submit('status')">刷新状态</button>
        <button v-if="needsSubmit" type="button" :disabled="busy || !validAdvertiserId" @click="resubmitUpload">重新提交本批</button>
        <button v-if="failedCount" type="button" :disabled="busy || active" @click="submit('retry')">只重试失败项</button>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <template v-if="result">
        <p role="status">账户 {{ result.advertiserId }} · 成功 {{ succeededCount }} / {{ result.items.length }} · 失败 {{ failedCount }}<span v-if="unknownCount"> · 待确认 {{ unknownCount }}</span></p>
        <ul class="uploadItems">
          <li v-for="(item, index) in result.items" :key="index">
            <div><strong :title="item.name">{{ item.name }}</strong><span>{{ stateLabels[item.state] }}</span></div>
            <small v-if="item.materialId || item.videoId">素材编号 {{ item.materialId ?? item.videoId }}</small>
            <small v-if="item.error" class="error">{{ item.error }}</small>
          </li>
        </ul>
      </template>
    </div>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { IconUpload } from "@tabler/icons-vue";
import { z } from "zod";
import { nodeSkeleton, useNode, useNodeInputs, type NodeHandle, type NodeVideoBatchItem } from "@toonflow/nodes-scaffold/runtime";
import { useNodePersistence } from "@toonflow/nodes-scaffold/nodeDocument";

defineOptions({
  inheritAttrs: false,
  icon: IconUpload,
  handles: [{ id: "videos", type: "target", dataType: "VIDEO_BATCH", label: "整批成片" }] satisfies NodeHandle[],
});
const batchLimit = 100;
const itemSchema = z.object({ name: z.string(), url: z.string(), mimeType: z.string() });
const jobSchema = z.object({ jobId: z.uuid(), advertiserId: z.string(), items: z.array(itemSchema).max(batchLimit) });
const itemStateSchema = z.enum(["pending", "uploading", "succeeded", "failed", "unknown"]);
const resultSchema = jobSchema.extend({
  items: z.array(itemSchema.extend({
    state: itemStateSchema,
    materialId: z.string().optional(),
    videoId: z.string().optional(),
    error: z.string().optional(),
  })),
});
const uploadStateSchema = z.object({ advertiserId: z.string(), job: jobSchema.optional() });
const responseSchema = z.object({ code: z.number().optional(), message: z.string().optional(), data: z.unknown().optional() });
const stateLabels: Record<z.infer<typeof itemStateSchema>, string> = {
  pending: "等待上传", uploading: "上传中", succeeded: "成功", failed: "失败", unknown: "结果待确认",
};
type Operation = "start" | "status" | "retry";
const { id, node, nodeProps } = useNode({ label: "千川素材上传" });
const { getTargetValues } = useNodeInputs();
const getPersistence = useNodePersistence();
const persisted = uploadStateSchema.safeParse("qianchuanUpload" in node.data ? node.data.qianchuanUpload : undefined);
const initial: z.infer<typeof uploadStateSchema> = persisted.success ? persisted.data : { advertiserId: "" };
const state = Object.assign(node.data, { qianchuanUpload: initial }).qianchuanUpload;
const busy = ref(false);
const needsSubmit = ref(false);
const error = ref("");
const result = ref<z.infer<typeof resultSchema>>();
const validAdvertiserId = computed(() => /^\d{1,20}$/.test(state.advertiserId));
const active = computed(() => result.value?.items.some(item => item.state === "pending" || item.state === "uploading") ?? false);
const succeededCount = computed(() => result.value?.items.filter(item => item.state === "succeeded").length ?? 0);
const failedCount = computed(() => result.value?.items.filter(item => item.state === "failed").length ?? 0);
const unknownCount = computed(() => result.value?.items.filter(item => item.state === "unknown").length ?? 0);
const clips = computed(() => {
  const byUrl = new Map<string, NodeVideoBatchItem>();
  for (const input of getTargetValues(id, "videos")) {
    if (input.dataType !== "VIDEO_BATCH" || !Array.isArray(input.value)) continue;
    for (const clip of input.value) byUrl.set(clip.url, clip);
  }
  return [...byUrl.values()];
});
const canStart = computed(() => {
  if (busy.value || active.value || !validAdvertiserId.value || !clips.value.length || clips.value.length > batchLimit) return false;
  if (!state.job) return true;
  if (!result.value) return false;
  const urls = new Set(clips.value.map(clip => clip.url));
  return state.job.advertiserId !== state.advertiserId || state.job.items.length !== clips.value.length
    || state.job.items.some(item => !urls.has(item.url));
});
const lifetime = new AbortController();
let timer: ReturnType<typeof setTimeout> | undefined;

function startUpload() {
  if (!canStart.value) return;
  if (!getPersistence?.()) { error.value = "请先打开已保存的工作区画布"; return; }
  result.value = undefined;
  state.job = { jobId: crypto.randomUUID(), advertiserId: state.advertiserId, items: clips.value.map(clip => ({ ...clip })) };
  needsSubmit.value = true;
  void submit("start");
}

function resubmitUpload() {
  if (!state.job || !needsSubmit.value || !validAdvertiserId.value || busy.value) return;
  state.job.advertiserId = state.advertiserId;
  void submit("start");
}

async function submit(operation: Operation) {
  const context = getPersistence?.();
  const job = state.job;
  if (!context || !job || busy.value || lifetime.signal.aborted) return;
  clearTimeout(timer);
  busy.value = true;
  error.value = "";
  try {
    if (operation === "start") await context.save(lifetime.signal);
    const current = getPersistence?.();
    if (current?.directory !== context.directory || current.canvasPath !== context.canvasPath) throw new Error("画布已切换");
    const payload = operation === "start"
      ? { directory: context.directory, ...job }
      : { directory: context.directory, jobId: job.jobId };
    const response = await fetch(`/api/ai/media/qianchuan/${operation}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20000)]),
    });
    const value = responseSchema.safeParse(await response.json());
    if (!response.ok || !value.success || value.data.code !== 200) {
      if (!result.value && operation === "status" && response.status === 404) needsSubmit.value = true;
      throw new Error(value.success ? value.data.message || "千川上传请求失败" : "千川上传请求失败");
    }
    const parsed = resultSchema.safeParse(value.data.data);
    if (!parsed.success || parsed.data.jobId !== job.jobId || parsed.data.advertiserId !== job.advertiserId) {
      throw new Error("千川任务响应无法核对");
    }
    result.value = parsed.data;
    needsSubmit.value = false;
  } catch (reason) {
    if (!lifetime.signal.aborted) error.value = reason instanceof Error ? reason.message : "千川上传请求失败";
  } finally {
    busy.value = false;
    if (active.value && !lifetime.signal.aborted) timer = setTimeout(() => void submit("status"), 2000);
  }
}
watch(() => getPersistence?.()?.canvasPath, () => { if (state.job) void submit("status"); }, { immediate: true });
onScopeDispose(() => { clearTimeout(timer); lifetime.abort(); });
</script>

<style scoped lang="scss">
.qianchuanUploadNode { width: 350px; }
.uploadContent {
  display: grid; gap: 10px; color: var(--el-text-color-primary); font-size: 13px;
  p { margin: 0; }
  .accountInput { display: grid; gap: 6px; }
  .uploadActions { display: flex; flex-wrap: wrap; gap: 6px; }
  button, input {
    color: inherit; font: inherit; border: 1px solid var(--el-border-color); border-radius: 5px;
    background: var(--el-fill-color-blank); padding: 5px 8px;
  }
  button { cursor: pointer; }
  .primary { background: var(--el-color-primary); color: white; }
  button:disabled, input:disabled { opacity: .55; }
  .error { color: var(--el-color-danger); overflow-wrap: anywhere; }
  .uploadItems {
    display: grid; gap: 8px; margin: 0; padding: 8px 0 0; max-height: 220px; overflow: auto;
    list-style: none; border-top: 1px solid var(--el-border-color);
    li { min-width: 0; padding-right: 4px; }
    div { display: flex; justify-content: space-between; gap: 8px; }
    strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    span { flex-shrink: 0; color: var(--el-text-color-secondary); }
    small { display: block; margin-top: 2px; }
  }
}
</style>
