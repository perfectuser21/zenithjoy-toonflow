<template>
  <nodeSkeleton v-bind="nodeProps" style="width: 330px" :fullscreenVisible="false"
    :downloadUrl="downloadUrl" :downloadName="step === 'review' ? 'IP长文与配图.zip' : `卡${cardNumber}.png`">
    <section class="content" v-if="!step">
      <button class="nodrag" @click="expand">展开五步工作流</button>
    </section>
    <section v-else-if="step === 'result'" class="content">
      <img v-if="previewUrl" :src="previewUrl" :alt="`第 ${cardNumber} 张配图`" />
      <strong v-if="selectedCard">{{ selectedCard.copy.title }}</strong>
      <span v-else>等待渲染</span>
      <button v-if="selectedCard" class="nodrag" :disabled="!inputCurrent" @click="editResult">编辑第 {{ cardNumber }} 张</button>
      <span v-if="selectedCard && !inputCurrent" role="status">上游有更新 · 当前为上次渲染</span>
      <span v-if="error" role="alert">{{ error }}</span>
    </section>
    <section v-else class="content nodrag nopan nowheel" @keydown.stop @dblclick.stop>
      <div class="promptBar">
        <span class="status" role="status">{{ status }}</span>
        <button class="promptButton" :disabled="busy" @click="openPromptEditor">{{ step === 'review' ? '编辑审核要求' : '编辑提示词' }}</button>
      </div>
      <details>
        <summary>Skill · {{ skill?.name }} · {{ skill?.version }}</summary>
        <p>{{ skill?.source }}</p>
        <pre>{{ skill?.body }}</pre>
        <label>项目 Skill 路径
          <input v-model="skillPath" placeholder="skill/公众号/SKILL.md" :disabled="busy" />
        </label>
        <div class="actions">
          <button :disabled="busy || !skillPath.trim()" @click="loadSkill">加载并固定版本</button>
          <button :disabled="busy || skill?.source === 'Toonflow 内置'" @click="resetSkill">使用内置 Skill</button>
        </div>
        <details v-if="state.lastPrompt">
          <summary>上次运行使用的提示词</summary>
          <pre>{{ state.lastPrompt }}</pre>
        </details>
      </details>
      <template v-if="step === 'topic'">
        <div class="actions">
          <button class="promptButton" :disabled="busy" @click="openNotion">{{ activeNotion ? '重新读取 Notion' : '从 Notion 导入' }}</button>
          <a v-if="activeNotion" :href="activeNotion.url" target="_blank" rel="noopener noreferrer">打开原文</a>
        </div>
        <details v-if="activeNotion">
          <summary>{{ activeNotion.title }} · 已读取</summary>
          <p>原文更新时间 {{ formatSourceDate(activeNotion.editedAt) }}</p>
          <pre>{{ activeNotion.content }}</pre>
          <button :disabled="busy" @click="removeNotion">移除素材</button>
        </details>
        <label>{{ activeNotion ? '补充选题要求' : '选题需求与已有素材' }}
          <textarea :value="state.sourceText ?? ''" rows="4" maxlength="16000" :disabled="busy" @input="updateSource" />
        </label>
      </template>
      <details v-if="step === 'article'">
        <summary>使用已有长文</summary>
        <label>长文 Markdown
          <textarea :value="state.sourceText ?? ''" rows="5" maxlength="30000" :disabled="busy" @input="updateSource" />
        </label>
      </details>
      <details v-if="step !== 'topic'">
        <summary>查看上游输入</summary>
        <pre>{{ inputSummary }}</pre>
      </details>

      <label v-if="canUseAi">文字模型
        <select v-model="modelKey" :disabled="busy">
          <option value="">选择模型</option>
          <option v-for="model in models" :key="getNodeModelKey(model)" :value="getNodeModelKey(model)">{{ model.label }}</option>
        </select>
      </label>
      <template v-if="step === 'render'">
        <label>改动范围
          <select v-model="targetCard" :disabled="busy">
            <option :value="0">整组五张</option>
            <option v-for="number in 5" :key="number" :value="number" :disabled="!canEditOne">只改第 {{ number }} 张</option>
          </select>
        </label>
        <div class="fields">
          <label>版式
            <select aria-label="版式" v-model="preset.layout" :disabled="busy">
              <option value="leftVisualRightText">左图右文</option><option value="rightVisualLeftText">右图左文</option>
            </select>
          </label>
          <label>背景
            <select aria-label="背景" v-model="preset.paper" :disabled="busy">
              <option value="dark">深色</option><option value="warmWhite">暖白</option><option value="coolWhite">冷白</option>
            </select>
          </label>
          <label>强调色
            <select aria-label="强调色" v-model="preset.accent" :disabled="busy">
              <option value="purple">紫色</option><option value="blue">蓝色</option><option value="green">绿色</option>
            </select>
          </label>
          <label class="check"><input v-model="preset.showPage" type="checkbox" :disabled="busy" />显示页码</label>
        </div>
        <details v-if="targetCard && cardDraft" open>
          <summary>第 {{ targetCard }} 张文案</summary>
          <label>标题<input v-model="cardDraft.title" maxlength="42" :disabled="busy" /></label>
          <label>品牌<input v-model="cardDraft.brand" maxlength="32" :disabled="busy" /></label>
          <label>重点句<input v-model="cardDraft.focus" maxlength="30" :disabled="busy" /></label>
          <label>补充说明<textarea v-model="cardDraft.caption" maxlength="60" :disabled="busy" /></label>
          <div v-for="(item, index) in cardDraft.items" :key="index">
            <label>要点 {{ index + 1 }} 标签<input v-model="item.label" maxlength="14" :disabled="busy" /></label>
            <label>要点 {{ index + 1 }} 正文<textarea v-model="item.text" maxlength="86" :disabled="busy" /></label>
          </div>
        </details>
        <div class="actions">
          <button :disabled="busy || !inputCurrent || !modelKey" @click="recommendStyle">AI 推荐版式</button>
          <button :disabled="busy || !inputCurrent || !input?.copies" @click="run">渲染{{ targetCard ? `第 ${targetCard} 张` : '整组' }}</button>
        </div>
      </template>
      <template v-else-if="step === 'review'">
        <details>
          <summary>审核清单</summary>
          <pre>{{ prompt }}</pre>
        </details>
        <details v-if="input?.article">
          <summary>查看待审长文</summary>
          <pre>{{ input.article }}</pre>
        </details>
        <ol v-if="input?.cards"><li v-for="card in input.cards" :key="card.url">{{ card.copy.title }}</li></ol>
        <button :disabled="busy || !inputCurrent || !input?.cards" @click="run">审核通过并导出</button>
        <a v-if="downloadUrl && current" :href="downloadUrl" download="IP长文与配图.zip">下载 Markdown 和五张 PNG</a>
      </template>
      <button v-else :disabled="busy || !runnable" @click="run">
        {{ step === 'article' && state.sourceText?.trim() ? '采纳已有长文' : '运行这一步' }}
      </button>
      <button v-if="step === 'topic'" @click="showWorkflow">总览工作流</button>
      <details v-if="receipt">
        <summary>{{ current ? '查看当前输出' : '查看上次输出' }}</summary>
        <pre>{{ summarize(receipt) }}</pre>
      </details>
      <label v-if="step === 'render' && state.renderHistory?.length">历史渲染
        <select v-model="restoredRender" :disabled="busy">
          <option value="">选择历史版本</option>
          <option v-for="(version, index) in state.renderHistory" :key="version.revision" :value="version.revision">第 {{ index + 1 }} 次渲染</option>
        </select>
      </label>
      <button v-if="restoredRender" :disabled="busy || !inputCurrent" @click="restoreRender">恢复选中版本为当前图</button>
      <p v-if="error" role="alert">{{ error }}</p>
    </section>
  </nodeSkeleton>
  <el-dialog v-if="promptEditorOpen" v-model="promptEditorOpen"
    :title="`${step === 'review' ? '编辑审核要求' : '编辑提示词'} · ${executable ? labels[executable] : ''}`"
    width="min(720px, calc(100vw - 32px))" appendToBody :closeOnClickModal="false">
    <div class="promptEditor" @keydown.stop>
      <label>当前提示词
        <textarea v-model="promptDraft" maxlength="24000" aria-label="当前提示词" />
      </label>
      <div class="actions">
        <button @click="promptDraft = defaultPrompt">载入 Skill 默认提示词</button>
        <select v-if="state.promptHistory?.length" v-model="restoredPrompt" aria-label="历史提示词版本" @change="restorePrompt">
          <option value="">历史版本</option>
          <option v-for="(version, index) in state.promptHistory" :key="version.id" :value="version.id">第 {{ index + 1 }} 版</option>
        </select>
      </div>
      <p class="status">保存后，仅在此节点下次运行时生效。</p>
    </div>
    <template #footer>
      <el-button @click="promptEditorOpen = false">取消</el-button>
      <el-button type="primary" :disabled="!promptDirty || !promptDraft.trim() || busy" @click="savePrompt">保存提示词版本</el-button>
    </template>
  </el-dialog>
  <el-dialog v-if="notionOpen" v-model="notionOpen" title="从 Notion 导入选题素材"
    width="min(720px, calc(100vw - 32px))" appendToBody :closeOnClickModal="false">
    <div class="promptEditor">
      <label>Notion 页面链接
        <input v-model="notionUrl" aria-label="Notion 页面链接" type="url" maxlength="2048" :disabled="busy" @input="notionPreview = undefined" />
      </label>
      <div class="actions">
        <el-button :disabled="busy || !notionUrl.trim()" @click="readNotion">读取素材</el-button>
        <a v-if="notionPreview" :href="notionPreview.url" target="_blank" rel="noopener noreferrer">打开原文</a>
      </div>
      <section v-if="notionPreview" aria-label="Notion 素材预览">
        <strong>{{ notionPreview.title }}</strong>
        <p class="status">原文更新时间 {{ formatSourceDate(notionPreview.editedAt) }}</p>
        <pre>{{ notionPreview.content }}</pre>
      </section>
      <p v-if="error" class="notionError" role="alert">{{ error }}</p>
    </div>
    <template #footer>
      <el-button @click="notionOpen = false">取消</el-button>
      <el-button type="primary" :disabled="busy || !notionPreview" @click="adoptNotion">带入选题</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import { useVueFlow, type GraphNode } from "@vue-flow/core";
import { ElButton, ElDialog } from "element-plus";
import { IconSitemap } from "@tabler/icons-vue";
import { strToU8, zipSync } from "fflate";
import { defaultPreset, ipCardCopy, ipCardPreset, type IpCardCopy, type IpCardPreset } from "@toonflow/node-ip-card/preset";
import { findNodeModel, getNodeModelIdentity, getNodeModelKey, nodeSkeleton, uploadNodeFile, useNode, type NodeAiModel, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";
import { builtInSkill, effectivePrompt, fiveCopies, labels, notionSnapshot, parseModelJson, readReceipt, steps, type NotionSnapshot, type Receipt, type SavedCard, type Skill, type Step } from "./workflow";

defineOptions({
  inheritAttrs: false,
  icon: IconSitemap,
  handles: [
    { id: "in", type: "target", dataType: "STRING", label: "上一步输出" },
    { id: "out", type: "source", dataType: "STRING", label: "本步输出" },
  ] satisfies NodeHandle[],
});

interface WorkflowState {
  step?: Step | "result";
  cardNumber?: number;
  sourceText?: string;
  notion?: NotionSnapshot;
  skill?: Skill;
  model?: string;
  promptOverride?: string;
  promptText?: string;
  configRevision?: string;
  promptHistory?: { id: string; text: string; full?: true }[];
  lastPrompt?: string;
  renderHistory?: Receipt[];
}
const { id, node, nodeProps, outputs, ai, files } = useNode({
  label: "IP 五步工作流",
  outputs: { out: { dataType: "STRING", value: "" } },
  onModelsChanged: () => void loadModels(),
});
const flow = useVueFlow();
const state = computed(() => node.data as typeof node.data & WorkflowState);
const step = computed(() => state.value.step);
const cardNumber = computed(() => state.value.cardNumber ?? 1);
const executable = computed(() => step.value && step.value !== "result" ? step.value : undefined);
const skill = computed(() => state.value.skill ?? (executable.value ? builtInSkill(executable.value) : undefined));
const defaultPrompt = computed(() => executable.value && skill.value ? effectivePrompt(executable.value, skill.value, "") : "");
const prompt = computed(() => {
  if (state.value.promptText !== undefined) return state.value.promptText;
  return executable.value && skill.value ? effectivePrompt(executable.value, skill.value, state.value.promptOverride ?? "") : "";
});
const promptEditorOpen = ref(false);
const promptDraft = ref("");
const promptDirty = computed(() => promptDraft.value !== prompt.value);
const skillPath = ref("");
const restoredPrompt = ref("");
const notionOpen = ref(false);
const notionUrl = ref("");
const notionPreview = ref<NotionSnapshot>();
const activeNotion = computed(() => {
  const parsed = notionSnapshot.safeParse(state.value.notion);
  return parsed.success ? parsed.data : undefined;
});
const modelKey = computed({ get: () => state.value.model ?? "", set: value => { state.value.model = value; } });
const models = ref<NodeAiModel[]>([]);
const canUseAi = computed(() => executable.value && executable.value !== "review" && !(step.value === "article" && state.value.sourceText?.trim()));
const busy = ref(false);
const error = ref("");
const targetCard = ref(0);
const cardDraft = ref<IpCardCopy>();
const preset = ref<IpCardPreset>({ ...defaultPreset });
const restoredRender = ref("");
const receipt = computed(() => readReceipt(outputs.value.out.value));
watch(() => !!(activeNotion.value?.snapshotPath || receipt.value?.notionReference?.snapshotPath
  || receipt.value?.cards || receipt.value?.exportPath || state.value.renderHistory?.length), scoped => {
  if (scoped) state.value.workspaceScoped = true;
  else delete state.value.workspaceScoped;
}, { immediate: true, flush: "sync" });
const type = "remote-ipWorkflowNode";
const editCardEvent = "toonflow:editIpWorkflowCard";
function editResult() {
  if (!parent.value || !inputCurrent.value) return;
  const render = parent.value;
  window.dispatchEvent(new CustomEvent(editCardEvent, { detail: { id: render.id, number: cardNumber.value } }));
  flow.addSelectedNodes([render]);
  const { x, y } = render.computedPosition;
  void flow.setCenter(x + 165, y + (render.dimensions.height || 300) / 2, { zoom: 1, duration: 250 });
}
function handleEditResult(event: Event) {
  const requested = (event as CustomEvent<{ id: string; number: number }>).detail;
  if (step.value === "render" && requested?.id === id && canEditOne.value && !busy.value) targetCard.value = requested.number;
}

let running: AbortController | undefined;
onScopeDispose(() => {
  running?.abort();
  if (step.value === "render") window.removeEventListener(editCardEvent, handleEditResult);
});

function parentOf(candidate: GraphNode) {
  const links = flow.edges.value.filter(link => link.target === candidate.id && link.targetHandle === "in");
  const link = links.length === 1 ? links[0] : undefined;
  const parent = link?.sourceHandle === "out" ? flow.findNode(link.source) : undefined;
  return parent?.type === type ? parent : undefined;
}

function valueOf(candidate?: GraphNode) {
  return readReceipt(candidate?.data.outputs?.out?.value);
}

function isCurrent(candidate?: GraphNode, seen = new Set<string>()): boolean {
  if (!candidate || seen.has(candidate.id)) return false;
  seen.add(candidate.id);
  const data = candidate.data as WorkflowState;
  const result = valueOf(candidate);
  if (!result || result.promptRevision !== (data.configRevision ?? "initial")) return false;
  if (data.step === "topic") return !result.sourceRevision;
  const parent = parentOf(candidate);
  if (!parent || parent.data.step !== previousStep(data.step)) return false;
  return result.sourceRevision === valueOf(parent)?.revision && isCurrent(parent, seen);
}

function previousStep(next?: WorkflowState["step"]) {
  return next === "result" ? "render" : steps[steps.indexOf(next as Step) - 1];
}

const parent = computed(() => parentOf(node));
const input = computed(() => parent.value?.data.step === previousStep(step.value) ? valueOf(parent.value) : undefined);
const inputCurrent = computed(() => !!input.value && isCurrent(parent.value));
const current = computed(() => isCurrent(node));
const status = computed(() => busy.value ? "处理中…" : current.value ? "已完成" : receipt.value ? "内容有更新 · 请重跑" : step.value === "topic" || inputCurrent.value ? "待运行" : "等待上一步");
const runnable = computed(() => step.value === "topic"
  ? (!!state.value.sourceText?.trim() || !!activeNotion.value) && !!modelKey.value
  : inputCurrent.value && (!!modelKey.value || (step.value === "article" && !!state.value.sourceText?.trim())));
const canEditOne = computed(() => !!receipt.value?.cards && receipt.value.sourceRevision === input.value?.revision && inputCurrent.value);
const selectedCard = computed(() => step.value === "result" ? input.value?.cards?.[cardNumber.value - 1] : undefined);
const previewUrl = files.useFileUrl(selectedCard, showError);
const exportFile = computed(() => step.value === "review" && current.value && receipt.value?.exportPath
  ? { url: receipt.value.exportPath, mimeType: "application/zip" } : undefined);
const exportUrl = files.useFileUrl(exportFile, showError);
const downloadUrl = computed(() => step.value === "review" ? exportUrl.value : previewUrl.value);
const inputSummary = computed(() => input.value ? summarize(input.value) : "上一步暂无输出");

watch([targetCard, inputCurrent], () => {
  if (!canEditOne.value) targetCard.value = 0;
  const card = receipt.value?.cards?.[targetCard.value - 1];
  preset.value = { ...(card?.preset ?? receipt.value?.groupPreset ?? defaultPreset) };
  cardDraft.value = card ? { ...card.copy, items: card.copy.items.map(item => ({ ...item })) } : undefined;
}, { immediate: true });

watch(canUseAi, enabled => { if (enabled && !models.value.length) void loadModels(); }, { immediate: true });
onMounted(() => {
  if (step.value === "render") window.addEventListener(editCardEvent, handleEditResult);
});
function showError(cause: unknown) {
  if (cause instanceof Error && cause.name === "AbortError") return;
  error.value = cause instanceof Error ? cause.message : String(cause);
}

async function loadModels() {
  if (!executable.value || step.value === "review") return;
  try {
    models.value = await ai.getModels();
    if (!modelKey.value && models.value[0]) modelKey.value = getNodeModelKey(models.value[0]);
  } catch (cause) {
    showError(cause);
  }
}

function expand() {
  if (step.value) return;
  const origin = node.computedPosition;
  const ids = [id, ...Array.from({ length: 9 }, () => crypto.randomUUID())];
  state.value.step = "topic";
  state.value.skill = builtInSkill("topic");
  state.value.label = labels.topic;
  flow.addNodes(steps.slice(1).map((step, index) => ({
    type, id: ids[index + 1], position: { x: origin.x + 420 * (index + 1), y: origin.y },
    data: { step, label: labels[step], skill: builtInSkill(step), outputs: {} },
  })));
  flow.addNodes(Array.from({ length: 5 }, (_, index) => ({
    type, id: ids[index + 5], position: { x: origin.x + 420 * 5, y: origin.y + 300 * index },
    data: { step: "result", label: `卡${"一二三四五"[index]}`, cardNumber: index + 1, outputs: {} },
  })));
  flow.addEdges(ids.slice(1).map((target, index) => ({
    id: crypto.randomUUID(), source: ids[index < 4 ? index : 3], target, sourceHandle: "out", targetHandle: "in",
  })));
}

function showWorkflow() {
  const ids = new Set([id]);
  const pending = [id];
  while (pending.length) {
    const source = pending.pop();
    for (const edge of flow.edges.value) {
      if (edge.source !== source || ids.has(edge.target) || flow.findNode(edge.target)?.type !== type) continue;
      ids.add(edge.target);
      pending.push(edge.target);
    }
  }
  void flow.fitView({ nodes: [...ids], padding: 0.14, duration: 250 });
}

function invalidate() {
  state.value.configRevision = crypto.randomUUID();
}

function updateSource(event: Event) {
  const text = (event.target as HTMLTextAreaElement).value;
  if (state.value.sourceText === text) return;
  state.value.sourceText = text;
  invalidate();
}

function openNotion() {
  notionUrl.value = activeNotion.value?.url ?? "";
  notionPreview.value = undefined;
  error.value = "";
  notionOpen.value = true;
}

function formatSourceDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value));
}

async function readNotion() {
  const url = notionUrl.value.trim();
  if (!url) return;
  notionPreview.value = undefined;
  await perform(async signal => {
    const workspace = files.getWorkspaceFiles();
    const { directory } = await workspace.list();
    const response = await fetch("/api/ai/ipWorkflow/notionSource", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
      body: JSON.stringify({ directory, url }), signal,
    });
    const result = await response.json().catch(() => undefined);
    if (!response.ok || result?.code !== 200) throw new Error(result?.message ?? "读取 Notion 素材失败");
    if (notionOpen.value && notionUrl.value.trim() === url) notionPreview.value = notionSnapshot.parse(result.data);
  });
}

async function adoptNotion() {
  const snapshot = notionPreview.value;
  if (!snapshot || busy.value) return;
  const currentSource = activeNotion.value;
  if (currentSource?.id === snapshot.id && currentSource.version === snapshot.version
      && currentSource.editedAt === snapshot.editedAt && currentSource.title === snapshot.title) {
    notionOpen.value = false;
    return;
  }
  await perform(async signal => {
    const workspace = files.getWorkspaceFiles();
    const file = new File([JSON.stringify(snapshot)], "notionSource.json", { type: "application/json" });
    const snapshotPath = await uploadNodeFile(workspace, id, file);
    signal.throwIfAborted();
    state.value.notion = { ...snapshot, snapshotPath };
    invalidate();
    notionOpen.value = false;
  });
}

function removeNotion() {
  delete state.value.notion;
  invalidate();
}

function openPromptEditor() {
  promptDraft.value = prompt.value;
  restoredPrompt.value = "";
  promptEditorOpen.value = true;
}

function savePrompt() {
  const text = promptDraft.value;
  if (!promptDirty.value || !text.trim() || busy.value) return;
  delete state.value.promptOverride;
  if (text === defaultPrompt.value) delete state.value.promptText;
  else state.value.promptText = text;
  invalidate();
  state.value.promptHistory = [...(state.value.promptHistory ?? []), { id: state.value.configRevision!, text, full: true }];
  promptEditorOpen.value = false;
}

function restorePrompt() {
  const version = state.value.promptHistory?.find(version => version.id === restoredPrompt.value);
  if (!version || !executable.value || !skill.value) return;
  promptDraft.value = version.full ? version.text : effectivePrompt(executable.value, skill.value, version.text);
}

function resetSkill() {
  if (!executable.value) return;
  state.value.skill = builtInSkill(executable.value);
  invalidate();
}

async function loadSkill() {
  const path = skillPath.value.trim();
  if (!path.startsWith("skill/") || !path.endsWith("/SKILL.md") || path.split("/").some(segment => !segment || segment === "." || segment === "..") || /[\\\\:%]/.test(path)) {
    error.value = "请输入项目 skill 目录内的 SKILL.md 路径";
    return;
  }
  await perform(async () => {
    const body = await files.getWorkspaceFiles().readText(path);
    if (!body.trim() || body.length > 16000) throw new Error("Skill 需要包含正文且不能超过 16,000 字");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    const version = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    state.value.skill = { name: path.split("/").at(-2)!, version: version.slice(0, 12), source: path, body };
    invalidate();
  });
}

function summarize(result: Receipt) {
  if (result.cards) return result.cards.map((card, index) => `卡${index + 1} · ${card.copy.title} · ${card.preset.paper}\n${card.url}`).join("\n\n");
  if (result.copies) return JSON.stringify(result.copies, null, 2);
  return result.text ?? result.article ?? "";
}

async function perform(action: (signal: AbortSignal) => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  const controller = new AbortController();
  running = controller;
  try { await action(controller.signal); }
  catch (cause) { showError(cause); }
  finally { busy.value = false; running = undefined; }
}

async function generate(systemPrompt: string, task: string, signal: AbortSignal) {
  const model = findNodeModel(models.value, modelKey.value);
  if (!model) throw new Error("请选择可用的文字模型");
  const result = await ai.generate({ ...getNodeModelIdentity(model), systemPrompt, prompt: task, signal });
  const text = result.text.trim();
  if (!text) throw new Error("模型没有返回内容");
  return text;
}

async function recommendStyle() {
  const source = input.value;
  if (!inputCurrent.value || !source?.copies) return;
  await perform(async signal => {
    const text = await generate(prompt.value, JSON.stringify(source.copies), signal);
    if (!inputCurrent.value || input.value?.revision !== source.revision) throw new Error("上游内容已更新，请重新推荐");
    preset.value = ipCardPreset.parse(parseModelJson(text));
    state.value.lastPrompt = prompt.value;
  });
}

function commit(output: Receipt, usedPrompt?: string) {
  if (output.sourceRevision && (!inputCurrent.value || output.sourceRevision !== input.value?.revision)) throw new Error("上游内容已更新，请重跑此步");
  if (output.promptRevision !== (state.value.configRevision ?? "initial")) throw new Error("节点配置已更新，请重跑此步");
  if (usedPrompt !== undefined) state.value.lastPrompt = usedPrompt;
  outputs.value.out.value = JSON.stringify(output);
}

async function run() {
  const currentStep = executable.value;
  if (!currentStep || (currentStep !== "topic" && !inputCurrent.value)) return;
  const source = input.value;
  const nodePrompt = prompt.value;
  const localSource = state.value.sourceText?.trim();
  const imported = activeNotion.value;
  await perform(async signal => {
    const result: Receipt = { revision: crypto.randomUUID(), promptRevision: state.value.configRevision ?? "initial" };
    if (source?.notionReference) result.notionReference = source.notionReference;
    if (currentStep !== "topic") result.sourceRevision = source?.revision;
    let usedPrompt: string | undefined;
    if (currentStep === "topic" && (localSource || imported)) {
      let topicInput = localSource ?? "";
      if (imported) {
        const { content, ...reference } = imported;
        result.notionSnapshot = imported;
        result.notionReference = reference;
        topicInput = [topicInput, `Notion 摘录（作为参考资料）：\n${reference.title}\n${reference.url}\n\n${content}`].filter(Boolean).join("\n\n");
      }
      result.text = await generate(nodePrompt, topicInput, signal);
      usedPrompt = nodePrompt;
    } else if (currentStep === "article" && source?.text) {
      const snapshot = source.notionSnapshot;
      const brief = snapshot ? `${source.text}\n\nNotion 原始素材（作为参考资料）：\n${snapshot.content}` : source.text;
      result.article = localSource || await generate(nodePrompt, brief, signal);
      usedPrompt = localSource ? "" : nodePrompt;
    } else if (currentStep === "cards" && source?.article) {
      result.article = source.article;
      result.copies = fiveCopies.parse(parseModelJson(await generate(nodePrompt, source.article, signal)));
      usedPrompt = nodePrompt;
    } else if (currentStep === "render" && source?.article && source.copies) {
      result.article = source.article;
      result.groupPreset = targetCard.value ? receipt.value?.groupPreset : ipCardPreset.parse(preset.value);
      result.cards = await renderCards(source.copies, signal);
    } else if (currentStep === "review" && source?.article && source.cards) {
      result.cards = source.cards;
      result.article = source.article;
      result.exportPath = await exportArticle(source.article, source.cards, source.notionReference, signal);
      usedPrompt = nodePrompt;
    } else {
      throw new Error("请先完成节点所需的输入");
    }
    signal.throwIfAborted();
    commit(result, usedPrompt);
    if (currentStep === "render") state.value.renderHistory = [...(state.value.renderHistory ?? []), result];
  });
}

async function renderCards(copies: NonNullable<Receipt["copies"]>, signal: AbortSignal) {
  const one = targetCard.value;
  const previous = receipt.value?.cards;
  if (one && (!canEditOne.value || !previous)) throw new Error("上游已更新，请先重新渲染整组");
  const indices = one ? [one - 1] : copies.map((_, index) => index);
  const style = ipCardPreset.parse(preset.value);
  const copy = one ? ipCardCopy.parse(cardDraft.value) : undefined;
  const workspace = files.getWorkspaceFiles();
  const { directory } = await workspace.list();
  const cards = previous ? [...previous] : [];
  for (const index of indices) {
    const number = index + 1;
    const content = copy ?? copies[index];
    const response = await fetch("/api/ai/ipCard/render", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-toonflow-workspace": "1" },
      body: JSON.stringify({ directory, number, copy: content, preset: style }),
      signal,
    });
    if (!response.ok || !response.headers.get("Content-Type")?.startsWith("image/png")) {
      const detail = await response.json().catch(() => undefined);
      throw new Error(detail?.message ?? `卡${number}渲染失败（HTTP ${response.status}）`);
    }
    const mimeType = "image/png";
    const blob = await response.blob();
    signal.throwIfAborted();
    const url = await uploadNodeFile(workspace, id, new File([blob], `card${number}.png`, { type: mimeType }));
    cards[index] = { copy: content, preset: style, url, mimeType, templateVersion: 2, assetReference: `toonflow:ipCardNode/template2/card${number}` };
  }
  return cards;
}

function restoreRender() {
  const version = state.value.renderHistory?.find(version => version.revision === restoredRender.value);
  if (!version || version.sourceRevision !== input.value?.revision || !inputCurrent.value) {
    error.value = "该版本属于旧版文章或拆卡结果，请查看历史输出";
    return;
  }
  commit({ ...version, revision: crypto.randomUUID(), promptRevision: state.value.configRevision ?? "initial" });
  error.value = "";
  restoredRender.value = "";
  targetCard.value = 0;
  preset.value = { ...(version.groupPreset ?? defaultPreset) };
}

async function exportArticle(article: string, cards: SavedCard[], source: Receipt["notionReference"], signal: AbortSignal) {
  const workspace = files.getWorkspaceFiles();
  const contents: Record<string, Uint8Array> = {};
  const references: string[] = [];
  for (const [index, card] of cards.entries()) {
    const path = `images/card${index + 1}.png`;
    contents[path] = new Uint8Array(await workspace.read(card.url, signal));
    references.push(`![卡${index + 1}](${path})`);
  }
  if (source?.snapshotPath) {
    const file = await workspace.read(source.snapshotPath, signal);
    const snapshot = notionSnapshot.parse(JSON.parse(new TextDecoder().decode(file)));
    if (snapshot.id !== source.id || snapshot.version !== source.version || snapshot.editedAt !== source.editedAt) throw new Error("Notion 素材快照与此稿不匹配");
    contents["notionSource.json"] = strToU8(JSON.stringify(snapshot, null, 2));
  }
  const attribution = source ? `\n\n## 素材来源\n\n${source.url}\n\n原文更新时间：${source.editedAt}\n素材版本：${source.version}\n` : "";
  contents["article.md"] = strToU8(`${article}${attribution}\n\n## 配图\n\n${references.join("\n\n")}\n`);
  contents["cards.json"] = strToU8(JSON.stringify(cards.map(({ url: _url, ...card }, index) => ({ ...card, png: `images/card${index + 1}.png` })), null, 2));
  const archive = zipSync(contents, { level: 0 });
  signal.throwIfAborted();
  return uploadNodeFile(workspace, id, new File([archive], "article.zip", { type: "application/zip" }));
}
</script>

<style scoped>
.content { display: grid; gap: 10px; padding: 12px; font-size: 13px; }
.content img { display: block; width: 100%; aspect-ratio: 4 / 3; object-fit: contain; }
.status, .content p { margin: 0; color: var(--el-text-color-secondary); }
.content label { display: grid; gap: 4px; }
.content .check { display: flex; align-items: center; }
.content button, .content input, .content select, .content textarea {
  max-width: 100%; min-width: 0; font: inherit; padding: 5px 7px; border: 1px solid var(--el-border-color);
  border-radius: 5px; color: var(--el-text-color-primary); background: var(--el-bg-color);
}
.content button { cursor: pointer; }
.content button:disabled { opacity: .55; cursor: default; }
.content textarea { resize: vertical; }
.content pre {
  max-height: 230px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  background: var(--el-fill-color-light); border-radius: 6px; padding: 8px;
}
.content summary { cursor: pointer; }
.content [role="alert"] { color: var(--el-color-danger); overflow-wrap: anywhere; }
.actions { display: flex; flex-wrap: wrap; gap: 5px; margin-block: 5px; }
.promptBar { display: flex; gap: 8px; align-items: center; justify-content: space-between; }
.content .promptButton { color: var(--el-color-primary); border-color: var(--el-color-primary-light-7); white-space: nowrap; }
.promptEditor { display: grid; gap: 8px; }
.promptEditor label { display: grid; gap: 8px; }
.promptEditor input { padding: 8px; font: inherit; color: var(--el-text-color-primary); background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: 6px; }
.promptEditor pre { max-height: 35vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.notionError { color: var(--el-color-danger); }
.promptEditor textarea {
  box-sizing: border-box; width: 100%; min-height: min(34vh, 280px); max-height: 48vh; resize: vertical;
  padding: 10px; border: 1px solid var(--el-border-color); border-radius: 6px;
  background: var(--el-bg-color); color: var(--el-text-color-primary); font: inherit; line-height: 1.55;
}
.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
</style>
