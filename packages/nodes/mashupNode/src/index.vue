<template>
  <nodeSkeleton v-bind="nodeProps" class="mashupNode" :topVisible="node.selected" :fullscreenVisible="false" :downloadUrl="preview" :downloadName="selected?.name">
    <div class="mashupContent nodrag nopan nowheel" @pointerdown.stop @dblclick.stop @keydown.stop>
      <p class="hint">按组顺序拼接 H.264 MP4 或 MOV。格式不同时，画面以每条成片的第一段尺寸为准，保留各段比例。支持 AAC 原声和无声片段混用。</p>
      <fieldset :disabled="busy">
        <section v-for="(group, slot) in state.groups" :key="slot" class="mediaGroup" @dragover.prevent.stop @drop.prevent.stop="addFiles(slot, $event.dataTransfer?.files)">
          <div><strong>{{ group.name }}</strong><span>{{ groups[slot].length }} 个片段</span>
            <label class="filePicker">添加视频<input type="file" accept="video/*" multiple :aria-label="group.name + ' 组视频'" @change="pickFiles(slot, $event)" /></label>
          </div>
          <ul v-if="groups[slot].length">
            <li v-for="(clip, index) in groups[slot]" :key="clip.url"><span :title="clip.name">{{ clip.name }}</span>
              <button v-if="index < group.clips.length" type="button" :aria-label="'移除 ' + clip.name" @click="group.clips.splice(index, 1)">×</button>
              <small v-else>已连线</small>
            </li>
          </ul>
        </section>
        <div class="actions">
          <button v-if="state.groups.length < groupNames.length" @click="addGroup">增加一组</button>
          <button v-if="state.groups.length > 2" :disabled="Boolean(groups.at(-1)?.length)" @click="state.groups.pop()">移除末尾空组</button>
        </div>
        <label class="count">共 {{ count }} 种组合 · 导出数量
          <input v-model.number="state.limit" type="number" min="1" :max="count" :placeholder="String(count)" aria-label="导出数量" />
        </label>
        <div class="actions">
          <button :disabled="!count" @click="run(true)">预览第一条</button>
          <button class="run" :disabled="!canRun" @click="run(false)">{{ unfinished ? '继续生成' : '生成成片' }}</button>
        </div>
      </fieldset>
      <div v-if="busy" role="status">{{ progress }} <button v-if="running" @click="running.abort()">暂停</button></div>
      <p v-if="error" role="alert">{{ error }}</p>
      <template v-if="results.length">
        <label>查看成片 <select v-model.number="selectedIndex" aria-label="选择成片"><option v-for="(result, index) in results" :key="result.url" :value="index">{{ result.name }}</option></select></label>
        <video v-if="preview" :src="preview" controls preload="metadata" playsinline />
        <button :disabled="busy" @click="downloadBatch">下载 {{ results.length }} 条成片 ZIP</button>
      </template>
    </div>
  </nodeSkeleton>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watchEffect } from "vue";
import { IconMovie } from "@tabler/icons-vue";
import { nodeSkeleton, uploadNodeFile, useNode, useNodeInputs, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import { useNodePersistence } from "@toonflow/nodes-scaffold/nodeDocument";
import { getMediaMimeType } from "@toonflow/node-shared/mediaTypes";
import { combinationCount, groupNames, renderBatch, type MashupClip, type MashupGroup } from "./mashupBatch";
import { concatVideo } from "@toonflow/node-shared/concatVideo";
import { downloadZip } from "./mashupDownload";

defineOptions({
  inheritAttrs: false,
  icon: IconMovie,
  handles: [
    { id: "group0", type: "target", dataType: "VIDEO", label: "A" },
    { id: "group1", type: "target", dataType: "VIDEO", label: "B" },
    { id: "video", type: "source", dataType: "VIDEO", label: "当前成片" },
  ] satisfies NodeHandle[],
});
type Batch = { key: string; target: number; results: MashupClip[] };
type MashupState = { groups: MashupGroup[]; limit: number | ""; selectedIndex?: number; batch?: Batch };
const { id, node, nodeProps, files, outputs, handles, nodeEvent } = useNode({ label: "批量混剪" });
const persisted = node.data as typeof node.data & { mashup?: MashupState };
persisted.mashup ??= { groups: groupNames.slice(0, 2).map(name => ({ name, clips: [] })), limit: "" };
const state = persisted.mashup;
const { getTargetValues } = useNodeInputs();
const getPersistence = useNodePersistence();
const busy = ref(false);
const running = shallowRef<AbortController>();
const progress = ref("");
const error = ref("");
const selectedIndex = computed({
  get: () => state.selectedIndex ?? 0,
  set: (index: number) => { state.selectedIndex = index; },
});
const results = computed(() => state.batch?.results.slice(0, state.batch.target) ?? []);
const selected = computed(() => results.value[selectedIndex.value]);
const preview = files.useFileUrl(selected, showError);
watchEffect(() => {
  const inputs: NodeHandle[] = state.groups.map((group, slot) => ({ id: "group" + slot, type: "target", dataType: "VIDEO", label: group.name }));
  handles.value = [...inputs, { id: "video", type: "source", dataType: "VIDEO", label: "当前成片" }];
});
watchEffect(() => {
  outputs.value.video = selected.value ? { dataType: "VIDEO", value: { url: selected.value.url, mimeType: selected.value.mimeType } } : undefined;
});
const groups = computed(() => state.groups.map((group, slot) => {
  const clips = [...group.clips];
  for (const input of getTargetValues(id, "group" + slot)) {
    if (input.dataType !== "VIDEO" || !input.value || typeof input.value !== "object") continue;
    const { url, mimeType } = input.value;
    if (!clips.some(clip => clip.url === url)) clips.push({ url, mimeType, name: url.split("/").at(-1) || input.source });
  }
  return clips;
}));
const count = computed(() => combinationCount(groups.value));
const limit = computed(() => state.limit === "" ? count.value : state.limit);
const canRun = computed(() => Number.isSafeInteger(limit.value) && limit.value > 0 && limit.value <= count.value);
const batchKey = computed(() => JSON.stringify(groups.value.map(clips => clips.map(clip => clip.url))));
const unfinished = computed(() => state.batch?.key === batchKey.value && results.value.length > 0 && results.value.length < limit.value);
function showError(reason: unknown) { error.value = reason instanceof Error ? reason.message : String(reason); }
function addGroup() { state.groups.push({ name: groupNames[state.groups.length], clips: [] }); }
function pickFiles(slot: number, event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  void addFiles(slot, files);
}
function binding() {
  const saved = getPersistence?.();
  if (!saved) throw Error("请先打开一个已保存的工作区画布");
  return saved;
}
function ensureCurrent(saved: ReturnType<typeof binding>) {
  const current = getPersistence?.();
  if (!current || current.directory !== saved.directory || current.canvasPath !== saved.canvasPath) throw Error("画布已切换，已停止操作");
}
async function addFiles(slot: number, list?: ArrayLike<File>) {
  if (busy.value || !list?.length) return;
  busy.value = true; error.value = ""; progress.value = "正在保存素材…";
  try {
    const workspace = files.getWorkspaceFiles();
    const saved = binding();
    for (const file of Array.from(list)) {
      const mimeType = getMediaMimeType(file);
      if (!mimeType.startsWith("video/") || !file.size || file.size > 100 * 1024 * 1024) throw Error("请选择不超过 100 MB 的非空视频");
      ensureCurrent(saved);
      const url = await uploadNodeFile(workspace, id, file);
      ensureCurrent(saved);
      state.groups[slot].clips.push({ url, mimeType, name: file.name });
    }
    await saved.save();
  } catch (reason) { showError(reason); } finally { busy.value = false; }
}
async function run(first: boolean) {
  if (busy.value || (!first && !canRun.value)) return;
  const controller = new AbortController();
  const signal = controller.signal;
  running.value = controller; busy.value = true; error.value = ""; progress.value = "准备混剪…";
  try {
    const workspace = files.getWorkspaceFiles();
    const saved = binding();
    const snapshot = groups.value.map(clips => clips.map(clip => ({ ...clip })));
    const target = first ? 1 : limit.value;
    if (state.batch?.key !== batchKey.value) {
      state.batch = { key: batchKey.value, target, results: [] };
      selectedIndex.value = 0;
    }
    const batch = state.batch!;
    if (!first) batch.target = target;
    if (first || selectedIndex.value >= target) selectedIndex.value = 0;
    await saved.save(signal);
    const lastClip: { url: string; blob: Blob }[] = [];
    await renderBatch(snapshot, target, batch.results.length, async (clips, index) => {
      signal.throwIfAborted(); ensureCurrent(saved);
      progress.value = '正在生成 ' + (index + 1) + ' / ' + target;
      const blobs: Blob[] = [];
      for (const [slot, clip] of clips.entries()) {
        signal.throwIfAborted();
        if (lastClip[slot]?.url !== clip.url) {
          lastClip[slot] = { url: clip.url, blob: new Blob([await workspace.read(clip.url)], { type: clip.mimeType }) };
        }
        blobs.push(lastClip[slot].blob);
      }
      const output = await concatVideo(blobs, signal);
      signal.throwIfAborted(); ensureCurrent(saved);
      const name = String(index + 1).padStart(3, "0") + "_" + clips.map(clip => clip.name.replace(/\.[^.]+$/, "").replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 24)).join("-") + ".mp4";
      const url = await uploadNodeFile(workspace, id, new File([output], name, { type: "video/mp4" }));
      ensureCurrent(saved);
      batch.results.push({ name, url, mimeType: "video/mp4" });
      await saved.save();
    });
  } catch (reason) {
    if (signal.aborted) error.value = "已暂停，已完成的视频可直接查看或下载";
    else showError(reason);
  } finally { busy.value = false; running.value = undefined; }
}
async function downloadBatch() {
  if (busy.value || !results.value.length) return;
  busy.value = true; error.value = ""; progress.value = "正在打包成片…";
  try { await downloadZip(files.getWorkspaceFiles(), results.value); }
  catch (reason) { showError(reason); } finally { busy.value = false; }
}
onScopeDispose(() => running.value?.abort());
nodeEvent.on("delete", () => { if (busy.value) throw Error("请等当前操作结束"); });
nodeEvent.on("save", reason => { if (busy.value && reason === "reload") throw Error("请等当前操作结束再刷新节点"); });
</script>
<style scoped lang="scss">
.mashupNode { width: 350px; }
.mashupContent {
  display: grid; gap: 10px; color: var(--el-text-color-primary); font-size: 13px;
  fieldset { display: grid; gap: 8px; margin: 0; padding: 0; border: 0; }
  .mediaGroup { border: 1px dashed var(--el-border-color); border-radius: 6px; padding: 6px 8px;
    div, li { display: flex; align-items: center; gap: 8px; }
    strong { min-width: 24px; }
    ul { padding: 0; margin: 4px 0 0; max-height: 80px; overflow: auto; }
    li span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .filePicker { margin-left: auto; color: var(--el-color-primary); cursor: pointer;
      input { width: 1px; height: 1px; position: absolute; opacity: 0; }
    }
  }
  button, input, select { color: inherit; font: inherit; }
  button { border: 1px solid var(--el-border-color); border-radius: 5px; background: var(--el-fill-color-blank); cursor: pointer; }
  .actions { display: flex; gap: 8px; }
  .run { background: var(--el-color-primary); color: white; }
  button:disabled { opacity: .55; }
  .count input { width: 80px; }
  video, select { max-width: 100%; }
  video { width: 100%; max-height: 210px; background: #151515; }
  p { margin: 0; color: var(--el-color-danger); }
  .hint { color: var(--el-text-color-secondary); font-size: 12px; }
}
</style>
