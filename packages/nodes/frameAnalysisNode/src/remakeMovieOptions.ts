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
    prompt: "只替换原视频中出现的商品，替换成参考图里的新商品。保留原镜头时长、构图、背景、字幕，以及原有的人物、手部和动作。不得新增人物、手或动作，不新增镜头。严格保留参考图中的商品轮廓、颜色、包装和标签图案，商品位置跟随原视频。",
  }));
  return view.shots.map(shot => {
    const group = view.groups.find(item => item.id === shot.group);
    if (!group?.picture) throw new Error("每组背景先生成一张样张");
    return { image: group.picture, prompt: `仅使用背景参考换景，保持原镜头时间、真实人物与商品、手部和字幕。商品展示要求：${shot.productPrompt}` };
  });
}
