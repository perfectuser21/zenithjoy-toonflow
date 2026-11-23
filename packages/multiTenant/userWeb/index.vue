<template>
  <div class="userWeb" :style="{ '--el-color-primary': brand.primaryColor }">
    <div class="authContent">
      <header class="authHeader">
        <img class="wordmark" :src="brand.wordmarkUrl" :alt="brand.name" width="2527" height="657" />
      </header>
      <main class="authMain">
        <section class="authPanel" aria-labelledby="authTitle">
          <header class="panelHeader">
            <h1 id="authTitle">{{ mode === "login" ? translate("登录") : translate("注册") }}</h1>
          </header>
          <el-form class="authForm" labelPosition="top" hideRequiredAsterisk :disabled="busy" :aria-busy="busy" @submit.prevent="submit">
            <el-form-item :label="translate('账号')" for="userAccount" :error="userNameError" required>
              <el-input id="userAccount" ref="userNameInput" v-model="userName" name="username" autocomplete="username" aria-required="true" :maxlength="64" />
            </el-form-item>
            <el-form-item :label="translate('密码')" for="userPassword" :error="passwordError" required>
              <el-input id="userPassword" ref="passwordInput" v-model="password" name="password" type="password" showPassword aria-required="true" :autocomplete="mode === 'register' ? 'new-password' : 'current-password'" :minlength="8" :maxlength="128" />
            </el-form-item>
            <el-form-item v-if="mode === 'register'" :label="translate('确认密码')" for="userPasswordConfirm" :error="confirmationError" required>
              <el-input id="userPasswordConfirm" ref="confirmationInput" v-model="passwordConfirm" type="password" showPassword autocomplete="new-password" aria-required="true" :minlength="8" :maxlength="128" />
            </el-form-item>
            <el-alert v-if="requestError" class="requestError" :title="requestError" type="error" :closable="false" showIcon />
            <el-button class="submitButton" type="primary" nativeType="submit" :loading="busy" :disabled="busy">{{ mode === "login" ? translate("登录") : translate("注册") }}</el-button>
          </el-form>
          <footer v-if="registrationEnabled" class="accountSwitch">
            <el-button class="modeButton" link type="primary" :disabled="busy" @click="switchMode">{{ mode === "login" ? translate("注册账号") : translate("返回登录") }}</el-button>
          </footer>
        </section>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { translate } from "@toonflow/i18n/vue";
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ElAlert, ElButton, ElForm, ElFormItem, ElInput, type InputInstance } from "element-plus";
import type { UserIdentity, UserRequest } from "./types";
import "element-plus/es/components/alert/style/css";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/form/style/css";
import "element-plus/es/components/form-item/style/css";
import "element-plus/es/components/input/style/css";

const props = defineProps<{ request: UserRequest; brand: { name: string; wordmarkUrl: string; primaryColor: string }; registrationEnabled: boolean }>();
const emit = defineEmits<{ authenticated: [user: UserIdentity] }>();
const mode = ref<"login" | "register">("login");
const userName = ref("");
const password = ref("");
const passwordConfirm = ref("");
const busy = ref(false);
const userNameError = ref("");
const passwordError = ref("");
const confirmationError = ref("");
const requestError = ref("");
const userNameInput = ref<InputInstance>();
const passwordInput = ref<InputInstance>();
const confirmationInput = ref<InputInstance>();
const controller = new AbortController();

watch([userName, password, passwordConfirm], () => {
  userNameError.value = "";
  passwordError.value = "";
  confirmationError.value = "";
  requestError.value = "";
});

async function switchMode() {
  if (busy.value || !props.registrationEnabled) return;
  mode.value = mode.value === "login" ? "register" : "login";
  password.value = "";
  passwordConfirm.value = "";
  userNameError.value = "";
  passwordError.value = "";
  confirmationError.value = "";
  requestError.value = "";
  await nextTick();
  userNameInput.value?.focus();
}

async function submit() {
  if (busy.value) return;
  if (mode.value === "register" && !props.registrationEnabled) return;
  const name = userName.value.trim();
  if (!name || name.length > 64) {
    userNameError.value = translate("账号长度应为 1 到 64 个字符");
    userNameInput.value?.focus();
    return;
  }
  if (/[\s\u0000-\u001f\u007f]/.test(name)) {
    userNameError.value = translate("账号不能包含空白或控制字符");
    userNameInput.value?.focus();
    return;
  }
  if (password.value.length < 8 || password.value.length > 128) {
    passwordError.value = translate("密码长度应为 8 到 128 个字符");
    passwordInput.value?.focus();
    return;
  }
  if (mode.value === "register" && password.value !== passwordConfirm.value) {
    confirmationError.value = translate("两次输入的密码不一致");
    confirmationInput.value?.focus();
    return;
  }
  busy.value = true;
  requestError.value = "";
  try {
    const result = await props.request<{ user: UserIdentity }>({
      method: "POST", url: `/api/multiTenant/user/${mode.value}`, data: { userName: name, password: password.value }, signal: controller.signal,
    });
    password.value = "";
    passwordConfirm.value = "";
    emit("authenticated", result.user);
  } catch (cause) {
    if (!controller.signal.aborted) requestError.value = cause instanceof Error ? cause.message : translate("账号操作失败，请重试");
  } finally { busy.value = false; }
}

onBeforeUnmount(() => {
  controller.abort();
  password.value = "";
  passwordConfirm.value = "";
});
</script>

<style lang="scss" scoped>
.userWeb {
  --el-bg-color: #0f172a;
  --el-fill-color-blank: rgb(255 255 255 / 5%);
  --el-border-color: rgb(255 255 255 / 16%);
  --el-border-color-hover: rgb(255 255 255 / 32%);
  --el-text-color-primary: #fff;
  --el-text-color-regular: #e2e8f0;
  --el-color-primary-light-3: #3b82f6;
  --el-color-primary-light-5: #60a5fa;
  --el-color-primary-dark-2: #1d4ed8;
  display: grid;
  place-items: center;
  min-height: 100svh;
  padding: 24px 16px;
  background: linear-gradient(135deg, #1e3a8a, #0f172a);
  color: var(--el-text-color-primary);
  font-family: var(--el-font-family), "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;

  .authContent {
    width: min(100%, 448px);
    min-width: 0;

    .authHeader {
      display: grid;
      justify-items: center;
      margin-bottom: 32px;

      .wordmark { display: block; width: min(100%, 200px); height: auto; }
    }

    .authMain {
      .authPanel {
        padding: clamp(20px, 7vw, 32px);
        border: 1px solid rgb(255 255 255 / 10%);
        border-radius: 24px;
        background: rgb(255 255 255 / 5%);
        box-shadow: 0 24px 48px rgb(0 0 0 / 24%);

        .panelHeader {
          margin-bottom: 24px;
          text-align: center;

          h1 { margin: 0; font-size: 24px; font-weight: 650; line-height: 1.35; }
        }

        .authForm {
          :deep(.el-form-item) { margin-bottom: 20px; }
          :deep(.el-form-item__label) { height: auto; padding-bottom: 8px; color: var(--el-text-color-regular); font-weight: 500; line-height: 1.5; }
          :deep(.el-input__wrapper) { min-height: 46px; padding: 1px 14px; border-radius: 12px; }
          :deep(.el-input__inner) { height: 44px; line-height: 44px; }
          :deep(.el-form-item__error) { position: static; padding-top: 6px; color: #fca5a5; line-height: 1.5; overflow-wrap: anywhere; }

          .requestError {
            align-items: flex-start;
            margin-bottom: 20px;

            :deep(.el-alert__title) { line-height: 1.5; overflow-wrap: anywhere; }
          }

          .submitButton { width: 100%; min-height: 46px; margin-left: 0; border-radius: 12px; font-weight: 600; }
        }

        .accountSwitch {
          margin-top: 16px;
          text-align: center;

          .modeButton { min-height: 44px; margin-left: 0; padding: 10px 16px; color: #93c5fd; white-space: normal; }
          .modeButton:hover { color: #bfdbfe; }
        }
      }
    }
  }
}
</style>
