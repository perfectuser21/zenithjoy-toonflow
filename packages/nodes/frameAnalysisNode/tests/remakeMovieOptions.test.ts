import { expect, test } from "bun:test";
import { remakeMovieOptions } from "../src/remakeMovieOptions";

const picture = { path: "assets/original-room.png", mimeType: "image/png" };
const replacement = { path: "assets/new-product.png", mimeType: "image/png" };

test("换品的每个镜头使用新商品参考，并保留镜头和人物", () => {
  const result = remakeMovieOptions({
    productSwap: { reference: replacement },
    shots: [{ group: null, productPrompt: "" }, { group: null, productPrompt: "" }],
    groups: [],
  });
  expect(result).toHaveLength(2);
  expect(result.every(shot => shot.image === replacement && /替换.*商品/.test(shot.prompt))).toBe(true);
  expect(result.every(shot => /镜头.*人物/.test(shot.prompt) && !shot.prompt.includes("仅使用背景参考换景"))).toBe(true);
  expect(result.every(shot => shot.prompt.includes("不得新增人物、手或动作") && shot.prompt.includes("标签图案"))).toBe(true);
});

test("既有视频翻拍仍使用背景样张并保留真实商品", () => {
  expect(remakeMovieOptions({
    shots: [{ group: 1, productPrompt: "保留原标签" }],
    groups: [{ id: 1, picture }],
  })).toEqual([{ image: picture, prompt: "仅使用背景参考换景，保持原镜头时间、真实人物与商品、手部和字幕。商品展示要求：保留原标签" }]);
});
