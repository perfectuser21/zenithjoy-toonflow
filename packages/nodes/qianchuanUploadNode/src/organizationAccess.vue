<template>
  <button type="button" @click="open">组织与授权管理</button>
  <Teleport to="body">
    <dialog ref="dialog" class="organizationDialog" :aria-labelledby="dialogTitleId" @close="clearSecrets">
      <header>
        <h2 :id="dialogTitleId">组织与千川授权</h2>
        <button type="button" @click="dialog?.close()">关闭</button>
      </header>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <fieldset :disabled="busy">
        <div class="organizationForms">
          <form @submit.prevent="createOrganization">
            <label>新组织名称<input v-model.trim="organizationName" required maxlength="80" /></label>
            <button type="submit">创建组织</button>
          </form>
          <form @submit.prevent="joinOrganization">
            <label>团队邀请码<input v-model.trim="invitationInput" required maxlength="128" autocomplete="off" /></label>
            <button type="submit">加入团队</button>
          </form>
        </div>
        <label v-if="organizations.length">管理组织
          <select v-model="managedOrganizationId">
            <option v-for="item in organizations" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
        </label>
        <section v-if="organization" class="organizationDetails" :key="organization.id">
          <p>组织编码 <code>{{ organization.code }}</code> · {{ organization.role === 'owner' ? '组织管理员' : '成员' }}</p>
          <template v-if="organization.role === 'owner'">
            <details open>
              <summary>团队与成员</summary>
              <div class="organizationForms">
                <form @submit.prevent="createTeam">
                  <label>团队名称<input v-model.trim="teamName" required maxlength="80" /></label>
                  <button type="submit">添加团队</button>
                </form>
                <form v-if="organization.teams.length" @submit.prevent="createInvitation">
                  <label>邀请加入团队
                    <select v-model="invitationTeamId" required>
                      <option value="" disabled>请选择团队</option>
                      <option v-for="team in organization.teams" :key="team.id" :value="team.id">{{ team.name }}</option>
                    </select>
                  </label>
                  <button type="submit">生成邀请码</button>
                </form>
              </div>
              <label v-if="issuedCode">邀请码，有效期 24 小时且仅可使用一次
                <input :value="issuedCode" readonly @focus="selectCode" />
              </label>
              <ul v-if="organization.members?.length" class="records">
                <li v-for="member in organization.members" :key="`${member.userId}:${member.teamId}`">
                  <span>{{ member.userName || member.userId }} · {{ teamLabel(member.teamId) }}</span>
                  <button type="button" @click="manage('revokeMembership', { memberId: member.userId, teamId: member.teamId }, '已移除团队成员')">移出团队</button>
                </li>
              </ul>
            </details>
            <details>
              <summary>千川授权</summary>
              <ul v-if="organization.authorizations?.length" class="records">
                <li v-for="authorization in organization.authorizations" :key="authorization.id">
                  <span>{{ authorization.name }}</span>
                  <div class="formActions">
                    <button type="button" @click="selectRotation(authorization.id)">更换 Token</button>
                    <button type="button" @click="confirmRevocation(authorization.id)">撤销授权</button>
                  </div>
                  <form v-if="rotationId === authorization.id" @submit.prevent="rotateAuthorization(authorization.id)">
                    <label>新 Access Token<input v-model.trim="rotationToken" type="password" maxlength="2048" autocomplete="new-password" required /></label>
                    <button type="submit">保存新 Token</button>
                  </form>
                </li>
              </ul>
              <form class="authorizationForm" @submit.prevent="addAuthorization">
                <div class="organizationForms">
                  <label>授权名称<input v-model.trim="authorizationName" required maxlength="80" /></label>
                  <label>Access Token<input v-model.trim="accessToken" type="password" required maxlength="2048" autocomplete="new-password" /></label>
                </div>
                <div v-for="(account, index) in accountDrafts" :key="account.key" class="accountFields">
                  <label>账户名称<input v-model.trim="account.name" required maxlength="80" /></label>
                  <label>广告主 ID<input v-model.trim="account.advertiserId" inputmode="numeric" maxlength="20" pattern="[0-9]{1,20}" required /></label>
                  <label>共享范围
                    <select v-model="account.teamId">
                      <option value="">全组织</option>
                      <option v-for="team in organization.teams" :key="team.id" :value="team.id">{{ team.name }}</option>
                    </select>
                  </label>
                  <button v-if="accountDrafts.length > 1" type="button" @click="accountDrafts.splice(index, 1)">移除账户</button>
                </div>
                <div class="formActions">
                  <button type="button" @click="addAccountDraft">再添加一个广告主</button>
                  <button type="submit" class="primary">保存授权</button>
                </div>
              </form>
            </details>
          </template>
          <h3>可用千川账户</h3>
          <ul v-if="organization.accounts.length" class="records">
            <li v-for="account in organization.accounts" :key="account.id">
              <span>{{ account.name }} · {{ account.advertiserId }}</span><span>{{ teamLabel(account.teamId) }}</span>
            </li>
          </ul>
          <p v-else>当前没有可用千川账户。</p>
        </section>
      </fieldset>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onScopeDispose, ref, useId, watch } from "vue";
import { z } from "zod";
import { requestQianchuan, type Organization } from "./qianchuanApi";

const props = defineProps<{ organizations: Organization[]; activeOrganizationId: string; refresh: () => Promise<void> }>();
const dialog = ref<HTMLDialogElement>();
const dialogTitleId = useId();
const managedOrganizationId = ref("");
const organization = computed(() => props.organizations.find(item => item.id === managedOrganizationId.value) ?? props.organizations[0]);
const organizationName = ref("");
const invitationInput = ref("");
const teamName = ref("");
const invitationTeamId = ref("");
const issuedCode = ref("");
const authorizationName = ref("");
const accessToken = ref("");
const rotationId = ref("");
const rotationToken = ref("");
const accountDrafts = ref([{ key: 0, name: "", advertiserId: "", teamId: "" }]);
let nextAccountKey = 1;
const busy = ref(false);
const error = ref("");
const notice = ref("");
const lifetime = new AbortController();

function open() {
  managedOrganizationId.value = props.activeOrganizationId || props.organizations[0]?.id || "";
  dialog.value?.showModal();
  void run(async () => {
    await props.refresh();
    if (!managedOrganizationId.value) managedOrganizationId.value = props.organizations[0]?.id ?? "";
  });
}

function clearSecrets() {
  accessToken.value = "";
  rotationId.value = "";
  rotationToken.value = "";
  invitationInput.value = "";
  issuedCode.value = "";
}

function selectCode(event: FocusEvent) {
  if (event.currentTarget instanceof HTMLInputElement) event.currentTarget.select();
}

function teamLabel(teamId: string | null) {
  return teamId === null ? "全组织" : organization.value?.teams.find(team => team.id === teamId)?.name ?? "团队";
}

function addAccountDraft() {
  accountDrafts.value.push({ key: nextAccountKey++, name: "", advertiserId: "", teamId: "" });
}

async function run(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await work();
  } catch (reason) {
    if (!lifetime.signal.aborted) error.value = reason instanceof Error ? reason.message : "操作失败";
  } finally {
    busy.value = false;
  }
}

async function manage(action: string, fields: object, success: string, after?: () => void) {
  const target = action === "createOrganization" || action === "joinOrganization" ? {} : { organizationId: organization.value?.id };
  await run(async () => {
    await requestQianchuan("organizations", { action, ...target, ...fields }, lifetime.signal);
    after?.();
    await props.refresh();
    notice.value = success;
  });
}

function createOrganization() {
  return manage("createOrganization", { name: organizationName.value }, "已创建组织", () => { organizationName.value = ""; });
}

function joinOrganization() {
  return manage("joinOrganization", { code: invitationInput.value }, "已加入团队", () => { invitationInput.value = ""; });
}

function createTeam() {
  return manage("createTeam", { name: teamName.value }, "已添加团队", () => { teamName.value = ""; });
}

function createInvitation() {
  return run(async () => {
    const data = await requestQianchuan("organizations", {
      action: "createInvitation", organizationId: organization.value?.id, teamId: invitationTeamId.value,
    }, lifetime.signal);
    issuedCode.value = dialog.value?.open ? z.object({ code: z.string() }).parse(data).code : "";
    notice.value = "已生成邀请码";
  });
}

function addAuthorization() {
  const accounts = accountDrafts.value.map(({ name, advertiserId, teamId }) => ({ name, advertiserId, teamId: teamId || null }));
  return manage("addAuthorization", { name: authorizationName.value, accessToken: accessToken.value, accounts }, "已保存千川授权", () => {
    accessToken.value = "";
    authorizationName.value = "";
    accountDrafts.value = [];
    addAccountDraft();
  });
}

function selectRotation(authorizationId: string) {
  rotationId.value = rotationId.value === authorizationId ? "" : authorizationId;
  rotationToken.value = "";
}

function rotateAuthorization(authorizationId: string) {
  return manage("replaceAuthorization", { authorizationId, accessToken: rotationToken.value }, "已更换 Token", () => {
    rotationId.value = "";
    rotationToken.value = "";
  });
}

function confirmRevocation(authorizationId: string) {
  if (window.confirm("撤销后，团队将无法继续通过此授权上传。确定撤销？")) {
    return manage("revokeAuthorization", { authorizationId }, "已撤销授权");
  }
}

watch(() => organization.value?.id, () => {
  invitationTeamId.value = organization.value?.teams[0]?.id ?? "";
  authorizationName.value = "";
  teamName.value = "";
  accountDrafts.value = [];
  addAccountDraft();
  clearSecrets();
});
onScopeDispose(() => lifetime.abort());
</script>

<style scoped lang="scss">
.organizationDialog {
  width: min(680px, calc(100vw - 28px)); max-height: calc(100dvh - 36px); padding: 18px;
  color: var(--el-text-color-primary); background: var(--el-bg-color); border: 1px solid var(--el-border-color); border-radius: 10px;
  &::backdrop { background: rgb(0 0 0 / 55%); }
  header, .records > li { display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  h2, h3, p { margin: 0; }
  h2 { font-size: 19px; }
  h3 { font-size: 14px; }
  > p { margin-block: 8px; }
  fieldset, .organizationDetails, form, label { display: grid; gap: 8px; min-width: 0; }
  fieldset { padding: 0; margin: 10px 0 0; border: 0; }
  button, input, select {
    min-width: 0; color: inherit; font: inherit; border: 1px solid var(--el-border-color); border-radius: 5px;
    background: var(--el-fill-color-blank); padding: 5px 8px;
  }
  button, summary { cursor: pointer; }
  button:disabled { opacity: .55; }
  .primary { background: var(--el-color-primary); color: white; }
  .error { color: var(--el-color-danger); overflow-wrap: anywhere; }
  .organizationForms, .accountFields { display: grid; gap: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .accountFields { padding-block: 6px; align-items: end; }
  .formActions { display: flex; gap: 8px; flex-wrap: wrap; }
  .records {
    display: grid; gap: 7px; list-style: none; margin: 7px 0; padding: 0;
    > li { overflow-wrap: anywhere; }
    button { flex-shrink: 0; }
  }
  details { padding: 8px; border: 1px solid var(--el-border-color); border-radius: 6px; }
  details[open] > summary { margin-bottom: 8px; }
  @media (max-width: 480px) {
    .organizationForms, .accountFields { grid-template-columns: minmax(0, 1fr); }
  }
}
</style>
