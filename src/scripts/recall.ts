import { MAX_RECALL_CARDS, parseRecall } from "../lib/recall";
import "../styles/recall.css";

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = "") {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

/** Synchronous text-only enhancement keeps adjacent annotation positions stable. */
export function enhanceRecallCards(root: HTMLElement) {
  let count = root.querySelectorAll(".recall-widget").length;
  root.querySelectorAll<HTMLElement>("pre > code").forEach((code) => {
    if (code.closest(".content-widget")) return;
    const pre = code.parentElement!;
    const language = code.dataset.language || pre.dataset.language ||
      /(?:^|\s)language-([^\s]+)/.exec(code.className)?.[1];
    if (language !== "recall") return;
    const card = element("section", "", "content-widget recall-widget");
    const definition = element("details", "", "recall-definition");
    definition.append(element("summary", "查看问题卡原文"));
    pre.replaceWith(card);
    definition.append(pre);
    try {
      if (++count > MAX_RECALL_CARDS)
        throw new Error("每篇最多展示 10 张问题卡，其余保留原文。");
      const spec = parseRecall(code.textContent || "");
      card.append(element("p", "RECALL / 先想一想", "recall-eyebrow"));
      card.append(element("h2", spec.question, "recall-question"));
      card.append(element("p", "试着用自己的话回答，再核对解释。", "recall-prompt"));
      const answer = element("details", "", "recall-answer");
      answer.append(element("summary", "展开解释"));
      answer.append(element("p", spec.answer, "recall-answer-text"));
      card.append(answer);
      if (spec.source) {
        const link = element("a", "回到原文批注 ↗", "recall-source");
        link.href = spec.source;
        card.append(link);
      }
    } catch (error) {
      const message = element("p", error instanceof Error ? error.message : "问题卡暂不可用。", "widget-error");
      message.setAttribute("role", "status");
      card.append(message);
      definition.open = true;
    }
    card.append(definition);
  });
}
