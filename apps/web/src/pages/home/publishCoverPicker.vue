<template>
  <div class="coverPicker">
    <label for="coverProject">项目</label>
    <el-select id="coverProject" v-model="directory" placeholder="选择项目" :disabled="projects.length === 0">
      <el-option v-for="project in projects" :key="project.directory" :label="project.name" :value="project.directory" />
    </el-select>
    <p v-if="!directory" role="status">打开项目后，可以在这里选择项目里的图片。</p>
    <template v-else>
      <div class="folderHeader">
        <el-button :disabled="!folder" @click="openFolder(folder.split('/').slice(0, -1).join('/'))">上一级</el-button>
        <span>{{ folder || '项目目录' }}</span>
      </div>
      <p v-if="loading" role="status">正在加载项目文件…</p>
      <p v-else-if="!entries.length && !error" role="status">此目录没有可用的封面图片或子目录。</p>
      <ul v-if="entries.length" class="entries">
        <li v-for="entry in entries" :key="entry.path">
          <el-button v-if="entry.type === 'directory'" text :icon="IconFolder" @click="openFolder(entry.path)">{{ entry.name }}</el-button>
          <el-button v-else text :icon="IconPhoto" :loading="reading === entry.path" @click="selectImage(entry)">{{ entry.name }}</el-button>
        </li>
      </ul>
      <p v-if="error" role="alert">{{ error }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { IconFolder, IconPhoto } from "@tabler/icons-vue";
import { getMediaMimeType } from "@toonflow/node-shared/mediaTypes";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import useWorkspaceFiles from "@/lib/workspaceFiles";
import { useWorkspaceStore } from "@/stores/workspace";

type WorkspaceEntry = Awaited<ReturnType<ReturnType<typeof useWorkspaceFiles>["list"]>>["entries"][number];

const emit = defineEmits<{ select: [file: File] }>();
const workspace = useWorkspaceStore();
const projects = computed(() => [...workspace.projectList].sort((left, right) => right.lastOpenedAt - left.lastOpenedAt));
const directory = ref(projects.value[0]?.directory);
const folder = ref("");
const entries = ref<WorkspaceEntry[]>([]);
const loading = ref(false);
const reading = ref("");
const error = ref("");
const coverMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);
let pending: AbortController | undefined;

function startRequest() {
  pending?.abort();
  pending = new AbortController();
  reading.value = "";
  error.value = "";
  return pending.signal;
}

async function openFolder(path: string) {
  const signal = startRequest();
  folder.value = path;
  entries.value = [];
  const projectRoot = directory.value;
  if (!projectRoot) return;
  loading.value = true;
  try {
    const result = await useWorkspaceFiles(projectRoot).list(path, signal);
    if (signal.aborted) return;
    entries.value = result.entries.filter(entry => entry.type === "directory" || coverMimeTypes.has(getMediaMimeType({ name: entry.name, type: "" })));
  } catch {
    if (!signal.aborted) error.value = "无法读取项目文件。返回上一级或重新选择项目后重试。";
  } finally {
    if (!signal.aborted) loading.value = false;
  }
}

async function selectImage(entry: WorkspaceEntry) {
  const projectRoot = directory.value;
  if (!projectRoot) return;
  const signal = startRequest();
  reading.value = entry.path;
  try {
    const bytes = await useWorkspaceFiles(projectRoot).read(entry.path, signal);
    if (signal.aborted) return;
    const type = getMediaMimeType({ name: entry.name, type: "" });
    if (!bytes.byteLength) throw new Error("封面文件内容为空");
    emit("select", new File([bytes], entry.name, { type }));
  } catch {
    if (!signal.aborted) error.value = "无法读取这张图片，请重新选择。";
  } finally {
    if (!signal.aborted) reading.value = "";
  }
}

watch(directory, () => { void openFolder(""); }, { immediate: true, flush: "sync" });
onBeforeUnmount(() => pending?.abort());
</script>

<style scoped lang="scss">
.coverPicker {
  display: grid;
  gap: 12px;

  .folderHeader {
    display: flex;
    align-items: center;
    gap: 12px;
    overflow-wrap: anywhere;
  }

  .entries {
    list-style: none;
    padding: 0;
    margin: 0;

    li { min-width: 0; }
  }

  p { margin: 0; }
}
</style>
