import {
  inboxStages,
  type InboxDocument,
  type InboxData,
  type InboxFilter,
  type InboxView,
} from "../../lib/inbox";
import { button, element, get } from "../workspaces/dom";

function link(text: string, href: string, className = "") {
  const anchor = element("a", className, text);
  anchor.href = href;
  return anchor;
}

export function renderInboxDocuments(
  documents: InboxDocument[],
  selected: string[],
  change: (id: string, checked: boolean) => void,
) {
  get("inbox-results").replaceChildren(
    ...documents.map((doc) => {
      const item = element("article", "inbox-item");
      item.dataset.id = doc.id;
      const checkbox = element("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected.includes(doc.id);
      checkbox.setAttribute("aria-label", `选择：${doc.title}`);
      checkbox.addEventListener("change", () =>
        change(doc.id, checkbox.checked),
      );
      const main = element("div", "inbox-item-main");
      const meta = element("div", "inbox-item-meta");
      const stage = element("span", "inbox-stage", inboxStages[doc.stage]);
      stage.dataset.stage = doc.stage;
      meta.append(
        stage,
        element("span", "", doc.status === "published" ? "已发布" : "草稿"),
      );
      if (doc.hasUnpublishedChanges)
        meta.append(element("span", "", "有未发布修改"));
      const heading = element("h2");
      heading.append(
        link(doc.title, `/manage/?id=${encodeURIComponent(doc.id)}`),
      );
      main.append(meta, heading);
      if (doc.description)
        main.append(element("p", "inbox-item-description", doc.description));
      const details = element("div", "inbox-item-details");
      doc.tags.forEach((tag) =>
        details.append(element("span", "inbox-tag", tag)),
      );
      if (doc.routes.length)
        doc.routes.forEach((route) => {
          details.append(
            link(
              `↳ ${route.title}`,
              `/learn/?id=${encodeURIComponent(route.id)}`,
              "inbox-route-link",
            ),
          );
        });
      else details.append(element("span", "inbox-unassigned", "尚未归入路线"));
      main.append(details);
      const actions = element("div", "inbox-item-actions");
      const date = element(
        "time",
        "",
        doc.updatedAt.slice(0, 10).replaceAll("-", "."),
      );
      date.dateTime = doc.updatedAt;
      actions.append(
        date,
        link(
          "打开整理 ↗",
          `/manage/?id=${encodeURIComponent(doc.id)}`,
          "quiet-link",
        ),
      );
      if (doc.status === "published") {
        actions.append(
          link(
            "阅读发布版",
            `/articles/${encodeURIComponent(doc.id)}/`,
            "quiet-link",
          ),
        );
      }
      item.append(checkbox, main, actions);
      return item;
    }),
  );
}

function options(
  id: string,
  values: { value: string; label: string }[],
  current: string,
) {
  const select = get<HTMLSelectElement>(id);
  select.replaceChildren(
    ...values.map((value) => {
      const option = element("option", "", value.label);
      option.value = value.value;
      return option;
    }),
  );
  select.value = current;
}

export function renderInboxFilters(data: InboxData, filter: InboxFilter) {
  const tags = data.tags.map((tag) => ({
    value: tag.name,
    label: `${tag.name} · ${tag.count}`,
  }));
  if (filter.tag && !data.tags.some((tag) => tag.name === filter.tag)) {
    tags.push({ value: filter.tag, label: `${filter.tag} · 暂无资料` });
  }
  options("inbox-tag", [{ value: "", label: "全部标签" }, ...tags], filter.tag);
  const routes = data.routes.map((route) => ({
    value: route.id,
    label: route.title,
  }));
  const missingRoute = Boolean(
    filter.routeId && !data.routes.some((route) => route.id === filter.routeId),
  );
  if (missingRoute)
    routes.push({ value: filter.routeId, label: "已删除的路线" });
  options(
    "inbox-route",
    [{ value: "", label: "全部路线" }, ...routes],
    filter.routeId,
  );
  get("inbox-route-warning").hidden = !missingRoute;
  get<HTMLInputElement>("inbox-search").value = filter.q;
  document
    .querySelectorAll<HTMLButtonElement>("#inbox-tabs [data-view]")
    .forEach((tab) => {
      const view = tab.dataset.view as keyof InboxData["counts"];
      tab.setAttribute("aria-pressed", String(view === filter.view));
      tab.querySelector("span")!.textContent = String(data.counts[view]);
    });
}

export function renderInboxViews(
  views: InboxView[],
  select: (view: InboxView) => void,
  remove: (id: string) => void,
) {
  const container = get("inbox-saved-views");
  if (!views.length) {
    container.replaceChildren(
      element(
        "p",
        "inbox-fine-print",
        "保存常用的标签、路线与整理进度，下次一键回到这里。",
      ),
    );
    return;
  }
  container.replaceChildren(
    ...views.map((view) => {
      const group = element("div", "inbox-saved-view");
      const choose = button(view.name, () => select(view));
      choose.dataset.savedView = view.id;
      const deleteButton = button(
        "×",
        () => remove(view.id),
        `删除筛选视图：${view.name}`,
      );
      deleteButton.dataset.deleteView = view.id;
      group.append(choose, deleteButton);
      return group;
    }),
  );
}
