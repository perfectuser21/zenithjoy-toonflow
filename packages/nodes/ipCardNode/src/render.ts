/// <reference path="./wasmAsset.d.ts" />
import { resolve } from "node:path";
import { readFile } from "@toonflow/file";
import type { IpCardPreset } from "./preset";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasmPath from "@resvg/resvg-wasm/index_bg.wasm" with { type: "file" };

const input = {
  "number": "03",
  "title": "AI 起草，人守住四条线",
  "slogan": "可用不等于流畅",
  "caption": "缺证据的地方，先标记",
  "items": [
    ["事实", "数字、引语和案例都能回到来源"],
    ["逻辑", "结论有理由，反例与边界不回避"],
    ["表达", "删掉空话，保留可识别的专业判断"],
    ["行动", "读者知道今天能做哪一步"]
  ]
};

function renderIpCardSvg(preset: IpCardPreset) {
  const ink = '#1D2A40';
  const muted = '#526379';
  const paper = preset.paper === 'warmWhite' ? '#F7F4ED' : '#F2F6FB';
  const accent = preset.accent === 'blue' ? '#2248AA' : '#136950';
  const accentSoft = preset.accent === 'blue' ? '#DDE8FF' : '#D9F6E6';
  const leftVisual = preset.layout === 'leftVisualRightText';
  const visualX = leftVisual ? 52 : 650;
  const textX = leftVisual ? 452 : 55;
  const text = (value: string, x: number, y: number, size: number, fill = ink, weight = 400) =>
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}">${value}</text>`;
  const items = input.items.map(([label, description], index) => {
    const y = 205 + index * 116;
    return `<line x1="${textX}" y1="${y+75}" x2="${textX+574}" y2="${y+75}" stroke="#D8DFEB"/>
    <circle cx="${textX+22}" cy="${y+8}" r="22" fill="${accentSoft}"/>
    ${text(String(index+1).padStart(2,'0'), textX+10, y+14, 17, accent, 700)}
    ${text(label, textX+58, y+16, 28, ink, 700)}
    ${text(description, textX+58, y+52, 24, muted)}`;
  }).join('\n');
  const [a,b] = input.slogan.split('不等于');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="810" viewBox="0 0 1080 810">
  <rect width="1080" height="810" fill="${paper}"/>
  <g font-family="Card Sans">
  ${text('独立长文 · 配图', 52, 58, 21, accent, 700)}
  ${text(input.title, 52, 126, 53, ink, 700)}
  <rect x="${visualX}" y="166" width="373" height="541" rx="18" fill="${accent}"/>
  <circle cx="${visualX+285}" cy="228" r="49" fill="none" stroke="#AABFFF" opacity=".65"/>
  <circle cx="${visualX+285}" cy="228" r="34" fill="none" stroke="#AABFFF" opacity=".65"/>
  <path d="M${visualX+34} 312 H${visualX+335} M${visualX+34} 532 H${visualX+335}" stroke="#AABFFF" opacity=".55"/>
  ${text(a, visualX+38, 375, 69, '#FFFFFF', 700)}
  ${text('不等于', visualX+40, 435, 36, '#C7D7FF', 700)}
  ${text(b, visualX+38, 512, 69, '#FFFFFF', 700)}
  ${text(input.caption, visualX+39, 610, 23, '#FFFFFF')}
  ${items}
  <path d="M52 744 H1028" stroke="#D8DFEB"/>
  ${text('ZenithJoy · AI自动发布系列', 52, 782, 19, muted)}
  ${preset.showPage ? text(input.number, 990, 782, 23, accent, 700) : ''}
  </g></svg>`;
}

const fontPath = process.platform === "darwin"
  ? "/System/Library/Fonts/STHeiti Medium.ttc"
  : process.platform === "win32"
    ? `${process.env.WINDIR ?? "C:\\Windows"}\\Fonts\\msyh.ttc`
    : "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc";
const fontFamily = process.platform === "darwin" ? "Heiti SC" : process.platform === "win32" ? "Microsoft YaHei" : "WenQuanYi Zen Hei";
let engine: Promise<void> | undefined;
let font: Promise<Buffer> | undefined;

export async function renderIpCard(preset: IpCardPreset) {
  engine ??= initWasm(readFile(resolve(import.meta.dir, wasmPath)).then(bytes => WebAssembly.compile(new Uint8Array(bytes))));
  font ??= readFile(process.env.TOONFLOW_IP_CARD_FONT ?? fontPath);
  const [, fontData] = await Promise.all([engine, font]);
  const renderer = new Resvg(renderIpCardSvg(preset), { font: {
    fontBuffers: [fontData], defaultFontFamily: fontFamily, sansSerifFamily: fontFamily,
  } });
  const image = renderer.render();
  try {
    return Buffer.from(image.asPng());
  } finally {
    image.free();
    renderer.free();
  }
}
