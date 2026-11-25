import { z } from "zod";
import { ipCardCopy, ipCardPreset } from "@toonflow/node-ip-card/preset";

export const steps = ["topic", "article", "cards", "render", "review"] as const;
export type Step = typeof steps[number];
export const labels: Record<Step, string> = {
  topic: "1 写选题与素材",
  article: "2 写长文",
  cards: "3 拆成五张卡",
  render: "4 写风格与渲染",
  review: "5 审核与导出",
};

export interface Skill {
  name: string;
  version: string;
  source: string;
  body: string;
}

const bodies: Record<Step, string> = {
  topic: "根据创作需求整理选题、目标读者、主题、3–5 个核心要点和已有素材。把已知事实、待核实的说法和缺失素材写清楚。不得编造来源、采访、数据或案例。返回简体中文 Markdown 创作简报，内容应足以写作。",
  article: "根据已确认的简报撰写公众号长文。标题最多 30 字。以具体场景或痛点开篇，依次展开核心要点，以价值总结和可执行行动收尾。保留原始事实、限定条件和来源。使用简体中文 Markdown，第一行是一级标题。",
  cards: "按文章叙事顺序拆成五张 4:3 图文卡，每张表达一个独立要点。标题精简，品牌使用原文或用户指定的文字。保留必要的限定条件。只返回 JSON 数组，恰好五个对象，每个对象包含 title（42 字以内）、brand（32 字以内，可空）、focus（30 字以内）、caption（60 字以内）、items（最多四个 {label,text} 对象，标签最多 14 字，正文最多 86 字）。",
  render: "根据输入的五张卡推荐整组版式。只返回 JSON 对象，包含 layout（leftVisualRightText 或 rightVisualLeftText）、paper（dark、warmWhite 或 coolWhite）、accent（purple、blue 或 green）和 showPage（布尔值）。默认深底紫色，从既有模板中选择。保留正文与品牌，避免改动事实。",
  review: "对照长文与五张卡，核对主题、品牌、文案事实、版式和页序。导出 Markdown 和当前批准版本的五张 PNG，文章引用同一包内的相对图片路径。审核由用户确认。",
};

export function builtInSkill(step: Step): Skill {
  return { name: step === "article" ? "公众号长文 · longform-creator 写作规则" : labels[step], version: "1.0.0", source: "Toonflow 内置", body: bodies[step] };
}

export function effectivePrompt(step: Step, skill: Skill, override: string) {
  const outputContract = skill.source !== "Toonflow 内置" && step !== "review"
    ? "\n\n【该节点输出要求】\n" + bodies[step]
    : "";
  return skill.body + outputContract + (override ? "\n\n【本节点提示词】\n" + override : "");
}

const savedCard = z.strictObject({
  copy: ipCardCopy,
  preset: ipCardPreset,
  templateVersion: z.literal(2),
  assetReference: z.string(),
  url: z.string().regex(/^assets\/[\w-]+\/[\da-f-]{36}\.png$/i),
  mimeType: z.literal("image/png"),
});

export const fiveCopies = z.array(ipCardCopy).length(5);
export type SavedCard = z.infer<typeof savedCard>;

const receipt = z.strictObject({
  revision: z.string(),
  sourceRevision: z.string().optional(),
  promptRevision: z.string(),
  article: z.string().optional(),
  text: z.string().optional(),
  copies: fiveCopies.optional(),
  cards: z.array(savedCard).length(5).optional(),
  groupPreset: ipCardPreset.optional(),
  exportPath: z.string().regex(/^assets\/[\w-]+\/[\da-f-]{36}\.zip$/i).optional(),
});
export type Receipt = z.infer<typeof receipt>;

export function readReceipt(value: unknown): Receipt | undefined {
  if (typeof value !== "string" || !value) return;
  try {
    const result = receipt.safeParse(JSON.parse(value));
    if (result.success) return result.data;
  } catch {
    return;
  }
}

export function parseModelJson(text: string): unknown {
  return JSON.parse(text.trim().replace(/^\x60\x60\x60(?:json)?\s*/i, "").replace(/\s*\x60\x60\x60$/, ""));
}
