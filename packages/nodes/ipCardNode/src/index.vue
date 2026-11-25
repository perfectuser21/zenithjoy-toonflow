<template>
  <nodeSkeleton v-bind="nodeProps" class="ipCardNode" :fullscreenVisible="false" :downloadUrl="selectedUrl" downloadName="ipCard03.png">
    <section class="content nodrag nopan nowheel" @pointerdown.stop @dblclick.stop @keydown.stop>
      <p class="hint">样稿 · 第 3 张正文配图</p>
      <label class="field">怎么改
        <textarea v-model="prompt" aria-label="改版提示词" maxlength="600" rows="3" placeholder="例如：右图左文，冷白背景，强调色换绿" />
      </label>
      <div class="actions">
        <label class="field">文字模型
          <select v-model="modelKey" aria-label="文字模型" :disabled="busy">
            <option value="" disabled>选择模型</option>
            <option v-for="model in models" :key="getNodeModelKey(model)" :value="getNodeModelKey(model)">{{ model.label }}</option>
          </select>
        </label>
        <button class="primary" type="button" :disabled="busy || !prompt.trim() || !modelKey" @click="generate">{{ busy ? "生成中…" : "生成新版" }}</button>
      </div>
      <p v-if="error" role="alert">{{ error }}</p>
      <label class="field">预览版本
        <select v-model="selectedPath" aria-label="预览版本">
          <option value="">原版</option>
          <option v-for="(version, index) in versions" :key="version.url" :value="version.url">第 {{ index + 1 }} 版</option>
        </select>
      </label>
      <img :src="selectedPath ? selectedUrl || undefined : original" :alt="selectedPath ? '第 3 张卡新版' : '第 3 张卡原版'" />
    </section>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from "vue";
import { IconPhotoEdit } from "@tabler/icons-vue";
import { findNodeModel, getNodeModelIdentity, getNodeModelKey, nodeSkeleton, uploadNodeFile, useNode, type NodeAiModel, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { z } from "zod";
import original from "./original.png?inline";

defineOptions({
  inheritAttrs: false,
  icon: IconPhotoEdit,
});

const presetSchema = z.strictObject({
  layout: z.enum(["leftVisualRightText", "rightVisualLeftText"]),
  paper: z.enum(["warmWhite", "coolWhite"]),
  accent: z.enum(["blue", "green"]),
  showPage: z.boolean(),
});
type Version = NodeMediaValue & { preset: z.infer<typeof presetSchema> };
const { id, node, nodeProps, ai, files } = useNode({ label: "IP 卡片改版", onModelsChanged: () => void loadModels() });
const data = node.data as typeof node.data & { ipCardVersions?: Version[]; ipCardSelected?: string };
const versions = computed(() => data.ipCardVersions ?? []);
const selectedPath = computed({ get: () => data.ipCardSelected ?? "", set: (value: string) => { data.ipCardSelected = value; } });
const selected = computed(() => versions.value.find(version => version.url === selectedPath.value));
const selectedUrl = files.useFileUrl(selected, cause => showError(cause));
const prompt = ref("");
const models = ref<NodeAiModel[]>([]);
const modelKey = ref("");
const busy = ref(false);
const error = ref("");
let running: AbortController | undefined;

function showError(cause: unknown) {
  if (cause instanceof Error && cause.name === "AbortError") return;
  error.value = cause instanceof Error ? cause.message : "生成失败，请稍后重试";
}

async function loadModels() {
  try {
    models.value = await ai.getModels();
    if (!findNodeModel(models.value, modelKey.value)) {
      const preferred = models.value.find(model => /千问|qwen/i.test(model.label)) ?? models.value[0];
      modelKey.value = preferred ? getNodeModelKey(preferred) : "";
    }
  } catch (cause) {
    showError(cause);
  }
}

onMounted(loadModels);
onScopeDispose(() => running?.abort());

async function generate() {
  const model = findNodeModel(models.value, modelKey.value);
  const instruction = prompt.value.trim();
  if (!model || !instruction || busy.value) return;

  busy.value = true;
  error.value = "";
  const controller = new AbortController();
  running = controller;
  try {
    const workspace = files.getWorkspaceFiles();
    const { directory } = await workspace.list();
    const previous = selected.value?.preset;
    const result = await ai.generate({
      ...getNodeModelIdentity(model),
      systemPrompt: "将版式要求转换为 JSON 对象。layout 只能是 leftVisualRightText 或 rightVisualLeftText，paper 只能是 warmWhite 或 coolWhite，accent 只能是 blue 或 green，showPage 必须是布尔值。沿用用户未要求改变的现有参数。只输出这四个键的 JSON，不改文章和卡片内容。",
      prompt: previous ? `当前参数：${JSON.stringify(previous)}\n改版指令：${instruction}` : instruction,
      signal: controller.signal,
    });
    const json = result.text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
    const preset = presetSchema.parse(JSON.parse(json));
    const response = await fetch("/api/ai/ipCard/render", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
      body: JSON.stringify({ directory, preset }),
      signal: controller.signal,
    });
    if (!response.ok || !response.headers.get("Content-Type")?.startsWith("image/png")) {
      const detail = await response.json().catch(() => undefined);
      throw new Error(detail?.message ?? `服务器渲染失败（HTTP ${response.status}）`);
    }
    const blob = await response.blob();
    controller.signal.throwIfAborted();
    const mimeType = "image/png";
    const url = await uploadNodeFile(workspace, id, new File([blob], "ipCard03.png", { type: mimeType }));
    data.ipCardVersions = [...versions.value, { url, mimeType, preset }];
    selectedPath.value = url;
  } catch (cause) {
    showError(cause);
  } finally {
    running = undefined;
    busy.value = false;
  }
}
</script>

<style scoped>
.content { width: 430px; display: grid; gap: 10px; padding: 10px; }
.hint { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; }
.field { display: grid; gap: 4px; flex: 1; min-width: 0; font-weight: 500; }
.actions { display: flex; align-items: end; gap: 8px; }
textarea, select, button { font: inherit; }
textarea, select { background: var(--el-fill-color-light); border: 1px solid var(--el-border-color); border-radius: 6px; color: inherit; padding: 6px 8px; }
textarea { resize: vertical; }
button { border: 0; border-radius: 6px; padding: 6px 12px; white-space: nowrap; }
.primary { color: white; background: var(--el-color-primary); }
button:disabled { opacity: .5; }
img { width: 100%; aspect-ratio: 4 / 3; display: block; object-fit: contain; border-radius: 6px; }
[role="alert"] { margin: 0; color: var(--el-color-danger); overflow-wrap: anywhere; }
</style>
