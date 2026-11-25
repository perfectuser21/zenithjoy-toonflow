import type { BackgroundReview } from "./backgroundAssignments";
import type { AnalysisResult } from "./videoAnalysis";

type Assignment = BackgroundReview["assignments"][number];
export type AnalysisEdit = { kind: "merge"; shot: number } | { kind: "group"; shot: number; group: number | null };

function canonicalize(assignments: Assignment[]) {
  const anchors = new Map<number, number>();
  return assignments.map((assignment, index) => {
    const shot = index + 1;
    const group = assignment.referenceShot;
    if (group !== null && !anchors.has(group)) anchors.set(group, shot);
    return { ...assignment, shot, referenceShot: group === null ? null : anchors.get(group)! };
  });
}

export function editAnalysis(result: AnalysisResult, edit: AnalysisEdit): AnalysisResult {
  const index = edit.shot - 1;
  const scene = result.scenes[index];
  if (!scene || scene.index !== edit.shot) throw new Error("镜头已经变化，请重新打开拉片报告");
  const assignments = result.backgroundReview?.assignments ?? result.scenes.map(shot => ({
    shot: shot.index, referenceShot: shot.index, evidence: "独立分组",
  }));
  const scenes = [...result.scenes];
  let next: Assignment[];
  if (edit.kind === "group") {
    if (edit.group !== null && edit.group !== edit.shot && !assignments.some(row => row.referenceShot === edit.group)) throw new Error("背景分组已经变化");
    next = assignments.map(row => row.shot === edit.shot ? { ...row, referenceShot: edit.group, evidence: "已调整背景组" } : row);
  } else {
    const previous = scenes[index - 1];
    if (!previous) throw new Error("没有可合并的上一镜头");
    if (scene.end - previous.start > 15 + Number.EPSILON) throw new Error("合并后会超过 15 秒，请保留这个处理分段");
    const image = scene.end - scene.start > previous.end - previous.start ? scene.image : previous.image;
    scenes.splice(index - 1, 2, { ...previous, end: scene.end, image });
    next = assignments.filter(row => row.shot !== edit.shot);
  }
  const backgroundReview = edit.kind === "merge" && !result.backgroundReview ? undefined : {
    providerId: "manual", modelId: "manual", reviewedAt: new Date().toISOString(), assignments: canonicalize(next),
  };
  return { ...result, scenes: scenes.map((shot, position) => ({ ...shot, index: position + 1 })), backgroundReview };
}
