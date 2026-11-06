import { ApiError, jsonRequest, requestJSON } from "../../lib/documents";
import { practiceUpdate } from "../../lib/learning-practice";
import type { LearningChapter, LearningPath } from "../../lib/learning-paths";
import { button, element } from "../workspaces/dom";

const pending = new Set<string>();
const feedback = new Map<string, { message: string; conflict: boolean }>();

export function practicePanel(
  path: LearningPath,
  chapter: LearningChapter,
  onSaved: (path: LearningPath) => void,
) {
  const key = `${path.id}:${chapter.id}`;
  const panel = element("div", "learn-practice-panel");
  panel.append(element("span", "eyebrow", "BUILD YOUR UNDERSTANDING / 实践任务"));
  panel.append(element("p", "learn-practice-description", chapter.exercise));
  const status = element("p", "learn-practice-status");
  status.textContent = feedback.get(key)?.message || "";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const control = button(chapter.practiced ? "✓ 已完成实践 · 撤销" : "我已完成这项实践", () => void save());
  control.className = "button learn-practice-toggle";
  control.dataset.practice = chapter.id;
  control.dataset.pathId = path.id;
  control.disabled = pending.has(path.id);
  control.setAttribute("aria-pressed", String(chapter.practiced === true));
  const retry = button("读取最新路线后再确认", () => void reload());
  retry.className = "button";
  retry.hidden = !feedback.get(key)?.conflict;
  panel.append(
    element("small", "learn-practice-note", "完成代码、实验或笔记后再确认。已读状态不会替你完成实践。"),
    control, status, retry,
  );

  function freeze(value: boolean) {
    document.querySelectorAll<HTMLButtonElement>("[data-practice]").forEach((item) => {
      if (item.dataset.pathId === path.id) item.disabled = value;
    });
  }
  function reveal(saved: LearningPath) {
    feedback.delete(key);
    onSaved(saved);
    const target = document.querySelector<HTMLButtonElement>(`[data-practice="${CSS.escape(chapter.id)}"]`);
    if (target?.dataset.pathId === path.id) target.focus({ preventScroll: true });
  }
  async function save() {
    if (pending.has(path.id)) return;
    pending.add(path.id);
    freeze(true);
    retry.hidden = true;
    feedback.delete(key);
    status.textContent = "正在保存实践记录…";
    try {
      const saved = await requestJSON<LearningPath>(`/api/learning-paths/${path.id}`,
        jsonRequest("PUT", practiceUpdate(path, chapter.id, !chapter.practiced)));
      pending.delete(path.id);
      reveal(saved);
    } catch (error) {
      const conflict = error instanceof ApiError && error.status === 409;
      const message = conflict
        ? "另一处已更新路线，本次实践标记尚未保存。读取最新路线后可重新确认。"
        : error instanceof Error ? error.message : "实践记录保存失败，请重试。";
      feedback.set(key, { message, conflict });
      status.textContent = message;
      retry.hidden = !conflict;
    } finally {
      pending.delete(path.id);
      freeze(false);
    }
  }
  async function reload() {
    if (pending.has(path.id)) return;
    retry.disabled = true;
    try {
      reveal(await requestJSON<LearningPath>(`/api/learning-paths/${path.id}`));
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "读取失败，请重试。";
    } finally {
      retry.disabled = false;
    }
  }
  return panel;
}

export function pathContext(path: LearningPath) {
  const grid = element("div", "learn-context");
  for (const [heading, items, empty] of [
    ["这一程，你将能够", path.objectives, "在「整理章节」中写下学习目标，让每一步都有方向。"],
    ["出发之前", path.prerequisites, "未设置先修要求。可以从第一章开始，随时回到这里补充。"],
  ] as const) {
    const section = element("section", "learn-context-card");
    section.append(element("h3", "", heading));
    if (items?.length) {
      const list = element("ul");
      list.append(...items.map((item) => element("li", "", item)));
      section.append(list);
    } else section.append(element("p", "", empty));
    grid.append(section);
  }
  return grid;
}
