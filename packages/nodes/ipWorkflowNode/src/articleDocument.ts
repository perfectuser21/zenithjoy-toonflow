export const articleDocumentPattern = /^长文-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\.md$/i;

export function articleDocumentPath(revision: string) {
  return `长文-${revision}.md`;
}

export async function readArticleDocument(source: { article?: string; articlePath?: string }, readText: (path: string) => Promise<string>) {
  if (!source.articlePath) return source.article ?? "";
  if (!articleDocumentPattern.test(source.articlePath)) throw new Error("长文文档路径无效");
  const article = (await readText(source.articlePath)).trim();
  if (!article) throw new Error("长文文档为空，请先保存正文");
  return article;
}
