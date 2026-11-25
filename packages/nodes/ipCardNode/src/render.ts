/// <reference path="./wasmAsset.d.ts" />
import { resolve } from "node:path";
import { readFile } from "@toonflow/file";
import type { IpCardCopy, IpCardPreset } from "./preset";
import { initWasm, Resvg } from "@resvg/resvg-wasm";
import wasmPath from "@resvg/resvg-wasm/index_bg.wasm" with { type: "file" };

import { samples } from "./samples";

const colors = {
  purple: { strong: "#5E45A1", soft: "#E5DCFA" },
  blue: { strong: "#2248AA", soft: "#DDE8FF" },
  green: { strong: "#136950", soft: "#D9F6E6" },
};

function escapeText(value: string) {
  return value.replace(/[&<>]/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!);
}

export function renderIpCardSvg(preset: IpCardPreset, number: number, copy: IpCardCopy) {
  const dark = preset.paper === "dark";
  const ink = dark ? "#F2F1FF" : "#1D2A40";
  const muted = dark ? "#B9B4D1" : "#526379";
  const paper = dark ? "#171528" : preset.paper === "warmWhite" ? "#F7F4ED" : "#F2F6FB";
  const rule = dark ? "#403B59" : "#D8DFEB";
  const accent = colors[preset.accent];
  const leftVisual = preset.layout === "leftVisualRightText";
  const visualX = leftVisual ? 52 : 650;
  const textX = leftVisual ? 451 : 54;
  const text = (value: string, x: number, y: number, size: number, fill = ink, weight = 400) =>
    `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}">${escapeText(value)}</text>`;
  const wrap = (value: string, x: number, y: number, maxCharacters: number, size: number, gap: number, fill: string, weight = 400) => {
    const characters = Array.from(value);
    return Array.from({ length: Math.ceil(characters.length / maxCharacters) }, (_, i) =>
      text(characters.slice(i * maxCharacters, (i + 1) * maxCharacters).join(""), x, y + i * gap, size, fill, weight),
    ).join("");
  };
  const items = copy.items.map((item, index) => {
    const y = 231 + index * 126;
    const bodySize = item.text.length > 72 ? 16 : 20;
    return `<line x1="${textX}" y1="${y + 102}" x2="${textX + 568}" y2="${y + 102}" stroke="${rule}"/>
    <circle cx="${textX + 21}" cy="${y}" r="21" fill="${accent.soft}"/>
    ${text(String(index + 1).padStart(2, "0"), textX + 11, y + 5, 15, accent.strong, 700)}
    ${text(item.label, textX + 55, y + 7, 24, ink, 700)}
    ${wrap(item.text, textX + 55, y + 35, Math.floor(510 / bodySize), bodySize, 21, muted)}`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="810" viewBox="0 0 1080 810">
    <rect width="1080" height="810" fill="${paper}"/>
    <g font-family="Card Sans">
    ${text("独立长文 · 配图", 52, 56, 21, dark ? accent.soft : accent.strong, 700)}
    ${wrap(copy.title, 52, 119, 23, 41, 44, ink, 700)}
    <rect x="${visualX}" y="196" width="373" height="516" rx="18" fill="${accent.strong}"/>
    <circle cx="${visualX + 285}" cy="260" r="44" fill="none" stroke="${accent.soft}" opacity=".65"/>
    <circle cx="${visualX + 285}" cy="260" r="29" fill="none" stroke="${accent.soft}" opacity=".65"/>
    <path d="M${visualX + 34} 310 H${visualX + 335} M${visualX + 34} 518 H${visualX + 335}" stroke="${accent.soft}" opacity=".55"/>
    ${wrap(copy.focus, visualX + 33, 367, 10, 29, 47, "#FFFFFF", 700)}
    ${wrap(copy.caption, visualX + 33, 568, 15, 20, 27, "#FFFFFF")}
    ${items}
    <path d="M52 744 H1028" stroke="${rule}"/>
    ${text(copy.brand, 52, 782, 19, muted)}
    ${preset.showPage ? text(String(number).padStart(2, "0"), 990, 782, 23, dark ? accent.soft : accent.strong, 700) : ""}
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

export async function renderIpCard(preset: IpCardPreset, number = 3, copy = samples[number - 1]!) {
  engine ??= initWasm(readFile(resolve(import.meta.dir, wasmPath)).then(bytes => WebAssembly.compile(new Uint8Array(bytes))));
  font ??= readFile(process.env.TOONFLOW_IP_CARD_FONT ?? fontPath);
  const [, fontData] = await Promise.all([engine, font]);
  const renderer = new Resvg(renderIpCardSvg(preset, number, copy), { font: {
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
