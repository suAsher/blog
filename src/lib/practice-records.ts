import type { DocumentContent } from "./documents";
import {
  validateLearningPath,
  type LearningInput,
  type LearningPath,
} from "./learning-paths";

/** Evidence is separate from ordered reading and the explicit practice check. */
export function practiceRecordUpdate(
  path: LearningPath,
  chapterId: string,
  documentId: string,
  action: "attach" | "remove",
): LearningInput & { version: number } {
  if (!/^[a-f0-9]{32}$/.test(documentId)) throw new Error("实践记录标识无效。");
  if (!path.chapters.some((chapter) => chapter.id === chapterId))
    throw new Error("这一章已被移除。文档仍保留在写作空间，可关联到其他章节。");
  const value = {
    title: path.title,
    description: path.description,
    accent: path.accent,
    objectives: path.objectives,
    prerequisites: path.prerequisites,
    version: path.version,
    chapters: path.chapters.map((chapter) => {
      if (chapter.id !== chapterId) return { ...chapter };
      const existing = chapter.practiceDocumentIds || [];
      const practiceDocumentIds =
        action === "remove"
          ? existing.filter((id) => id !== documentId)
          : [...new Set([...existing, documentId])];
      return { ...chapter, practiceDocumentIds };
    }),
  };
  const error = validateLearningPath(value);
  if (error) throw new Error(error);
  return value;
}

function markdownText(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+.!|<>~-]/gu, "\\$&");
}

export function practiceRecordDraft(
  path: LearningPath,
  chapterId: string,
  title: string,
  now = new Date(),
): DocumentContent {
  const chapter = path.chapters.find((item) => item.id === chapterId);
  if (!chapter) throw new Error("章节不存在，请读取最新路线。");
  if (
    !title.trim() ||
    [...title.trim()].length > 160 ||
    /[\u0000-\u001f\u007f]/u.test(title)
  )
    throw new Error("记录标题需要 1–160 字，且不能换行。");
  const exercise = (chapter.exercise || "记录本章的一次操作、观察与结论。")
    .split(/\r?\n/u)
    .map((line) => `> ${markdownText(line)}`)
    .join("\n");
  const source = [
    "> **实践草稿 · 尚未完成验证**。以下是记录骨架，请替换为实际操作与观察；未验证的内容应明确标注。",
    `所属路线：[${markdownText(path.title)} / ${markdownText(chapter.title)}](/learn/?id=${encodeURIComponent(path.id)}#chapter-${encodeURIComponent(chapter.id)})`,
    `## 实践目标\n\n${exercise}`,
    "## 环境与输入\n\n待填写：系统、版本、依赖、输入及适用范围。不要记录密码或密钥。",
    "## 操作步骤\n\n1. 待填写：先做什么，为什么。\n2. 待填写：如何复现关键现象。",
    "## 代码与命令\n\n待填写：最小可复现代码或命令，并注明语言与版本。\n\n```text\n在这里粘贴代码或命令\n```",
    "## 预期与实际结果\n\n| 观察项 | 预期 | 实际 | 验证状态 |\n| --- | --- | --- | --- |\n| 待填写 | 待填写 | 待测量 | 尚未验证 |",
    "## 截图与附件\n\n在写作空间上传配套图片，再把图片插入这里；说明截图展示的环境、输入和现象。",
    "## 失败原因\n\n待填写：失败输入、原始输出、可能原因，以及验证或排除原因的过程。没有发生过的故障不要补造。",
    "## 复盘与下一步\n\n- 我现在能够解释：待填写。\n- 仍然不确定：待填写。\n- 下一次验证：待填写。",
  ].join("\n\n");
  return {
    title: title.trim(),
    description: "记录本章实践的环境、步骤、结果与复盘，尚待验证。",
    date: now.toISOString().slice(0, 10),
    tags: [],
    category: "",
    cover: "",
    kind: "note",
    maturity: "growing",
    source: `${source}\n`,
  };
}
