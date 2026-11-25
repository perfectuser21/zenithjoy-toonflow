type Reference = { path: string; mimeType: string };
type OptionsInput = {
  productSwap?: { reference: Reference };
  shots: { group: number | null; productPrompt: string }[];
  groups: { id: number; picture?: Reference }[];
};

export function remakeMovieOptions(view: OptionsInput) {
  const reference = view.productSwap?.reference;
  if (reference) return view.shots.map(() => ({
    image: reference,
    prompt: "只替换原视频中出现的商品，替换成参考图里的新商品。保留原镜头时长和构图、真实人物、手部动作、背景和字幕。新商品外形、配色和包装细节以图片参考为准，出现在原商品的位置，不新增商品出现的镜头。",
  }));
  return view.shots.map(shot => {
    const group = view.groups.find(item => item.id === shot.group);
    if (!group?.picture) throw new Error("每组背景先生成一张样张");
    return { image: group.picture, prompt: `仅使用背景参考换景，保持原镜头时间、真实人物与商品、手部和字幕。商品展示要求：${shot.productPrompt}` };
  });
}
