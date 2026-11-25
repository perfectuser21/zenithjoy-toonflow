import { expect, test } from "bun:test";
import { renderIpCard, renderIpCardSvg, ipCardPreset } from "./render";

const preset = { layout: "leftVisualRightText", paper: "warmWhite", accent: "blue", showPage: true } as const;

test("applies layout and palette and preserves the four sample statements", () => {
  const revised = renderIpCardSvg(preset);
  const alternate = renderIpCardSvg({ ...preset, layout: "rightVisualLeftText", accent: "green", showPage: false });
  for (const phrase of ["AI 起草，人守住四条线", "数字、引语和案例都能回到来源", "读者知道今天能做哪一步"]) {
    expect(revised).toContain(phrase);
    expect(alternate).toContain(phrase);
  }
  expect(revised).toContain('<rect x="52" y="166"');
  expect(alternate).toContain('<rect x="650" y="166"');
  expect(revised).toContain('>03</text>');
  expect(alternate).not.toContain('x="990"');
  expect(ipCardPreset.safeParse({ ...preset, svg: "<script/>" }).success).toBe(false);
  expect(ipCardPreset.safeParse({ ...preset, accent: "url(https://example.com)" }).success).toBe(false);
});

test("renders two independent versions to real 1080 by 810 PNGs", async () => {
  const [first, second] = await Promise.all([
    renderIpCard(preset),
    renderIpCard({ ...preset, accent: "green" }),
  ]);
  expect(first.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(first.readUInt32BE(16)).toBe(1080);
  expect(first.readUInt32BE(20)).toBe(810);
  expect(first.length).toBeGreaterThan(30000);
  expect(first.equals(second)).toBe(false);
});
