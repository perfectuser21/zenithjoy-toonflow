import { expect, test } from "bun:test";
import { articleDocumentPath, readArticleDocument } from "./articleDocument";

const version = "4c2acfe1-996f-4e81-9d37-2c715f39ea82";
const path = "长文-4c2acfe1-996f-4e81-9d37-2c715f39ea82.md";

test("改稿使用文档里的当前内容，旧画布沿用保存的长文", async () => {
  const read = async (name: string) => {
    expect(name).toBe(path);
    return "  # 修改后的正文   ";
  };
  expect(articleDocumentPath(version)).toBe(path);
  expect(await readArticleDocument({ article: "# 旧版", articlePath: path }, read)).toBe("# 修改后的正文");
  expect(await readArticleDocument({ article: "# 旧画布正文" }, read)).toBe("# 旧画布正文");
});

test("错误路径和空文档不会被用于拆卡", async () => {
  await expect(readArticleDocument({ articlePath: "../其他项目.md" }, async () => "不可使用")).rejects.toThrow("无效");
  await expect(readArticleDocument({ articlePath: path }, async () => "   ")).rejects.toThrow("为空");
});
