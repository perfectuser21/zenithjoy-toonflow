<template>
  <nodeSkeleton v-bind="nodeProps" class="videoConcatNode" :fullscreenVisible="false">
    <div class="concatContent nodrag nopan nowheel" @pointerdown.stop @dblclick.stop @keydown.stop>
      <fieldset :disabled="!!running">
        <ol class="segments">
          <li v-for="segment in segments" :key="segment.port">
            <strong>第 {{ segment.number }} 段</strong>
            <span :title="segment.label">{{ segment.label }}</span>
          </li>
        </ol>
        <div class="actions">
          <button v-if="state.segmentCount < maxConcatClips" type="button" @click="state.segmentCount++">增加片段</button>
          <button
            v-if="state.segmentCount > 2"
            type="button"
            :disabled="!!segments.at(-1)?.connected"
            @click="state.segmentCount--">移除末尾空端口</button>
          <button class="primary" type="button" :disabled="!sourceKey" @click="run">合成 MP4</button>
        </div>
      </fieldset>
      <p v-if="running" role="status">{{ progress }}</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <template v-if="preview">
        <video :src="preview" controls playsinline preload="metadata" aria-label="成片预览" />
        <a :href="preview" :download="outputName">下载 MP4</a>
      </template>
    </div>
  </nodeSkeleton>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watchEffect } from "vue";
import { IconMovie } from "@tabler/icons-vue";
import { nodeSkeleton, uploadNodeFile, useNode, useNodeInputs, type NodeHandle, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { useNodePersistence } from "@toonflow/nodes-scaffold/nodeDocument";
import { concatVideo, maxConcatClips } from "@toonflow/node-shared/concatVideo";

defineOptions({ inheritAttrs: false, icon: IconMovie });

type ConcatState = {
  segmentCount: number;
  result?: NodeMediaValue & { sourceKey: string };
};

const outputName = "合成成片.mp4";
const { id, node, nodeProps, files, handles, outputs, nodeEvent } = useNode({ label: "合成成片" });
const { getTargetSources, getTargetValues } = useNodeInputs();
const getPersistence = useNodePersistence();
const persisted: typeof node.data & { videoConcat?: ConcatState } = node.data;
persisted.videoConcat ??= { segmentCount: 3 };
const state = persisted.videoConcat;
if (!Number.isInteger(state.segmentCount) || state.segmentCount < 2 || state.segmentCount > maxConcatClips) state.segmentCount = 3;
const running = shallowRef<AbortController>();
const progress = ref("");
const error = ref("");

const ports = computed(() => Array.from({ length: state.segmentCount }, (_, index) => ({
  id: "segment" + index,
  label: "第 " + (index + 1) + " 段",
})));

watchEffect(() => {
  handles.value = [
    ...ports.value.map((port): NodeHandle => ({ ...port, type: "target", dataType: "VIDEO" })),
    { id: "video", type: "source", dataType: "VIDEO", label: "成片" },
  ];
});

const segments = computed(() => ports.value.map(({ id: port }, index) => {
  const sources = getTargetSources(id, port);
  const number = index + 1;
  const [source] = sources;
  if (!source || sources.length !== 1) {
    return { port, number, connected: sources.length > 0, label: sources.length ? "每个端口只连接一个片段" : "等候连线" };
  }
  const [input] = getTargetValues(id, port);
  if (!input || input.value === undefined || input.dataType !== "VIDEO") {
    return { port, number, connected: true, label: "等候片段完成" };
  }
  const clip = input.value;
  return {
    port, number, connected: true, clip,
    label: source.node.data?.label || clip.url.split("/").at(-1) || "视频片段",
    key: [input.source, input.sourceHandle, clip.url, clip.mimeType],
  };
}));

const sourceKey = computed(() => segments.value.every(segment => segment.clip)
  ? JSON.stringify(segments.value.map(segment => segment.key))
  : "");

const result = computed(() => state.result?.sourceKey === sourceKey.value ? state.result : undefined);

watchEffect(() => {
  const value = result.value;
  outputs.value.video = value ? { dataType: "VIDEO", value: { url: value.url, mimeType: value.mimeType } } : undefined;
});

function showError(reason: unknown) {
  error.value = reason instanceof Error ? reason.message : String(reason);
}

const preview = files.useFileUrl(result, showError);

async function run() {
  const snapshot = segments.value.flatMap(segment => segment.clip ? [segment.clip] : []);
  const key = sourceKey.value;
  if (running.value || !key) return;
  const controller = new AbortController();
  const signal = controller.signal;
  running.value = controller;
  error.value = "";
  try {
    const saved = getPersistence?.();
    if (!saved) throw new Error("请先打开一个已保存的工作区画布");
    const { directory, canvasPath } = saved;
    const workspace = files.getWorkspaceFiles();
    const clips: Blob[] = [];
    for (const [index, clip] of snapshot.entries()) {
      signal.throwIfAborted();
      progress.value = "正在读取第 " + (index + 1) + " 段";
      const bytes = await workspace.read(clip.url);
      clips.push(new Blob([bytes], { type: clip.mimeType }));
    }
    progress.value = "正在合成";
    const output = await concatVideo(clips, signal);
    function ensureCurrent() {
      signal.throwIfAborted();
      const current = getPersistence?.();
      if (!current || current.directory !== directory || current.canvasPath !== canvasPath || key !== sourceKey.value) {
        throw new Error("片段或画布已变化，请重新合成");
      }
    }
    ensureCurrent();
    progress.value = "正在保存成片";
    const url = await uploadNodeFile(workspace, id, new File([output], outputName, { type: "video/mp4" }));
    ensureCurrent();
    const previousResult = state.result;
    state.result = { url, mimeType: "video/mp4", sourceKey: key };
    try {
      await saved.save(signal);
    } catch (reason) {
      state.result = previousResult;
      throw reason;
    }
  } catch (reason) {
    if (!signal.aborted) showError(reason);
  } finally {
    running.value = undefined;
  }
}

onScopeDispose(() => running.value?.abort());
nodeEvent.on("delete", () => { if (running.value) throw new Error("请等成片保存后再移除节点"); });
nodeEvent.on("save", reason => { if (running.value && reason === "reload") throw new Error("请等成片保存后再刷新节点"); });
</script>
<style scoped lang="scss">
.videoConcatNode { width: 352px; }
.concatContent {
  display: grid;
  gap: 10px;
  font-size: 13px;
  fieldset { display: grid; gap: 8px; margin: 0; padding: 0; border: 0; }
  .segments { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
  li { display: flex; gap: 10px; align-items: center; padding: 6px 8px; border: 1px solid var(--el-border-color); border-radius: 6px; }
  li strong { white-space: nowrap; }
  li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--el-text-color-secondary); }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  button { padding: 5px 8px; border: 1px solid var(--el-border-color); border-radius: 5px; color: inherit; background: var(--el-fill-color-blank); cursor: pointer; }
  button:disabled { opacity: 0.55; cursor: default; }
  .primary { background: var(--el-color-primary); color: white; }
  p { margin: 0; }
  [role="alert"] { color: var(--el-color-danger); }
  video { width: 100%; max-height: 200px; background: #151515; }
  a { justify-self: start; color: var(--el-color-primary); }
}
</style>
