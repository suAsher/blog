import { parseExplorer } from "./explorers";

export const writingTemplateOptions = [
  { id: "blank", label: "空白文档", hint: "从一个想法自由开始", number: "00" },
  {
    id: "tutorial",
    label: "循序教程",
    hint: "带着读者完成一次可验证的实践",
    number: "01",
  },
  {
    id: "explanation",
    label: "原理解读",
    hint: "从一个问题，建立完整的理解",
    number: "02",
  },
  {
    id: "troubleshooting",
    label: "排错记录",
    hint: "保留证据、判断和验证的过程",
    number: "03",
  },
  {
    id: "reference",
    label: "随用速查",
    hint: "快速找到条件、用法和注意事项",
    number: "04",
  },
] as const;
export type WritingTemplateKind = (typeof writingTemplateOptions)[number]["id"];

const sections: Record<
  Exclude<WritingTemplateKind, "blank">,
  readonly (readonly [string, string])[]
> = {
  tutorial: [
    ["完成后，你能做到什么", "用一个可观察的结果描述目标，并写明先修知识。"],
    [
      "准备一个最小环境",
      "记录实际使用的版本、依赖与输入；尚未验证的环境要明确标注。",
    ],
    [
      "从最小步骤开始",
      "先完成一个能运行的例子，再解释关键选择。贴入自己的代码和图解。",
    ],
    ["验证结果", "列出复现命令、预期观察和实际输出，区分教学模拟与真实测量。"],
    ["失败时，先检查这里", "补充一个常见失败输入，说明如何观察和修复。"],
    ["自己试一次", "提出一个改变输入的小练习，并说明如何判断结果。"],
    ["来源与下一步", "记录实际参考的来源，以及接下来值得阅读的内容。"],
  ],
  explanation: [
    ["一个值得解释的问题", "描述令人困惑的现象，以及常见但不完整的直觉。"],
    ["先建立一个模型", "写清模型中的对象、关系、假设和单位。"],
    ["沿着过程推演", "用一张图或一个具体输入，逐步解释状态如何变化。"],
    [
      "用实验检验理解",
      "提出一个可重复的观察；列出步骤、实际结果和仍未验证的部分。",
    ],
    ["反例与边界", "解释模型何时不再适用，以及哪些现象不能据此推断。"],
    ["回头回答最初的问题", "用自己的话总结机制，并留下一个自检问题。"],
    ["来源与延伸", "记录支撑结论的一手资料和相关笔记。"],
  ],
  troubleshooting: [
    [
      "现象与影响范围",
      "记录观察到的现象、发生条件与时间；不要补造没有发生的故障。",
    ],
    ["事实与假设", "分别列出已有证据、待验证猜测和缺失信息。"],
    ["按顺序缩小范围", "记录每一步检查、看到的输出，以及它排除了什么。"],
    ["最小复现", "给出可分享且不含凭据的输入、环境和复现步骤。"],
    [
      "修复与回归验证",
      "说明实际改动、验证结果、风险与回退方法。未解决时如实记录。",
    ],
    ["留下排查地图", "提炼下次遇到类似现象时的检查顺序和判定条件。"],
    ["来源与关联记录", "链接相关说明、变更记录与自己的原始观察。"],
  ],
  reference: [
    ["适用条件", "说明版本、运行环境、必要权限和不适用的场景。"],
    ["按任务查找", "用“我想做什么”组织常用操作，每项给出最小用法。"],
    ["参数与结果", "列出需要记住的参数、单位、默认值和返回结果。"],
    ["容易混淆的地方", "对比相似选项，说明错误使用会导致什么。"],
    ["验证与更新", "记录最后核对日期、验证环境和仍待核对的条目。"],
    ["来源", "链接正式文档或支撑条目的原始记录。"],
  ],
};

export function writingTemplateDraft(kind: WritingTemplateKind) {
  const option = writingTemplateOptions.find((item) => item.id === kind);
  if (!option) throw new Error("请选择已有的写作模板。");
  if (kind === "blank")
    return { title: "未命名文档", description: "", source: "" };
  const source = [
    "> **写作骨架** · 以下是编辑提示，请替换为自己的内容；未验证的结论应明确标注。",
    ...sections[kind].map(
      ([heading, prompt]) => `## ${heading}\n\n待填写：${prompt}`,
    ),
  ].join("\n\n");
  return {
    title: `待命名 · ${option.label}`,
    description: "",
    source: `${source}\n`,
  };
}

/** A fixed, data-only model; the same parser enforces reader and writer limits. */
export function explorerMarkdown(kind: string, title: string): string {
  const specification = {
    kind,
    ...(title.trim() ? { title: title.trim() } : {}),
  };
  const definition = JSON.stringify(specification, null, 2);
  parseExplorer(definition);
  return `\n\`\`\`explore\n${definition}\n\`\`\`\n`;
}
