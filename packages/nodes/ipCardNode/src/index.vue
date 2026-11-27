<template>
  <nodeSkeleton v-bind="nodeProps" class="ipCardNode" style="width: 740px" :fullscreenVisible="false" :downloadUrl="previewUrls[activeNumber - 1].value" :downloadName="`ipCard${activeNumber}.png`">
    <section class="content nodrag nopan nowheel" @pointerdown.stop @dblclick.stop @keydown.stop>
      <div class="scopes" aria-label="改动范围">
        <button type="button" :aria-pressed="scope === 'group'" :disabled="busy" @click="chooseScope('group')">改整组 · {{ numbers.length }} 张</button>
        <button type="button" :aria-pressed="scope === 'card'" :disabled="busy" @click="chooseScope('card')">只改第 {{ activeNumber }} 张</button>
      </div>

      <label class="field">怎么改
        <textarea v-model="prompt" aria-label="改版提示词" maxlength="600" rows="2" :disabled="busy"
          placeholder="例如：整组换冷白绿，或把品牌改成金诺盛源" />
      </label>
      <div class="actions">
        <button class="primary" type="button" :disabled="busy || !prompt.trim()" @click="propose">{{ busy && !draft ? "处理中…" : "预览改动" }}</button>
        <button type="button" :disabled="busy" @click="openDraft">手动编辑</button>
        <label class="model">文字模型
          <select v-model="modelKey" aria-label="文字模型" :disabled="busy">
            <option value="" disabled>选择模型</option>
            <option v-for="model in models" :key="getNodeModelKey(model)" :value="getNodeModelKey(model)">{{ model.label }}</option>
          </select>
        </label>
      </div>
      <p v-if="error" role="alert">{{ error }}</p>

      <section v-if="draft" class="draft" aria-label="改动预览">
        <div class="draftHeading">
          <strong>{{ scope === 'group' ? '整组改动' : `第 ${activeNumber} 张改动` }}</strong>
          <span v-if="changedCount" role="status">已改 {{ changedCount }} 张</span>
          <button class="primary" type="button" :disabled="busy || !changedCount" @click="apply">{{ busy ? "渲染中…" : `生成 ${changedCount || ""} 张新版` }}</button>
          <button type="button" :disabled="busy" @click="draft = null">取消</button>
        </div>
        <div class="styleFields">
          <label class="field">版式
            <select :value="common('layout')" :disabled="busy" @change="setStyle('layout', $event)">
              <option value="" disabled>沿用各卡版式</option>
              <option value="leftVisualRightText">左图右文</option>
              <option value="rightVisualLeftText">右图左文</option>
            </select>
          </label>
          <label class="field">背景
            <select :value="common('paper')" :disabled="busy" @change="setStyle('paper', $event)">
              <option value="" disabled>沿用各卡背景</option>
              <option value="dark">深色</option>
              <option value="warmWhite">暖白</option>
              <option value="coolWhite">冷白</option>
            </select>
          </label>
          <label class="field">强调色
            <select :value="common('accent')" :disabled="busy" @change="setStyle('accent', $event)">
              <option value="" disabled>沿用各卡强调色</option>
              <option value="purple">紫色</option><option value="blue">蓝色</option><option value="green">绿色</option>
            </select>
          </label>
          <label class="field">页码
            <select :value="common('showPage')" :disabled="busy" @change="setStyle('showPage', $event)">
              <option value="" disabled>沿用各卡页码</option>
              <option value="true">显示</option><option value="false">隐藏</option>
            </select>
          </label>
        </div>
        <label v-if="scope === 'group'" class="field">统一品牌
          <input :value="sharedBrand" maxlength="32" placeholder="输入后应用到本组所有卡" :disabled="busy" @input="setSharedBrand" />
        </label>
        <details v-for="card in draft" :key="card.number" :open="card.number === activeNumber">
          <summary>第 {{ card.number }} 张 · {{ card.copy.title }}<span v-if="copyChanged(card)"> · {{ card.copy.brand || "品牌留空" }}（文案已改）</span></summary>
          <div class="detailFields">
            <label class="field">标题<input v-model="card.copy.title" maxlength="42" :disabled="busy" /></label>
            <label class="field">品牌<input v-model="card.copy.brand" maxlength="32" :disabled="busy" /></label>
            <label class="field">重点句<input v-model="card.copy.focus" maxlength="30" :disabled="busy" /></label>
            <label class="field">补充说明<input v-model="card.copy.caption" maxlength="60" :disabled="busy" /></label>
            <div v-for="(item, index) in card.copy.items" :key="index" class="itemFields">
              <label class="field">第 {{ index + 1 }} 条标签<input v-model="item.label" maxlength="14" :disabled="busy" /></label>
              <label class="field">第 {{ index + 1 }} 条正文<input v-model="item.text" maxlength="86" :disabled="busy" /></label>
            </div>
          </div>
        </details>
      </section>
      <div class="gallery" aria-label="公众号配图整组">
        <article v-for="number in numbers" :key="number" class="card" :class="{ active: activeNumber === number }">
          <button class="cardPreview" type="button" :aria-pressed="activeNumber === number" :disabled="busy" @click="selectCard(number)">
            <img :src="view(number) ? previewUrls[number - 1].value || undefined : originals[number - 1]" :alt="`第 ${number} 张配图`" />
            <span>{{ number }} · {{ copyFor(number).title }}</span>
            <span class="cardBrand">{{ copyFor(number).brand }}</span>
          </button>
          <select :aria-label="`第 ${number} 张预览版本`" :value="viewPath(number)" :disabled="busy" @change="selectVersion(number, $event)">
            <option value="">原版</option>
            <option v-for="(version, index) in history(number)" :key="version.url" :value="version.url">第 {{ index + 1 }} 版</option>
          </select>
        </article>
      </div>

    </section>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from "vue";
import { IconPhotoEdit } from "@tabler/icons-vue";
import { findNodeModel, getNodeModelIdentity, preferredCreativeTextModel, getNodeModelKey, nodeSkeleton, uploadNodeFile, useNode, type NodeAiModel, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { defaultPreset, ipCardCopy, ipCardPreset, ipCardProposal, type IpCardCopy, type IpCardPreset } from "./preset";
import { samples } from "./samples";
import first from "./card01.png?inline";
import second from "./card02.png?inline";
import third from "./original.png?inline";
import fourth from "./card04.png?inline";
import fifth from "./card05.png?inline";

defineOptions({ inheritAttrs: false, icon: IconPhotoEdit });

type Version = NodeMediaValue & { preset: IpCardPreset; copy?: IpCardCopy; templateVersion?: number };
type Edit = { number: number; preset: IpCardPreset; copy: IpCardCopy };
type Scope = "group" | "card";

const { id, node, nodeProps, ai, files } = useNode({ label: "IP 卡片改版", onModelsChanged: () => void loadModels() });
const data = node.data as typeof node.data & {
  ipCardVersions?: Version[];
  ipCardSelected?: string;
  ipCardGroup?: { versions: Record<number, Version[]>; selected: Record<number, string> };
};
const originals = [first, second, third, fourth, fifth];
const numbers = samples.map((_, index) => index + 1);
const activeNumber = ref(3);
const scope = ref<Scope>("group");
const draft = ref<Edit[] | null>(null);
const prompt = ref("");
const models = ref<NodeAiModel[]>([]);
const modelKey = ref("");
const busy = ref(false);
const error = ref("");
let running: AbortController | undefined;

function history(number: number) {
  return data.ipCardGroup?.versions[number] ?? (number === 3 ? data.ipCardVersions : undefined) ?? [];
}
function viewPath(number: number) {
  return data.ipCardGroup?.selected[number] ?? (number === 3 ? data.ipCardSelected : undefined) ?? "";
}
function view(number: number) {
  return history(number).find(version => version.url === viewPath(number));
}
function copyFor(number: number) {
  return view(number)?.copy ?? samples[number - 1]!;
}
function presetFor(number: number) {
  return view(number)?.preset ?? defaultPreset;
}
const previewUrls = numbers.map(number => files.useFileUrl(computed(() => view(number)), showError));
function snapshot() {
  return {
    versions: Object.fromEntries(numbers.map(number => [number, history(number)])),
    selected: Object.fromEntries(numbers.map(number => [number, viewPath(number)])),
  };
}
function selectVersion(number: number, event: Event) {
  const group = snapshot();
  group.selected[number] = (event.target as HTMLSelectElement).value;
  data.ipCardGroup = group;
  selectCard(number);
}
function selectCard(number: number) {
  activeNumber.value = number;
  chooseScope("card");
}
function chooseScope(value: Scope) {
  scope.value = value;
  draft.value = null;
  error.value = "";
}
function copyChanged(card: Edit) {
  return JSON.stringify(card.copy) !== JSON.stringify(copyFor(card.number));
}
function changed(card: Edit) {
  return copyChanged(card) || JSON.stringify(card.preset) !== JSON.stringify(presetFor(card.number));
}
const changedCount = computed(() => draft.value?.filter(changed).length ?? 0);
const sharedBrand = computed(() => commonValue(draft.value?.map(card => card.copy.brand)));
function commonValue<T>(values: T[] | undefined) {
  return values?.every(value => value === values[0]) ? values[0] ?? "" : "";
}
function common<K extends keyof IpCardPreset>(key: K) {
  const value = commonValue(draft.value?.map(card => card.preset[key]));
  return String(value);
}
function setStyle(key: keyof IpCardPreset, event: Event) {
  const selected = (event.target as HTMLSelectElement).value;
  const value = key === "showPage" ? selected === "true" : selected;
  for (const card of draft.value ?? []) card.preset = ipCardPreset.parse({ ...card.preset, [key]: value });
}
function setSharedBrand(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  for (const card of draft.value ?? []) card.copy.brand = value;
}
function edits() {
  const target = scope.value === "group" ? numbers : [activeNumber.value];
  return target.map(number => ({ number, preset: { ...presetFor(number) }, copy: ipCardCopy.parse(copyFor(number)) }));
}
function openDraft() {
  error.value = "";
  draft.value ??= edits();
}
function showError(cause: unknown) {
  if (cause instanceof Error && cause.name === "AbortError") return;
  error.value = cause instanceof Error ? cause.message : "操作失败，请稍后重试";
}
async function loadModels() {
  try {
    models.value = await ai.getModels();
    if (!findNodeModel(models.value, modelKey.value)) {
      const preferred = preferredCreativeTextModel(models.value) ?? models.value[0];
      modelKey.value = preferred ? getNodeModelKey(preferred) : "";
    }
  } catch (cause) {
    showError(cause);
  }
}
onMounted(loadModels);
onScopeDispose(() => running?.abort());

async function propose() {
  const instruction = prompt.value.trim();
  if (!instruction || busy.value) return;
  const current = draft.value ?? edits();
  // ACT: 单独给出品牌名时使用明确且可查看的改动，避免文字模型把名称当版式。
  const explicitBrand = instruction.match(/^(?:请)?(?:把)?品牌(?:名|名称)?(?:都)?(?:换|改)(?:成|为)?[：:\s]*[「“"]?([\p{L}\p{N}][\p{L}\p{N}·& -]{0,27})[」”"]?$/u)?.[1];
  const shortBrand = instruction.match(/^我(?:想)?改(?:成|为)?[：:\s]*([\p{Script=Han}]{2,10})$/u)?.[1];
  const brand = (explicitBrand ?? (shortBrand && !/背景|标题|颜色|色调|版式|风格|页码|正文|冷白|暖白|深色|左图|右图|强调色/.test(shortBrand) ? shortBrand : undefined))?.trim();
  if (brand) {
    error.value = "";
    draft.value = current.map(card => ({ ...card, copy: { ...card.copy, brand } }));
    return;
  }
  const model = findNodeModel(models.value, modelKey.value);
  if (!model) return showError(new Error("请先选择文字模型，或手动编辑。"));
  error.value = "";
  const controller = new AbortController();
  running = controller;
  busy.value = true;
  try {
    const result = await ai.generate({
      ...getNodeModelIdentity(model),
      systemPrompt: "你给出卡片改动计划，输出 JSON 对象。可选 style 包含修改的部分字段：layout 为 leftVisualRightText 或 rightVisualLeftText，paper 为 dark、warmWhite、coolWhite，accent 为 purple、blue、green，showPage 为布尔值。style 应用于输入的全部卡片。可选 cards 为 [{number,copy}]，number 只允许输入已有的卡号，copy 只写改动字段 title、brand、focus、caption、items，items 为不超过 4 条的 [{label,text}]。保持未提及的字段，品牌和标题按用户指定的文字原样复制，只输出 JSON。",
      prompt: `用户要求：${instruction}\n需要修改的卡片：${JSON.stringify(current)}`,
      signal: controller.signal,
    });
    const json = result.text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, "");
    const proposal = ipCardProposal.parse(JSON.parse(json));
    const requested = proposal.cards ?? [];
    const allowed = new Set(current.map(card => card.number));
    if (requested.some(card => !allowed.has(card.number)) || new Set(requested.map(card => card.number)).size !== requested.length) {
      throw new Error("模型没有遵守选定的卡片范围，请重试或手动编辑。");
    }
    const updated = current.map(card => ({
      number: card.number,
      copy: ipCardCopy.parse({ ...card.copy, ...requested.find(change => change.number === card.number)?.copy }),
      preset: ipCardPreset.parse({ ...card.preset, ...proposal.style }),
    }));
    if (JSON.stringify(updated) === JSON.stringify(current)) throw new Error("没有解析出改动，请明确要修改的字段或手动编辑。");
    draft.value = updated;
  } catch (cause) {
    showError(cause);
  } finally {
    running = undefined;
    busy.value = false;
  }
}

async function apply() {
  if (!draft.value || busy.value) return;
  error.value = "";
  const controller = new AbortController();
  running = controller;
  busy.value = true;
  try {
    const batch = draft.value.filter(changed).map(card => ({
      ...card, copy: ipCardCopy.parse(card.copy), preset: ipCardPreset.parse(card.preset),
    }));
    const workspace = files.getWorkspaceFiles();
    const { directory } = await workspace.list();
    const outputs: { card: Edit; blob: Blob }[] = [];
    for (const card of batch) {
      const response = await fetch("/api/ai/ipCard/render", {
        method: "POST", headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
        body: JSON.stringify({ directory, ...card }), signal: controller.signal,
      });
      if (!response.ok || !response.headers.get("Content-Type")?.startsWith("image/png")) {
        const detail = await response.json().catch(() => undefined);
        throw new Error(detail?.message ?? `第 ${card.number} 张渲染失败（HTTP ${response.status}）`);
      }
      outputs.push({ card, blob: await response.blob() });
    }
    const group = snapshot();
    const uploaded: string[] = [];
    try {
      for (const { card, blob } of outputs) {
        controller.signal.throwIfAborted();
        const mimeType = "image/png";
        const url = await uploadNodeFile(workspace, id, new File([blob], `ipCard${card.number}.png`, { type: mimeType }));
        uploaded.push(url);
        group.versions[card.number] = [...history(card.number), { url, mimeType, preset: card.preset, copy: card.copy, templateVersion: 2 }];
        group.selected[card.number] = url;
      }
      controller.signal.throwIfAborted();
    } catch (cause) {
      await Promise.allSettled(uploaded.map(path => workspace.remove(path)));
      throw cause;
    }
    data.ipCardGroup = group;
    draft.value = null;
    prompt.value = "";
  } catch (cause) {
    showError(cause);
  } finally {
    running = undefined;
    busy.value = false;
  }
}
</script>

<style scoped>
.content, .draft, .detailFields { display: grid; gap: 12px; padding: 10px; }
.gallery { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(205px, 100%), 1fr)); gap: 10px; }
.card { display: grid; gap: 6px; padding: 5px; min-width: 0; border: 1px solid var(--el-border-color); border-radius: 8px; }
.card.active { border-color: var(--el-color-primary); }
.cardPreview { padding: 0; overflow: hidden; text-align: left; background: transparent; }
.cardBrand { color: var(--el-text-color-secondary); font-size: 12px; }
.cardPreview span { display: block; padding: 5px 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
img { width: 100%; aspect-ratio: 4 / 3; display: block; object-fit: contain; border-radius: 4px; }
.scopes, .actions, .draftHeading { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.field { display: grid; gap: 4px; min-width: 0; }
.styleFields, .itemFields { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(135px, 100%), 1fr)); gap: 8px; }
.model { display: flex; gap: 8px; align-items: center; min-width: 0; white-space: nowrap; }
.model select { max-width: 270px; }
button, input, textarea, select { font: inherit; color: inherit; }
input, textarea, select { width: 100%; min-width: 0; box-sizing: border-box; background: var(--el-fill-color-light); border: 1px solid var(--el-border-color); border-radius: 6px; padding: 6px 8px; }
textarea { resize: vertical; }
button { background: var(--el-fill-color); border: 0; border-radius: 6px; padding: 6px 10px; }
button[aria-pressed="true"]:not(.cardPreview), .primary { color: white; background: var(--el-color-primary); }
button:disabled { opacity: .5; }
.draft { border: 1px solid var(--el-border-color); border-radius: 8px; }
summary { cursor: pointer; padding: 4px 0; }
[role="alert"] { margin: 0; color: var(--el-color-danger); overflow-wrap: anywhere; }
</style>
