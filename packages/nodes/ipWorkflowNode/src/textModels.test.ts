import { expect, test } from "bun:test";
import { chooseIpTextModel, ipTrialModelName } from "./textModels";

const terra = { modelId: "gpt-6.1-terra", selectionKey: "terra-route" };
const sol = { modelId: "gpt-6.2-sol", selectionKey: "sol-route" };
const qwen = { modelId: "qwen3.7-plus", selectionKey: "old-qwen-route" };

test("IP 文字模型优先 Terra，已有千问选择切换到 Terra", () => {
  expect(chooseIpTextModel([qwen, sol, terra], qwen.selectionKey)).toEqual({
    available: [terra, sol],
    selected: terra.selectionKey,
  });
});

test("保留主动选择的 Sol", () => {
  expect(chooseIpTextModel([terra, sol], sol.selectionKey).selected).toBe(sol.selectionKey);
});

test("Terra 不可用时等待选择，千问不出现在 IP 工作流", () => {
  expect(chooseIpTextModel([qwen, sol], qwen.selectionKey)).toEqual({ available: [sol], selected: "" });
  expect(chooseIpTextModel([qwen], qwen.selectionKey)).toEqual({ available: [], selected: "" });
});

test("试稿可显示已有的 GPT 模型，路由标识和异常值不冒充模型名", () => {
  expect(ipTrialModelName('["fixture","gpt-6.1-terra"]')).toBe("GPT-6.1 Terra");
  expect(ipTrialModelName('["fixture","gpt-6.2-sol"]')).toBe("GPT-6.2 Sol");
  expect(ipTrialModelName('["multiTenant","89e0a610-55c3-4f2a-8d36-a41d767b1198"]')).toBeUndefined();
  expect(ipTrialModelName("invalid")).toBeUndefined();
});
