import type { IpCardCopy } from "./preset";

const brand = "ZenithJoy · AI自动发布系列";
export const samples: IpCardCopy[] = [
  {
    title: "先写简报，再让 AI 写稿", brand, focus: "先固定读者问题", caption: "选一个问题，做出一份可回溯母稿",
    items: [
      { label: "读者", text: "有专业经验、但输出不稳定的独立创作者" },
      { label: "问题", text: "每次找素材、改稿都从零开始" },
      { label: "判断", text: "先沉淀母稿，再自动化重复工作" },
      { label: "行动", text: "选一个问题，做出一份可回溯母稿" },
    ],
  },
  {
    title: "三个库，各自只干一件事", brand, focus: "素材有出处", caption: "反馈回到 Ideas，让下一篇有据可依",
    items: [
      { label: "Ideas", text: "记录原始问题、链接和自己的观察" },
      { label: "Seed", text: "筛选值得展开的问题，写清核心判断" },
      { label: "Core", text: "保存经过审核的母稿，关联来源与版本" },
    ],
  },
  {
    title: "AI 起草，人守住四条线", brand, focus: "可用不等于流畅", caption: "缺证据的地方，先标记",
    items: [
      { label: "事实", text: "数字、引语和案例都能回到来源" },
      { label: "逻辑", text: "结论有理由，反例与边界不回避" },
      { label: "表达", text: "删掉空话，保留可识别的专业判断" },
      { label: "行动", text: "读者知道今天能做哪一步" },
    ],
  },
  {
    title: "不是复制三份，是改编三次", brand, focus: "同一份经过审核的母稿", caption: "变的是阅读结构，事实边界保持一致",
    items: [
      { label: "短帖", text: "一个冲突、一个判断、一个动作" },
      { label: "深度帖", text: "痛点、论证、边界和金句" },
      { label: "图文卡", text: "把步骤、对比和问答变成可扫读结构" },
    ],
  },
  {
    title: "先试一周，再补自动化", brand, focus: "每轮只改一个瓶颈", caption: "建议安排 · 非实测工时",
    items: [
      { label: "周一", text: "选一个真实问题，收集依据" },
      { label: "周二到周三", text: "写母稿并审核，记录返工原因" },
      { label: "周四到周五", text: "改编、对照检查，形成可用版本" },
      { label: "周末", text: "复盘耗时和瓶颈，决定下一轮只改哪一步" },
    ],
  },
];
