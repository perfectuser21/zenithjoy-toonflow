import { expect, test } from "bun:test";
import { activeMountedSkill, appendSkillVersion } from "./skillMount";

const initial = { name: "公众号长文", body: "原规则", version: "1.0.0", source: "Toonflow 内置" };

test("试用替代规则会保留原版本并切换到新版本", () => {
  const versions = appendSkillVersion([initial], "公众号长文", " 新规则 ", "candidate");
  expect(versions).toHaveLength(2);
  expect(activeMountedSkill(versions, "1.0.0")).toEqual(initial);
  expect(activeMountedSkill(versions, "candidate")?.body).toBe("新规则");
  expect(activeMountedSkill(versions, "missing")).toBeUndefined();
});
