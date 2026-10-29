import { ApiError, jsonRequest, requestJSON } from "../../lib/documents";
import {
  moveLesson,
  validateLearningPath,
  type LearningInput,
  type LearningPath,
} from "../../lib/learning-paths";
import { button, element, get } from "../workspaces/dom";
import { availableDocuments, loadLearningPaths } from "./index";

const dialog = get<HTMLDialogElement>("learn-dialog");
let original: LearningPath | undefined;
let local: LearningInput = {
  title: "",
  description: "",
  accent: "mint",
  chapters: [],
};
let busy = false;
let dirty = false;
export function editLearningPath(path?: LearningPath) {
  original = path;
  local = path
    ? structuredClone(path)
    : { title: "", description: "", accent: "mint", chapters: [] };
  get<HTMLInputElement>("learn-title").value = local.title;
  get<HTMLTextAreaElement>("learn-description").value = local.description;
  get<HTMLSelectElement>("learn-accent").value = local.accent;
  get("learn-delete").hidden = !path;
  get("learn-delete-confirm").hidden = true;
  get("learn-conflict").hidden = true;
  get("learn-save-status").textContent = "";
  dirty = false;
  renderChapters();
  if (!dialog.open) dialog.showModal();
  get("learn-title").focus();
}
function updateChapter(
  id: string,
  patch: Partial<LearningInput["chapters"][number]>,
) {
  local = {
    ...local,
    chapters: local.chapters.map((chapter) =>
      chapter.id === id ? { ...chapter, ...patch } : chapter,
    ),
  };
  dirty = true;
}
function renderChapters() {
  const docs = availableDocuments();
  const selected = new Set(
    local.chapters.flatMap((chapter) => chapter.documentIds),
  );
  get("learn-chapter-editor").replaceChildren(
    ...local.chapters.map((chapter, index) => {
      const section = element("section", "learn-edit-chapter");
      const heading = element("div", "learn-edit-heading");
      heading.append(element("h3", "", `第 ${index + 1} 章`));
      const actions = element("div");
      for (const direction of [-1, 1] as const) {
        const control = button(
          direction === -1 ? "↑" : "↓",
          () => {
            const ids = moveLesson(
              local.chapters.map((value) => value.id),
              chapter.id,
              direction,
            );
            local = {
              ...local,
              chapters: ids.map((id) =>
                local.chapters.find((value) => value.id === id)!,
              ),
            };
            dirty = true;
            renderChapters();
          },
          `${direction === -1 ? "上移" : "下移"}第 ${index + 1} 章`,
        );
        control.disabled =
          direction === -1 ? index === 0 : index === local.chapters.length - 1;
        actions.append(control);
      }
      actions.append(
        button(
          "移除章节",
          () => {
            local = {
              ...local,
              chapters: local.chapters.filter(
                (value) => value.id !== chapter.id,
              ),
            };
            dirty = true;
            renderChapters();
          },
          `移除章节：第 ${index + 1} 章（保留文章）`,
        ),
      );
      heading.append(actions);
      const label = element("label", "", "章节标题"),
        title = element("input");
      title.value = chapter.title;
      title.required = true;
      title.maxLength = 160;
      title.addEventListener("input", () =>
        updateChapter(chapter.id, { title: title.value }),
      );
      label.append(title);
      const descLabel = element("label", "", "章节导读"),
        desc = element("textarea");
      desc.value = chapter.description;
      desc.rows = 2;
      desc.maxLength = 2000;
      desc.addEventListener("input", () =>
        updateChapter(chapter.id, { description: desc.value }),
      );
      descLabel.append(desc);
      section.append(heading, label, descLabel);
      const list = element("ol", "learn-edit-lessons");
      chapter.documentIds.forEach((id, lessonIndex) => {
        const row = element("li");
        row.append(
          element(
            "span",
            "",
            docs.find((doc) => doc.id === id)?.title || "暂不可用的文章",
          ),
        );
        for (const direction of [-1, 1] as const) {
          const control = button(
            direction === -1 ? "↑" : "↓",
            () => {
              updateChapter(chapter.id, {
                documentIds: moveLesson(chapter.documentIds, id, direction),
              });
              renderChapters();
            },
            `${direction === -1 ? "上移" : "下移"}第 ${lessonIndex + 1} 篇文章`,
          );
          control.disabled =
            direction === -1
              ? lessonIndex === 0
              : lessonIndex === chapter.documentIds.length - 1;
          row.append(control);
        }
        row.append(
          button(
            "移除",
            () => {
              updateChapter(chapter.id, {
                documentIds: chapter.documentIds.filter(
                  (value) => value !== id,
                ),
              });
              renderChapters();
            },
            `移除文章 ${docs.find((doc) => doc.id === id)?.title || id}`,
          ),
        );
        list.append(row);
      });
      const addLabel = element("label", "", "加入已有文章或草稿"),
        select = element("select");
      select.id = `learn-add-document-${chapter.id}`;
      addLabel.htmlFor = select.id;
      select.setAttribute("aria-label", "加入已有文章或草稿");
      const placeholder = element("option", "", "选择文章…");
      placeholder.value = "";
      select.append(placeholder);
      docs
        .filter((doc) => !selected.has(doc.id))
        .forEach((doc) => {
          const option = element(
            "option",
            "",
            `${doc.title} · ${doc.status === "published" ? "已发布" : "草稿"}`,
          );
          option.value = doc.id;
          select.append(option);
        });
      select.addEventListener("change", () => {
        if (!select.value) return;
        updateChapter(chapter.id, {
          documentIds: [...chapter.documentIds, select.value],
        });
        renderChapters();
      });
      section.append(list, addLabel, select);
      return section;
    }),
  );
}
get("learn-add-chapter").addEventListener("click", () => {
  if (local.chapters.length >= 30) {
    get("learn-save-status").textContent = "每条路线最多 30 章。";
    return;
  }
  local = {
    ...local,
    chapters: [
      ...local.chapters,
      { id: crypto.randomUUID(), title: "", description: "", documentIds: [] },
    ],
  };
  dirty = true;
  renderChapters();
  get("learn-chapter-editor").lastElementChild?.querySelector("input")?.focus();
});
get("learn-form").addEventListener("input", () => {
  dirty = true;
});
function close() {
  if (busy) return;
  if (dirty && !confirm("放弃这次尚未保存的路线修改？文章正文不会受到影响。"))
    return;
  dialog.close();
}
get("learn-close").addEventListener("click", close);
dialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  close();
});
window.addEventListener("beforeunload", (event) => {
  if (dirty && dialog.open) event.preventDefault();
});
function setBusy(value: boolean) {
  busy = value;
  // Freeze the editor during a request, so a late response cannot discard newer edits.
  dialog
    .querySelectorAll<
      | HTMLInputElement
      | HTMLButtonElement
      | HTMLSelectElement
      | HTMLTextAreaElement
    >("input, button, select, textarea")
    .forEach((node) => {
      if (value) {
        node.dataset.previouslyDisabled = String(node.disabled);
        node.disabled = true;
      } else node.disabled = node.dataset.previouslyDisabled === "true";
    });
}
get("learn-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  local = {
    ...local,
    title: get<HTMLInputElement>("learn-title").value.trim(),
    description: get<HTMLTextAreaElement>("learn-description").value,
    accent: get<HTMLSelectElement>("learn-accent")
      .value as LearningInput["accent"],
  };
  const error = validateLearningPath(local);
  if (error) {
    get("learn-save-status").textContent = error;
    return;
  }
  setBusy(true);
  get("learn-save-status").textContent = "正在保存路线…";
  try {
    const saved = await requestJSON<LearningPath>(
      original ? `/api/learning-paths/${original.id}` : "/api/learning-paths",
      jsonRequest(original ? "PUT" : "POST", {
        title: local.title,
        description: local.description,
        accent: local.accent,
        chapters: local.chapters,
        ...(original ? { version: original.version } : {}),
      }),
    );
    dirty = false;
    dialog.close();
    await loadLearningPaths(saved.id);
  } catch (error) {
    get("learn-save-status").textContent =
      error instanceof Error ? error.message : "保存失败，请重试。";
    if (error instanceof ApiError && error.status === 409 && original) {
      get("learn-conflict").hidden = false;
      get<HTMLAnchorElement>("learn-latest").href = `/learn/?id=${original.id}`;
    }
  } finally {
    setBusy(false);
  }
});
get("learn-delete").addEventListener("click", () => {
  get("learn-delete-confirm").hidden = false;
});
get("learn-delete-no").addEventListener("click", () => {
  get("learn-delete-confirm").hidden = true;
});
get("learn-reload-latest").addEventListener("click", async () => {
  if (!original || busy) return;
  setBusy(true);
  try {
    const latest = await requestJSON<LearningPath>(
      `/api/learning-paths/${original.id}`,
    );
    // Restore controls before rebuilding the editor to preserve disabled bounds.
    setBusy(false);
    editLearningPath(latest);
  } catch (error) {
    get("learn-save-status").textContent =
      error instanceof Error ? error.message : "最新版本读取失败。";
  } finally {
    if (busy) setBusy(false);
  }
});
get("learn-reapply-latest").addEventListener("click", async () => {
  if (!original || busy) return;
  setBusy(true);
  let ready = false;
  try {
    original = await requestJSON<LearningPath>(
      `/api/learning-paths/${original.id}`,
    );
    ready = true;
  } catch (error) {
    get("learn-save-status").textContent =
      error instanceof Error ? error.message : "最新版本读取失败。";
  } finally {
    setBusy(false);
  }
  // A second concurrent writer is still rejected by the ordinary CAS save.
  if (ready) get<HTMLFormElement>("learn-form").requestSubmit();
});
get("learn-delete-yes").addEventListener("click", async () => {
  if (!original || busy) return;
  setBusy(true);
  try {
    await requestJSON(
      `/api/learning-paths/${original.id}`,
      jsonRequest("DELETE", { version: original.version }),
    );
    dirty = false;
    dialog.close();
    location.assign("/learn/");
  } catch (error) {
    get("learn-save-status").textContent =
      error instanceof Error ? error.message : "删除未完成。";
    if (error instanceof ApiError && error.status === 409 && original) {
      get("learn-conflict").hidden = false;
      get<HTMLAnchorElement>("learn-latest").href = `/learn/?id=${original.id}`;
    }
  } finally {
    setBusy(false);
  }
});
