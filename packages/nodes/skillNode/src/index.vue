<template>
  <nodeSkeleton v-bind="nodeProps">
    <div class="skillContent nodrag nopan nowheel">
      <label :for="id + '-instructions'">Skill 指令</label>
      <el-input
        :id="id + '-instructions'"
        v-model="instructions"
        type="textarea"
        :rows="3"
        :disabled="running"
        :maxlength="16000" />

      <label :for="id + '-input'">文本输入</label>
      <el-input
        :id="id + '-input'"
        v-model="input"
        type="textarea"
        :rows="2"
        :disabled="running" />
      <small v-if="connected.length">已连接上游文本，运行时会一起传入。</small>

      <label :for="id + '-model'">模型</label>
      <el-select
        :id="id + '-model'"
        v-model="model"
        filterable
        :loading="loading"
        :disabled="running"
        placeholder="选择模型"
        noDataText="当前账号没有可用的文字模型"
        @visible-change="visible => visible && loadModels()">
        <el-option
          v-for="choice in models"
          :key="getNodeModelKey(choice)"
          :value="getNodeModelKey(choice)"
          :label="choice.label" />
      </el-select>
      <p v-if="modelError" class="errorMessage" role="alert">{{ modelError }}</p>
      <small v-else-if="!loading && !model && models.length">当前账号没有可设为默认的 GPT 模型，请手动选择。</small>
      <small v-else-if="!loading && !model && !models.length">当前账号没有可用的文字模型。</small>
      <small v-else-if="!loading && model && !selectedModel">已保存的模型不可用，请重新选择。</small>

      <el-button type="primary" :loading="running" :disabled="!canRun" @click="run">运行 Skill</el-button>
      <p v-if="errorMessage" class="errorMessage" role="alert">{{ errorMessage }}</p>
      <template v-if="outputs.text.value">
        <span>文本输出</span>
        <pre class="skillOutput">{{ outputs.text.value }}</pre>
      </template>
    </div>
  </nodeSkeleton>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ElButton, ElInput, ElOption, ElSelect } from "element-plus";
import { IconSparkles } from "@tabler/icons-vue";
import { getNodeModelIdentity, getNodeModelKey, nodeSkeleton, useNode, useNodeInputs, useNodeModelSelection, type NodeAiModel, type NodeHandle } from "@toonflow/nodes-scaffold/runtime";

defineOptions({
  inheritAttrs: false,
  icon: IconSparkles,
  handles: [
    { id: "in", type: "target", dataType: "STRING", label: "文本输入" },
    { id: "text", type: "source", dataType: "STRING", label: "文本输出" },
  ] satisfies NodeHandle[],
});

const preferredModels = ["gpt-6.2-sol", "gpt-6.1-sol", "gpt-6.1-terra"];
const { id, node, nodeProps, outputs, ai } = useNode({
  label: "Skill",
  outputs: { text: { dataType: "STRING", value: "" } },
  onModelsChanged: () => loadModels(),
});
type SkillSettings = { instructions?: unknown; input?: unknown; model?: unknown };
const data = computed<SkillSettings & typeof node.data>(() => node.data);
const instructions = computed({
  get: () => typeof data.value.instructions === "string" ? data.value.instructions : "",
  set: value => { data.value.instructions = value; },
});
const input = computed({
  get: () => typeof data.value.input === "string" ? data.value.input : "",
  set: value => { data.value.input = value; },
});
const model = computed({
  get: () => typeof data.value.model === "string" ? data.value.model : "",
  set: value => { data.value.model = value; },
});
const models = ref<NodeAiModel[]>([]);
const loading = ref(false);
const running = ref(false);
const modelError = ref("");
const errorMessage = ref("");
const selectedModel = useNodeModelSelection(models, model);
const { getTargetValues } = useNodeInputs();
const connected = computed(() => getTargetValues(id, "in"));
const prompt = computed(() => [...connected.value.map(value => value.dataType === "STRING" ? value.value : undefined), input.value]
  .map(value => value?.trim()).filter(Boolean).join("\n\n"));
const canRun = computed(() => !!selectedModel.value && !!instructions.value.trim() && !!prompt.value && !running.value);

async function loadModels() {
  if (loading.value) return;
  loading.value = true;
  modelError.value = "";
  try {
    models.value = await ai.getModels();
    if (!model.value) {
      for (const preferred of preferredModels) {
        const available = models.value.find(choice => choice.modelId === preferred);
        if (!available) continue;
        model.value = getNodeModelKey(available);
        break;
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") modelError.value = "模型列表读取失败，请重新打开下拉列表重试。";
  } finally {
    loading.value = false;
  }
}

async function run() {
  const choice = selectedModel.value;
  if (!choice || !canRun.value) return;
  running.value = true;
  errorMessage.value = "";
  try {
    const result = await ai.generate({
      ...getNodeModelIdentity(choice),
      systemPrompt: instructions.value.trim(),
      prompt: prompt.value,
    });
    outputs.value.text.value = result.text;
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") {
      errorMessage.value = error instanceof Error ? error.message : "Skill 运行失败。";
    }
  } finally {
    running.value = false;
  }
}

onMounted(loadModels);
</script>

<style lang="scss" scoped>
.skillContent {
  width: 320px;
  display: grid;
  gap: 8px;
  padding: 14px;
  font-size: 13px;

  label {
    font-weight: 600;
  }

  small {
    color: var(--el-text-color-secondary);
  }

  .errorMessage {
    margin: 0;
    color: var(--el-color-danger);
  }

  .skillOutput {
    max-height: 220px;
    margin: 0;
    overflow: auto;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font: inherit;
  }
}
</style>
