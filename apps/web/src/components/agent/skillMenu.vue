<template>
  <div v-click-outside:[editor]="closeMenu" class="skillMenu" @keydown.capture="handleKeydown">
    <el-button class="skillButton" text circle :disabled="disabled" :aria-expanded="visible" :aria-controls="listId" aria-label="选择技能" title="选择技能" @click="visible ? closeMenu() : buttonVisible = true"><icon-book :size="16" /></el-button>
    <el-card v-if="visible" class="skillPopup" shadow="always" :bodyStyle="{ padding: '6px' }">
      <div v-if="workspaceSkillsEnabled" class="skillImport">
        <input ref="skillFile" type="file" accept=".md,text/markdown" hidden @change="importSkill" />
        <el-button text type="primary" @click="editorOpen = true">写项目 Skill</el-button>
        <el-button text :loading="importing" :disabled="importing" @click="skillFile?.click()">上传 SKILL.md</el-button>
        <div v-if="importError" role="alert">{{ importError }}</div>
      </div>
      <el-scrollbar maxHeight="min(320px, 50dvh)">
        <div :id="listId" class="skillList" role="listbox" aria-label="技能指令" :aria-busy="loading">
          <div v-if="loading || loadError || !filteredSkills.length" class="skillStatus" role="status">{{ loading ? "正在加载技能…" : loadError || (skills.length ? "没有匹配的技能" : "暂无可用技能") }}</div>
          <button v-for="(skill, index) in filteredSkills" v-else :id="`${listId}-${index}`" :key="skill.name" class="skillItem" :class="{ active: index === activeIndex }" type="button" role="option" :aria-selected="index === activeIndex" @mouseenter="activeIndex = index" @mousedown.prevent @click="selectSkill(skill.name)">
            <icon-book class="skillIcon" :size="18" aria-hidden="true" />
            <span class="skillContent">
              <span class="skillHeader">
                <span class="skillName">{{ skill.displayName }}</span>
                <code class="skillIdentifier">/skill:{{ skill.name }}</code>
              </span>
              <span class="skillDescription" :title="skill.description">{{ skill.description }}</span>
            </span>
          </button>
        </div>
      </el-scrollbar>
    </el-card>
    <el-dialog v-model="editorOpen" title="写项目 Skill" width="min(640px, calc(100vw - 32px))" appendToBody>
      <el-form labelPosition="top" @submit.prevent="saveDraft">
        <el-form-item label="Skill 名称">
          <el-input v-model="draftName" maxlength="64" aria-label="Skill 名称" />
        </el-form-item>
        <el-form-item label="用途">
          <el-input v-model="draftDescription" aria-label="Skill 用途" />
        </el-form-item>
        <el-form-item label="指令">
          <el-input v-model="draftInstructions" type="textarea" :rows="9" aria-label="Skill 指令" />
        </el-form-item>
        <div v-if="editorError" role="alert">{{ editorError }}</div>
      </el-form>
      <template #footer>
        <el-button :disabled="saving" @click="editorOpen = false">取消</el-button>
        <el-button type="primary" :loading="saving" :disabled="!draftName.trim() || !draftDescription.trim() || !draftInstructions.trim()" @click="saveDraft">保存项目 Skill</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from "vue";
import axios from "axios";
import { IconBook } from "@tabler/icons-vue";
import { ClickOutside as vClickOutside } from "element-plus";
import { workspaceSkillsEnabled } from "@/stores/multiTenant";

const props = defineProps<{ directory?: string; active: boolean; disabled: boolean; query?: string; editor?: HTMLElement }>();
const emit = defineEmits<{ select: [name: string]; dismiss: [] }>();
const listId = useId();
const buttonVisible = ref(false);
const visible = computed(() => props.active && !props.disabled && (buttonVisible.value || props.query !== undefined));
const skills = ref<{ name: string; displayName: string; description: string }[]>([]);
const loading = ref(false);
const loadError = ref("");
const activeIndex = ref(0);
const skillFile = ref<HTMLInputElement>();
const importing = ref(false);
const importError = ref("");
const skillRevision = ref(0);
const editorOpen = ref(false);
const draftName = ref("");
const draftDescription = ref("");
const draftInstructions = ref("");
const editorError = ref("");
const saving = ref(false);

async function saveSkill(directory: string, content: string) {
  await axios.post("/api/agent/skills/import", { directory, content }, { headers: { "x-toonflow-workspace": "1" } });
  if (props.directory === directory) skillRevision.value++;
}

function skillError(error: unknown) {
  return axios.isAxiosError<{ message?: string }>(error) ? error.response?.data.message || "项目 Skill 添加失败" : "项目 Skill 添加失败";
}

async function saveDraft() {
  const directory = props.directory;
  const name = draftName.value.trim();
  const description = draftDescription.value.trim();
  const instructions = draftInstructions.value.trim();
  if (!directory || !name || !description || !instructions || saving.value || props.disabled) return;
  saving.value = true;
  editorError.value = "";
  try {
    await saveSkill(directory, `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}`);
    editorOpen.value = false;
    draftName.value = draftDescription.value = draftInstructions.value = "";
    if (props.directory === directory) buttonVisible.value = true;
  } catch (error) {
    editorError.value = skillError(error);
  } finally { saving.value = false; }
}

watch(() => props.directory, () => {
  editorOpen.value = false;
  draftName.value = draftDescription.value = draftInstructions.value = editorError.value = importError.value = "";
});

async function importSkill(event: Event) {
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) return;
  const file = input.files?.[0];
  input.value = "";
  const directory = props.directory;
  if (!file || !directory || importing.value || props.disabled) return;
  importError.value = "";
  if (file.size > 128 * 1024) {
    importError.value = "SKILL.md 最大为 128 KB";
    return;
  }
  importing.value = true;
  try {
    await saveSkill(directory, await file.text());
  } catch (error) {
    if (props.directory === directory) importError.value = skillError(error);
  } finally { importing.value = false; }
}
const filteredSkills = computed(() => {
  const query = (props.query ?? "").toLowerCase();
  return skills.value.filter(skill => `skill:${skill.name} ${skill.displayName} ${skill.description}`.toLowerCase().includes(query));
});

function closeMenu() {
  buttonVisible.value = false;
  emit("dismiss");
}

function selectSkill(name: string) {
  emit("select", name);
  closeMenu();
}

function handleKeydown(event: KeyboardEvent) {
  if (!visible.value || event.isComposing || event.keyCode === 229) return;
  if (event.key === "Tab" && (event.shiftKey || loading.value || loadError.value || !filteredSkills.value.length)) return closeMenu();
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  if (!["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") return closeMenu();
  if (loading.value || loadError.value || !filteredSkills.value.length) return;
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    activeIndex.value = (activeIndex.value + (event.key === "ArrowDown" ? 1 : -1) + filteredSkills.value.length) % filteredSkills.value.length;
  } else selectSkill(filteredSkills.value[activeIndex.value]!.name);
}

watch(filteredSkills, () => { activeIndex.value = 0; });
watch([visible, activeIndex, filteredSkills, loading, loadError], async () => {
  await nextTick();
  const editor = props.editor?.querySelector('[role="textbox"]');
  editor?.setAttribute("aria-haspopup", "listbox");
  editor?.setAttribute("aria-expanded", String(visible.value));
  editor?.setAttribute("aria-controls", listId);
  if (visible.value && !loading.value && !loadError.value && filteredSkills.value.length) {
    const id = `${listId}-${activeIndex.value}`;
    editor?.setAttribute("aria-activedescendant", id);
    document.getElementById(id)?.scrollIntoView({ block: "nearest" });
  } else editor?.removeAttribute("aria-activedescendant");
});

watch([visible, () => props.directory, skillRevision], async ([open, directory], _previous, onCleanup) => {
  if (!open) return closeMenu();
  const controller = new AbortController();
  onCleanup(() => controller.abort());
  loading.value = true;
  loadError.value = "";
  try {
    const { data } = await axios.get("/api/agent/skills", {
      params: { directory }, signal: controller.signal,
      headers: { "x-toonflow-workspace": "1" },
    });
    if (data.code !== 200) throw new Error(data.message || "加载技能失败");
    skills.value = data.data;
  } catch (error) {
    if (!axios.isCancel(error)) loadError.value = "加载技能失败，请重新打开重试";
  } finally {
    if (!controller.signal.aborted) loading.value = false;
  }
});

defineExpose({ handleKeydown });
</script>

<style lang="scss" scoped>
.skillMenu {
  flex-shrink: 0;

  .skillButton {
    width: 24px;
    height: 24px;
    padding: 0;
  }

  .skillPopup {
    position: absolute;
    z-index: 20;
    right: 0;
    bottom: calc(100% + 8px);
    left: 0;

    .skillList {
      display: grid;
      gap: 4px;

      .skillStatus {
        padding: 20px 12px;
        color: var(--el-text-color-secondary);
        font-size: 12px;
        line-height: 1.6;
        text-align: center;
      }

      .skillItem {
        display: grid;
        grid-template-columns: 18px minmax(0, 1fr);
        align-items: start;
        gap: 10px;
        width: 100%;
        padding: 12px;
        border: none;
        border-radius: var(--el-border-radius-base);
        background: transparent;
        color: var(--el-text-color-primary);
        font: inherit;
        text-align: left;
        overflow-wrap: anywhere;
        cursor: pointer;

        &:hover {
          background: var(--el-fill-color-light);
        }

        &.active {
          background: var(--el-color-primary-light-9);

          .skillIcon { color: var(--el-color-primary); }
        }

        &:focus-visible {
          outline: 2px solid var(--el-color-primary);
          outline-offset: -2px;
        }

        .skillIcon {
          margin-top: 2px;
          color: var(--el-text-color-secondary);
        }

        .skillContent {
          display: flex;
          flex-direction: column;
          gap: 6px;
          min-width: 0;

          .skillHeader {
            display: flex;
            flex-wrap: wrap;
            align-items: baseline;
            gap: 4px 12px;
            line-height: 1.5;

            .skillName {
              min-width: 0;
              font-size: 13px;
              font-weight: 600;
            }

            .skillIdentifier {
              min-width: 0;
              margin-left: auto;
              color: var(--el-text-color-secondary);
              font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
              font-size: 11px;
            }
          }

          .skillDescription {
            display: -webkit-box;
            overflow: hidden;
            color: var(--el-text-color-secondary);
            font-size: 12px;
            line-height: 1.6;
            -webkit-box-orient: vertical;
            -webkit-line-clamp: 2;
          }
        }
      }
    }
  }
}
</style>
