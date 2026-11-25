<template>
  <el-dialog v-model="visible" title="视频翻拍" width="850px" class="nodrag nopan" appendToBody destroyOnClose>
    <div class="remakeBody" @pointerdown.stop @dblclick.stop>
      <nav v-if="!current?.productSwap" class="remakeStages" aria-label="翻拍步骤">
        <button v-for="(label, index) in ['分析原片', '生成样张', '生成成片']" :key="label" type="button"
          :disabled="!!activity || index > 0 && !current?.planApproved"
          :aria-current="stage === index ? 'step' : undefined" @click="stage = index">{{ index + 1 }}. {{ label }}</button>
      </nav>
      <p v-if="message" class="remakeMessage" role="status">{{ message }}</p>
      <p v-if="failure" class="remakeFailure" role="alert">{{ failure }}</p>

      <section v-if="stage === 0" aria-label="分析原片">
        <div class="remakeActions">
          <el-select v-model="analysisModelKey" placeholder="选择视觉分析模型" aria-label="视觉分析模型" :disabled="!!activity || !!current?.job">
            <el-option v-for="model in analysisModels" :key="getNodeModelKey(model)" :value="getNodeModelKey(model)" :label="model.label" />
          </el-select>
          <el-button v-if="savedToReuse" type="primary" :loading="activity === 'analysis'" :disabled="!!activity || locked" @click="reuseAnalysis">沿用拉片结果</el-button>
          <el-button :type="savedToReuse ? 'default' : 'primary'" :loading="activity === 'analysis'" :disabled="!source || !analysisModel || !!activity || locked" @click="analyze">
            {{ current || savedToReuse ? "重新分析原片" : "分析原片" }}
          </el-button>
        </div>
        <div v-if="!current" class="remakeActions productSwapActions">
          <input ref="productInput" type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="新商品参考图" @change="selectProductReference" />
          <el-button :disabled="!source || !!activity" @click="productInput?.click()">一键换品</el-button>
        </div>
        <template v-if="current">
          <p class="remakeSummary">{{ current.analysis.scenes.length }} 段 · {{ current.groups.length }} 组背景 · {{ current.analysis.duration.toFixed(2) }} 秒</p>
          <p v-if="current.product">商品 {{ current.product }}</p>
          <p v-if="current.style">风格 {{ current.style }}</p>
          <p v-if="current.transcript.kind === 'missing'" class="remakeNote">{{ current.transcript.reason }}。请补录原片文案，或确认使用画面字幕或无口播。</p>
          <p v-else-if="current.transcript.kind === 'silent'" class="remakeNote">已确认原片无口播。</p>
          <p v-else-if="current.transcript.kind === 'captions'" class="remakeNote">使用下方各镜头实际可见的字幕。</p>
          <label class="remakeField">原片文案
            <textarea :value="'text' in current.transcript ? current.transcript.text : ''" rows="3" maxlength="20000"
              :disabled="!!activity || locked" @change="changeTranscript" />
          </label>
          <div class="remakeActions">
            <el-button v-if="current.transcript.kind === 'missing' && current.shots.some(shot => shot.caption)" :disabled="!!activity || locked" @click="chooseTranscript('captions')">使用画面字幕</el-button>
            <el-button v-if="current.transcript.kind === 'missing'" :disabled="!!activity || locked" @click="chooseTranscript('silent')">原片无口播</el-button>
            <el-button :disabled="!!activity || locked || !analysisModel" @click="writePrompts">按当前分组和文案编写提示词</el-button>
            <el-button type="primary" :disabled="!!activity || !planReady" @click="approvePlan">确认分组，进入样张</el-button>
          </div>
          <div class="remakeShots">
            <article v-for="shot in current.shots" :key="shot.id" class="remakeShot">
              <header>
                <strong>镜头 {{ shot.id }}</strong>
                <span>{{ formatSceneTime(current.analysis.scenes[shot.id - 1]!.start) }}–{{ formatSceneTime(current.analysis.scenes[shot.id - 1]!.end) }}</span>
              </header>
              <label>背景分组
                <select :value="shot.group ?? ''" :disabled="!!activity || locked" @change="changeGroup(shot.id, $event)">
                  <option value="">待确认</option>
                  <option v-for="group in current.groups" :key="group.id" :value="group.id">背景 {{ group.id }}</option>
                  <option v-if="!current.groups.some(group => group.id === shot.id)" :value="shot.id">独立成组</option>
                </select>
              </label>
              <el-button v-if="shot.id > 1" size="small" text :disabled="!!activity || locked" @click="mergeShot(shot.id)">与上一镜头合并</el-button>
              <p v-if="shot.evidence" class="remakeNote">{{ shot.evidence }}</p>
              <p v-if="shot.caption">原画面字幕 {{ shot.caption }}</p>
              <p v-if="shot.productPrompt">商品展示 {{ shot.productPrompt }}</p>
            </article>
          </div>
        </template>
      </section>

      <section v-if="stage === 1 && current" aria-label="生成样张">
        <div class="remakeActions">
          <el-select v-model="imageModelKey" placeholder="选择图片模型" aria-label="样张图片模型" :disabled="!!activity || !!current.job">
            <el-option v-for="model in imageModels" :key="getNodeModelKey(model)" :value="getNodeModelKey(model)" :label="model.label" />
          </el-select>
          <el-button type="primary" :disabled="!!activity || !imageModel || !!current.job || !unmade"
            :loading="activity === 'samples'" @click="generateSamples">生成未完成的 {{ unmade }} 组样张</el-button>
          <el-button :disabled="!!activity || !samplesReady" @click="stage = 2">进入成片</el-button>
        </div>
        <p class="remakeNote">一组背景生成一张空底图，同组镜头复用。生成前核对模型和费用。</p>
        <div class="remakeShots">
          <article v-for="group in current.groups" :key="group.id" class="remakeShot">
            <header><strong>背景 {{ group.id }}</strong><span>镜头 {{ groupShotNumbers(group.id) }}</span></header>
            <div class="remakePair">
              <figure><img v-if="originalUrls[group.id]" :src="originalUrls[group.id]" alt="原片代表帧" /><figcaption>原片代表帧</figcaption></figure>
              <figure><img v-if="sampleUrls[group.id]" :src="sampleUrls[group.id]" alt="换景空底图" /><figcaption>新背景样张</figcaption></figure>
              <figure v-if="comparisonUrls[group.id]"><img :src="comparisonUrls[group.id]" alt="AI 模拟合成后的同帧样张" /><figcaption>AI 同帧预览</figcaption></figure>
            </div>
            <label class="remakeField">换景要求
              <textarea :value="group.prompt" rows="3" maxlength="1000" :disabled="!!activity || !!group.task || !!current.job" @change="changePrompt(group.id, $event)" />
            </label>
            <div class="remakeActions">
              <el-button size="small" :disabled="!!activity || !!current.job || group.task?.kind === 'frame' || !group.task && (!imageModel || !group.prompt.trim())" @click="generateSamples(group.id)">
                {{ group.task?.kind === "plate" ? "复查已提交的样张" : group.picture ? "重做本组" : "生成本组" }}
              </el-button>
              <el-button v-if="group.picture" size="small" :disabled="!!activity || !!current.job || group.task?.kind === 'plate' || !group.task && !canCompare" @click="generateFrame(group.id)">
                {{ group.task?.kind === "frame" ? "复查同帧预览" : "生成同帧预览" }}
              </el-button>
            </div>
          </article>
        </div>
      </section>

      <section v-if="stage === 2 && current" aria-label="生成成片">
        <div class="remakeActions">
          <el-select v-model="videoModelKey" placeholder="选择支持视频参考的模型" aria-label="成片视频模型" :disabled="!!activity || !!current.job">
            <el-option v-for="model in videoModels" :key="getNodeModelKey(model)" :value="getNodeModelKey(model)" :label="model.label" />
          </el-select>
          <el-button v-if="current.job?.phase === 'review'" type="primary" :loading="activity === 'video'" :disabled="!!activity || !!current.job.retry" @click="generateMovie('finish')">合成并导出</el-button>
          <el-button v-else type="primary" :loading="activity === 'video'" :disabled="!!activity || current.job?.phase === 'completed' || !current.job && (!videoModel || !samplesReady)" @click="generateMovie()">
            {{ current.job ? "复查成片任务" : current.productSwap ? "生成换品视频" : "生成成片" }}
          </el-button>
        </div>
        <p v-if="current.productSwap" class="remakeNote">已准备 {{ current.analysis.scenes.length }} 个镜头。按原切点合成并保留原音轨。成片请复核商品、手部、字幕及口播里的商品名称。</p>
        <p v-else class="remakeNote">使用已确认背景生成各镜头，再按原切点拼接并保留原音轨。请核对费用和生成后的商品、手部与字幕。</p>
        <p v-if="current.job" class="remakeSummary">已完成 {{ current.job.parts.filter(part => part.state === "succeeded").length }}/{{ current.shots.length }} 段</p>
        <el-button v-if="current.job?.retry && (current.job.phase === 'review' || current.job.phase === 'completed')" :disabled="!!activity" @click="generateMovie()">复查重做任务</el-button>
        <details v-if="current.job?.parts.length" class="remakeParts" open>
          <summary>逐段预览和重做</summary>
          <video v-if="partUrl" :src="partUrl" controls playsinline preload="metadata" aria-label="片段预览" />
          <ol>
            <li v-for="(part, index) in current.job.parts" :key="index" class="remakeActions">
              <span>第 {{ index + 1 }} 段 · {{ partStatus[part.state] }}</span>
              <el-button v-if="part.resultPath && part.state === 'succeeded'" text size="small" @click="previewPart = index">查看片段</el-button>
              <el-button v-if="part.state === 'succeeded' || part.state === 'failed'" text size="small" :disabled="!!activity || !!current.job.retry" @click="generateMovie('retry', index)">重做本段</el-button>
            </li>
          </ol>
        </details>
        <video v-if="resultUrl" :src="resultUrl" controls playsinline preload="metadata" aria-label="翻拍成片" />
      </section>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { ElButton, ElDialog, ElMessageBox, ElOption, ElSelect } from "element-plus";
import { findNodeModel, getNodeModelIdentity, getNodeModelKey, useNode, type NodeAiModel, type NodeMediaModel, type NodeMediaResult, type NodeMediaValue } from "@toonflow/nodes-scaffold/runtime";
import { useNodePersistence } from "@toonflow/nodes-scaffold/nodeDocument";
import { reviewBackgrounds } from "./backgroundReview";
import { restoreBackgroundReview } from "./backgroundAssignments";
import type { AnalysisResult } from "./videoAnalysis";
import { formatSceneTime } from "./resultNodes";
import { runRemakeMovie } from "./remakeMovie";
import { callRemakeApi, rebuildRemakeGroups, remakeAnalysisSchema, remakeImageType, remakeStateSchema, sourceMatchSchema, writeRemakePrompts, type RemakeAnalysis, type RemakeGroup, type RemakeState, type RemakeTranscript } from "./remakeWorkflow";

const props = defineProps<{ source?: NodeMediaValue; savedAnalysis?: AnalysisResult }>();
const visible = defineModel<boolean>({ required: true });
const { id, node, ai, asr, files } = useNode();
const { addNodes, findNode, nodeTypes } = useVueFlow();
const getPersistence = useNodePersistence();
const nodeData = node.data as typeof node.data & { guidedRemake?: unknown };
const initial = remakeStateSchema.safeParse(nodeData.guidedRemake);
const state = ref<RemakeState | undefined>(initial.success ? initial.data : undefined);
const current = computed(() => state.value?.source === props.source?.url ? state.value : undefined);
const savedToReuse = computed(() => {
  const candidate = remakeAnalysisSchema.safeParse(props.savedAnalysis);
  if (!candidate.success || current.value?.analysis.manifest === candidate.data.manifest
    || current.value?.planApproved || current.value?.groups.some(group => group.prompt.trim() || group.picture || group.task)
    || current.value?.shots.some(shot => shot.caption || shot.productPrompt)) return;
  return candidate.data;
});
const stage = ref(current.value?.job || current.value?.productSwap ? 2 : current.value?.planApproved ? 1 : 0);
const productInput = ref<HTMLInputElement>();
const message = ref("");
const failure = ref("");
const activity = ref<"analysis" | "prompts" | "samples" | "video">();
const analysisModels = ref<NodeAiModel[]>([]);
const mediaModels = shallowRef<NodeMediaModel[]>([]);
const analysisModelKey = ref("");
const imageModelKey = ref("");
const videoModelKey = ref("");
const analysisModel = computed(() => findNodeModel(analysisModels.value, analysisModelKey.value));
const imageModels = computed(() => mediaModels.value.filter(model => model.type === "image" && model.mode?.some(mode => mode === "singleImage" || mode === "multiReference")));
const videoModels = computed(() => mediaModels.value.filter(model => model.providerId === "multiTenant" && model.type === "video" && model.mode?.some(mode => Array.isArray(mode)
  && mode.some(value => /^imageReference:[1-9]/.test(value)) && mode.some(value => /^videoReference:[1-9]/.test(value)))));
const imageModel = computed(() => findNodeModel(imageModels.value, imageModelKey.value));
const canCompare = computed(() => imageModel.value?.mode?.includes("multiReference") && (imageModel.value.maxReferenceImages ?? 2) >= 2);
const videoModel = computed(() => findNodeModel(videoModels.value, videoModelKey.value));
const planReady = computed(() => !!current.value?.groups.length && current.value.transcript.kind !== "missing" && current.value.groups.every(group => !!group.prompt.trim())
  && current.value.shots.every(shot => shot.group !== null && !!shot.productPrompt));
const samplesReady = computed(() => !!current.value?.productSwap || planReady.value && current.value?.planApproved && current.value.groups.every(group => !!group.picture && !group.task));
const unmade = computed(() => current.value?.groups.filter(group => !group.picture || group.task?.kind === "plate").length ?? 0);
const locked = computed(() => !!state.value?.job || state.value?.groups.some(group => !!group.task));
const originalUrls = ref<Record<number, string>>({});
const sampleUrls = ref<Record<number, string>>({});
const comparisonUrls = ref<Record<number, string>>({});
const lifetime = new AbortController();
let operation: AbortController | undefined;
let requestId = 0;
const previewPart = ref<number>();
const partStatus = { pending: "待生成", submitting: "提交中", submitted: "生成中", succeeded: "已生成", failed: "生成失败", unknown: "供应商状态待复查", cancelled: "已停止" };

const resultUrl = files.useFileUrl(() => {
  const result = current.value?.job?.result;
  return result ? { url: result, mimeType: "video/mp4" } : undefined;
}, error => { failure.value = showError(error, "无法读取成片"); });

const partUrl = files.useFileUrl(() => {
  const part = previewPart.value === undefined ? undefined : current.value?.job?.parts[previewPart.value];
  return part?.state === "succeeded" && part.resultPath ? { url: part.resultPath, mimeType: "video/mp4" } : undefined;
}, error => { failure.value = showError(error, "无法读取片段"); });

watch(state, value => { nodeData.guidedRemake = value; }, { deep: true, flush: "sync" });
watch(() => visible.value, value => { if (value) void loadModels(); }, { immediate: true });
watch(() => props.source?.url, () => {
  operation?.abort();
  previewPart.value = undefined;
  stage.value = current.value?.job || current.value?.productSwap ? 2 : current.value?.planApproved ? 1 : 0;
  message.value = "";
  failure.value = "";
});
watch(() => [visible.value, stage.value, current.value?.groups.map(group => [group.id, group.picture?.path, group.preview?.path, representative(group.id)])], () => void loadPreviewImages(), { deep: true, immediate: true });
onScopeDispose(() => {
  lifetime.abort();
  requestId += 1;
  releasePictures();
});

function showError(error: unknown, fallback: string) {
  if (error instanceof Error && error.name !== "ZodError" && error.message) return error.message;
  return fallback;
}

function groupShotNumbers(group: number) {
  return current.value?.shots.filter(shot => shot.group === group).map(shot => shot.id).join("、") ?? "";
}

function representative(group: number) {
  const view = current.value;
  const id = view?.shots.find(shot => shot.group === group)?.id;
  return id ? view?.analysis.scenes[id - 1]?.image : undefined;
}

async function loadModels() {
  try {
    const [language, media] = await Promise.all([ai.getModels(lifetime.signal), ai.getMediaModels(lifetime.signal)]);
    analysisModels.value = language;
    mediaModels.value = media;
    if (!analysisModel.value && language[0]) analysisModelKey.value = getNodeModelKey(language[0]);
    if (!imageModel.value && imageModels.value[0]) imageModelKey.value = getNodeModelKey(imageModels.value[0]);
    if (!videoModel.value && videoModels.value[0]) videoModelKey.value = getNodeModelKey(videoModels.value[0]);
  } catch (error) {
    if (!lifetime.signal.aborted) failure.value = showError(error, "模型目录读取失败");
  }
}

function releasePictures() {
  for (const url of [...Object.values(originalUrls.value), ...Object.values(sampleUrls.value), ...Object.values(comparisonUrls.value)]) URL.revokeObjectURL(url);
  originalUrls.value = {};
  sampleUrls.value = {};
  comparisonUrls.value = {};
}

async function loadPreviewImages() {
  const revision = ++requestId;
  releasePictures();
  if (!visible.value || stage.value !== 1 || !current.value) return;
  for (const group of current.value.groups) {
    if (revision !== requestId) return;
    for (const [target, path, mime] of [[originalUrls, representative(group.id), undefined], [sampleUrls, group.picture?.path, group.picture?.mimeType], [comparisonUrls, group.preview?.path, group.preview?.mimeType]] as const) {
      if (!path) continue;
      try {
        const bytes = await files.getWorkspaceFiles().read(path);
        if (revision !== requestId) return;
        target.value[group.id] = URL.createObjectURL(new Blob([bytes], { type: mime ?? remakeImageType(path) }));
      } catch (error) {
        if (revision === requestId) failure.value = showError(error, "样张预览无法读取");
      }
    }
  }
}

async function run(kind: NonNullable<typeof activity.value>, work: (signal: AbortSignal) => Promise<void>) {
  if (activity.value) return;
  const controller = new AbortController();
  operation = controller;
  const signal = AbortSignal.any([controller.signal, lifetime.signal]);
  activity.value = kind;
  failure.value = "";
  message.value = "";
  try { await work(signal); }
  catch (error) { if (!signal.aborted) failure.value = showError(error, "步骤未完成，请核对原任务"); }
  finally {
    if (operation === controller) operation = undefined;
    activity.value = undefined;
  }
}

function persistence(source: string) {
  const context = getPersistence?.();
  if (!context || source !== props.source?.url) throw new Error("原视频或画布已变化，请返回原项目");
  return context;
}

async function save(view: RemakeState, signal?: AbortSignal) {
  const context = persistence(view.source);
  if (view.directory !== context.directory || view.canvasPath !== context.canvasPath || current.value !== view) throw new Error("画布已变化，请回到原项目");
  nodeData.guidedRemake = view;
  await context.save(signal);
}

function draftFromAnalysis(source: string, binding: { directory: string; canvasPath: string }, analysis: RemakeAnalysis) {
  return remakeStateSchema.parse({
    source, directory: binding.directory, canvasPath: binding.canvasPath, analysis,
    transcript: { kind: "missing", reason: "尚未转录原片文案" },
    shots: analysis.scenes.map(scene => ({ id: scene.index, group: null, evidence: "待复核", caption: "", productPrompt: "" })),
    groups: [], product: "", style: "", planApproved: false,
  });
}

function selectProductReference(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  const source = props.source;
  if (!file || !source || current.value || activity.value) return;
  const suffix = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type];
  if (!suffix || !file.size || file.size > 12 * 1024 * 1024) {
    failure.value = "请选择 12 MiB 以内的 PNG、JPG 或 WebP 商品参考图";
    return;
  }
  void run("analysis", async signal => {
    const binding = persistence(source.url);
    message.value = "准备原视频镜头";
    const analysis = await callRemakeApi("analyze", { directory: binding.directory, videoPath: source.url }, remakeAnalysisSchema, signal);
    if (analysis.scenes.length > 24) throw new Error("一键换品最多支持 24 个镜头，请先截取需要换品的片段");
    signal.throwIfAborted();
    persistence(source.url);
    const path = await files.uploadFile(new File([file], `replacement.${suffix}`, { type: file.type }));
    signal.throwIfAborted();
    const view = draftFromAnalysis(source.url, binding, analysis);
    view.productSwap = { reference: { path, mimeType: file.type } };
    const previous = state.value;
    state.value = view;
    try { await save(state.value, signal); }
    catch (error) { state.value = previous; throw error; }
    stage.value = 2;
    message.value = "新商品参考图已保存。请选择模型生成换品视频。";
  });
}

function reuseAnalysis() {
  const source = props.source;
  const analysis = savedToReuse.value;
  const saved = props.savedAnalysis;
  if (!source || !analysis || !saved || locked.value) return;
  void run("analysis", async signal => {
    const binding = persistence(source.url);
    const { matches } = await callRemakeApi("analyze", {
      directory: binding.directory, videoPath: source.url, expectedSourceRevision: analysis.sourceRevision,
    }, sourceMatchSchema, signal);
    if (!matches) throw new Error("原视频已变化，请重新分析原片");
    if (saved !== props.savedAnalysis) throw new Error("拉片结果已变化，请重新确认");
    const view = draftFromAnalysis(source.url, binding, analysis);
    const previous = state.value;
    if (current.value?.analysis.sourceRevision === analysis.sourceRevision) {
      view.transcript = current.value.transcript;
      view.product = current.value.product;
      view.style = current.value.style;
    }
    const assignments = restoreBackgroundReview(saved).backgroundReview?.assignments;
    view.shots = view.shots.map((shot, index) => ({
      ...shot,
      group: assignments ? assignments[index]?.referenceShot ?? null : shot.id,
      evidence: assignments?.[index]?.evidence ?? "已沿用拉片切点",
    }));
    rebuildRemakeGroups(view);
    persistence(source.url);
    state.value = view;
    const imported = current.value!;
    try { await save(imported, signal); }
    catch (error) { if (state.value === imported) state.value = previous; throw error; }
    message.value = assignments ? "已沿用拉片切点与背景分组" : "已沿用拉片切点，请确认背景分组";
  });
}

function analyze() {
  const source = props.source;
  const model = analysisModel.value;
  if (!source || !model || locked.value) return;
  void run("analysis", async signal => {
    const binding = persistence(source.url);
    message.value = "提取镜头切点和代表帧";
    const analysis = await callRemakeApi("analyze", { directory: binding.directory, videoPath: source.url }, remakeAnalysisSchema, signal);
    signal.throwIfAborted();
    const view = draftFromAnalysis(source.url, binding, analysis);
    persistence(source.url);
    state.value = view;
    const saved = current.value!;
    await save(saved, signal);
    const workspace = files.getWorkspaceFiles();
    const reviewed = await reviewBackgrounds({ ai, model, workspace, source: source.url, result: analysis, signal, onProgress: (_percent, label) => { message.value = label; } });
    signal.throwIfAborted();
    saved.shots = saved.shots.map((shot, index) => {
      const assignment = reviewed.backgroundReview?.assignments[index];
      return { ...shot, group: assignment?.referenceShot ?? null, evidence: assignment?.evidence ?? "待复核" };
    });
    rebuildRemakeGroups(saved);
    message.value = "转录原片文案";
    saved.transcript = await readTranscript(analysis.audio ?? source.url, signal);
    signal.throwIfAborted();
    await save(saved, signal);
    await createPrompts(saved, model, signal);
  });
}

async function readTranscript(path: string, signal: AbortSignal): Promise<RemakeTranscript> {
  try {
    const text = (await asr.transcribe(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) })).trim().slice(0, 20000);
    return text ? { kind: "speech", text } : { kind: "missing", reason: "音轨未识别出完整文案" };
  } catch (error) {
    signal.throwIfAborted();
    return { kind: "missing", reason: showError(error, "原音轨未能转录") };
  }
}

async function createPrompts(view: RemakeState, model: NodeAiModel, signal: AbortSignal) {
  const result = await writeRemakePrompts({ state: view, ai, model, signal, progress: label => { message.value = label; } });
  signal.throwIfAborted();
  persistence(view.source);
  Object.assign(view, result, { planApproved: false });
  await save(view, signal);
  message.value = view.shots.some(shot => shot.group === null) ? "请先确定待确认镜头的背景分组，再编写当前方案。" : "方案已保存，可以查看每组背景要求。";
}

function writePrompts() {
  const view = current.value;
  const model = analysisModel.value;
  if (view && model && !locked.value) void run("prompts", signal => createPrompts(view, model, signal));
}

function changeTranscript(event: Event) {
  const view = current.value;
  const input = event.currentTarget;
  if (!view || !(input instanceof HTMLTextAreaElement) || locked.value) return;
  const text = input.value.trim();
  view.transcript = text ? { kind: "edited", text } : { kind: "missing", reason: "原片文案未填写" };
  invalidatePrompts(view);
}

function chooseTranscript(kind: "captions" | "silent") {
  const view = current.value;
  if (!view || locked.value) return;
  view.transcript = { kind };
}

function approvePlan() {
  const view = current.value;
  if (!view || !planReady.value) return;
  void run("prompts", async signal => {
    const approved = view.planApproved;
    view.planApproved = true;
    try { await save(view, signal); }
    catch (error) { view.planApproved = approved; throw error; }
    stage.value = 1;
  });
}

function invalidatePrompts(view: RemakeState) {
  view.planApproved = false;
  view.style = "";
  for (const shot of view.shots) shot.productPrompt = "";
  for (const group of view.groups) {
    group.prompt = "";
    group.picture = undefined;
    group.preview = undefined;
  }
}

function changeGroup(id: number, event: Event) {
  const view = current.value;
  const input = event.currentTarget;
  if (!view || !(input instanceof HTMLSelectElement) || locked.value) return;
  const shot = view.shots.find(item => item.id === id);
  if (!shot) return;
  shot.group = input.value ? Number(input.value) : null;
  shot.evidence = "已调整背景组";
  rebuildRemakeGroups(view);
  invalidatePrompts(view);
}

function mergeShot(shotId: number) {
  const view = current.value;
  if (!view || locked.value || shotId <= 1) return;
  const first = view.analysis.scenes[shotId - 2];
  const second = view.analysis.scenes[shotId - 1];
  if (!first || !second) return;
  if (second.end - first.start > 15 + Number.EPSILON) {
    failure.value = "合并后会超过 15 秒，请保留这个处理分段。";
    return;
  }
  failure.value = "";
  if (second.end - second.start > first.end - first.start) first.image = second.image;
  first.end = second.end;
  view.analysis.scenes.splice(shotId - 1, 1);
  view.shots.splice(shotId - 1, 1);
  view.analysis.scenes.forEach((scene, index) => { scene.index = index + 1; });
  const groups = new Map<number, number>();
  view.shots.forEach((shot, index) => {
    shot.id = index + 1;
    if (shot.group !== null) {
      if (!groups.has(shot.group)) groups.set(shot.group, shot.id);
      shot.group = groups.get(shot.group) ?? null;
    }
  });
  view.groups = [];
  rebuildRemakeGroups(view);
  invalidatePrompts(view);
}

function changePrompt(groupId: number, event: Event) {
  const input = event.currentTarget;
  const group = current.value?.groups.find(item => item.id === groupId);
  if (!group || !(input instanceof HTMLTextAreaElement) || group.task || current.value?.job) return;
  group.prompt = input.value.trim();
  group.picture = undefined;
  group.preview = undefined;
}

async function makeSample(view: RemakeState, group: RemakeGroup, kind: "plate" | "frame", signal: AbortSignal) {
  const original = representative(group.id);
  const model = imageModel.value;
  if (!original) throw new Error("该组缺少代表帧");
  const previous = group.task;
  if (previous && previous.kind !== kind) throw new Error("请先复查原样张任务");
  const task = previous ?? { id: crypto.randomUUID(), prompt: group.prompt, kind };
  const images = [{ path: original, mimeType: remakeImageType(original) }];
  if (kind === "frame") {
    if (!group.picture || !previous && !canCompare.value) throw new Error("同帧预览需要已生成的底图和支持两张参考图的模型");
    images.push(group.picture);
  }
  if (!previous && !model) throw new Error("请选择图片模型");
  if (!previous) {
    group.task = task;
    try { await save(view, signal); }
    catch (error) { group.task = undefined; throw error; }
  }
  let terminal = false;
  const options: Parameters<typeof ai.resumeMedia>[3] = {
    taskId: task.id, nodeId: id, canvasPath: view.canvasPath,
    onStatus: status => { terminal = !!status.result && (status.state === "failed" || status.state === "cancelled"); },
  };
  const handle = async (results: NodeMediaResult[]) => {
    const first = results.find(result => result.mediaType === "image");
    if (!first) throw new Error("样张任务未返回图片");
    signal.throwIfAborted();
    const old = { picture: group.picture, preview: group.preview };
    if (kind === "plate") {
      group.picture = { path: first.path, mimeType: first.mimeType };
      group.preview = undefined;
    } else {
      group.preview = { path: first.path, mimeType: first.mimeType };
    }
    group.task = undefined;
    try { await save(view, signal); }
    catch (error) { Object.assign(group, old, { task }); throw error; }
  };
  try {
    if (previous) await handle(await ai.resumeMedia(view.directory, task.id, signal, options));
    else if (model) {
      const direction = kind === "plate"
        ? "生成参考画面可以替换的空场景背景。同一背景组保持空间、光线和真实质感一致。不生成产品、人物、手或文字。改变有辨识度的场地布置，保留原片冷暖。"
        : "第一张是原画面，第二张是空场景背景。只替换第一张画面的背景，保留镜头构图、人物、手、真实商品和字幕，复用第二张的场景与布光。输出同帧效果供人工验收。";
      await handle(await ai.generateImage({
        ...getNodeModelIdentity(model), directory: view.directory, outputDirectory: "assets/generated",
        prompt: `${direction} 具体背景要求：${task.prompt}`,
        images,
      }, signal, options));
    }
  } catch (error) {
    if (!signal.aborted && (terminal || error instanceof Error && "mediaTaskRejected" in error && error.mediaTaskRejected === true)) {
      group.task = undefined;
      await save(view, signal);
    }
    throw error;
  }
}

function generateSamples(groupId?: number | MouseEvent) {
  const view = current.value;
  if (!view || !view.planApproved || !planReady.value || view.job) return;
  const groups = view.groups.filter(group => group.task?.kind !== "frame"
    && (typeof groupId === "number" ? group.id === groupId : !group.picture || group.task?.kind === "plate"));
  void run("samples", async signal => {
    for (const group of groups) {
      signal.throwIfAborted();
      message.value = `正在处理背景 ${group.id}`;
      await makeSample(view, group, "plate", signal);
    }
    message.value = "样张已保存。请确认商品展示的镜头再生成成片。";
  });
}

function generateFrame(groupId: number) {
  const view = current.value;
  const group = view?.groups.find(item => item.id === groupId);
  if (view?.planApproved && group?.picture && !view.job) void run("samples", async signal => {
    await makeSample(view, group, "frame", signal);
    message.value = "同帧样张已保存。请对照左侧原片核对商品和手部。";
  });
}

function generateMovie(action: "continue" | "finish" | "retry" = "continue", partIndex?: number) {
  const view = current.value;
  const model = videoModel.value;
  if (!view || !view.job && (!samplesReady.value || !model)) return;
  const modelId = model && getNodeModelIdentity(model).modelId;
  void run("video", signal => runRemakeMovie({
    action, partIndex, view, modelId, signal, confirmCharge, save, completeMovie,
    progress: text => { message.value = text; },
  }));
}

async function confirmCharge(message: string, signal: AbortSignal) {
  const accepted = await ElMessageBox.confirm(message, "确认付费生成").then(() => true, () => false);
  signal.throwIfAborted();
  return accepted;
}

async function completeMovie(path: string, view: RemakeState, signal: AbortSignal) {
  const job = view.job;
  if (!job) throw new Error("成片任务已变化");
  persistence(view.source);
  if (!nodeTypes?.value?.["remote-videoNode"]) throw new Error("请启用视频节点插件，再复查成片任务");
  if (!findNode(job.outputId)) addNodes({
    id: job.outputId, type: "remote-videoNode", position: { x: node.computedPosition.x + (node.dimensions.width || 320) + 80, y: node.computedPosition.y },
    data: { label: view.productSwap ? "换品成片" : "翻拍成片", outputs: { video: { dataType: "VIDEO", value: { url: path, mimeType: "video/mp4" } } } },
  });
  const phase = job.phase;
  job.result = path;
  job.phase = "completed";
  try { await save(view, signal); }
  catch (error) { job.phase = phase; job.result = undefined; throw error; }
  message.value = "成片已合成并放到画布。";
}

</script>

<style scoped>
.remakeBody { display: grid; gap: 10px; }
.remakeStages, .remakeActions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.remakeStages button { padding: 8px 10px; border: 1px solid var(--el-border-color); border-radius: 6px; background: var(--el-fill-color-blank); color: var(--el-text-color-primary); cursor: pointer; }
.remakeStages button[aria-current="step"] { color: var(--el-color-primary); border-color: var(--el-color-primary); }
.remakeStages button:disabled { opacity: 0.5; cursor: default; }
.remakeActions .el-select { width: min(230px, 100%); }
.remakeShots { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(230px, 100%), 1fr)); gap: 10px; margin-top: 12px; }
.remakeShot { display: grid; align-content: start; gap: 6px; padding: 10px; border: 1px solid var(--el-border-color); border-radius: 8px; }
.remakeShot header { display: flex; justify-content: space-between; gap: 6px; }
.remakeShot p, .remakeBody p { margin: 0; overflow-wrap: anywhere; }
.remakeSummary { padding: 10px 0; }
.remakeNote { color: var(--el-text-color-secondary); font-size: 13px; }
.remakeFailure { color: var(--el-color-danger); }
.remakeField { display: grid; gap: 4px; padding: 4px 0; }
.remakeField textarea, .remakeShot select { background: var(--el-fill-color-blank); color: var(--el-text-color-primary); border: 1px solid var(--el-border-color); border-radius: 4px; padding: 5px; }
.remakePair { display: grid; grid-template-columns: repeat(auto-fit, minmax(65px, 1fr)); gap: 5px; }
.remakePair figure { margin: 0; min-width: 0; }
.remakePair img { width: 100%; height: 135px; object-fit: contain; border-radius: 4px; }
.remakeBody video { width: min(280px, 100%); display: block; }
.remakeParts li { padding: 2px 0; }
</style>
