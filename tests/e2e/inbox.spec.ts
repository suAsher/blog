import { test, expect } from "./fixtures";
import {
  ContentHarness,
  sampleContent,
  uniqueName,
  unwrap,
} from "./content-helpers";
import type { InboxData } from "../../src/lib/inbox";
import type { LearningPath } from "../../src/lib/learning-paths";

test("inbox organizes imported documents without changing source, versions, or publication", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  try {
    const title = uniqueName("收件箱导入");
    const report = await content.import([
      {
        path: `${title}.md`,
        buffer: Buffer.from(`# ${title}\n\n独立的正文标记。`),
      },
    ]);
    const imported = await content.get(report.imported[0].id);
    await page.goto(`/inbox/?q=${encodeURIComponent(title)}`);
    const row = page.locator(`.inbox-item[data-id="${imported.id}"]`);
    await expect(row).toContainText("待整理");
    await row.getByRole("checkbox").check();
    await page.locator("#inbox-apply").click();
    await expect(page.locator("#inbox-status")).toContainText("整理进度已保存");
    await expect(page.locator("#inbox-empty")).toBeVisible();
    await page.locator('[data-view="unverified"]').click();
    await expect(row).toContainText("待验证");
    await row.getByRole("checkbox").check();
    await page.locator("#inbox-stage").selectOption("verified");
    await page.locator("#inbox-apply").click();
    await expect(page.locator("#inbox-status")).toContainText("整理进度已保存");
    await page.locator('[data-view="verified"]').click();
    await expect(row).toContainText("已验证");
    const current = await content.get(imported.id);
    expect(current.source).toBe(imported.source);
    expect(current.version).toBe(imported.version);
    expect(current.status).toBe("draft");
    expect((await content.list({ q: title })).documents).toEqual([]);
    await expect(row.getByRole("link", { name: "阅读发布版" })).toHaveCount(0);
    await row.getByRole("link", { name: "打开整理 ↗" }).click();
    await expect(page).toHaveURL(new RegExp(`/manage/\\?id=${imported.id}`));
    await page.goBack();
    await expect(row).toContainText("已验证");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await content.cleanup();
  }
});

test("inbox preserves selection on CAS conflicts and requires another explicit save", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  try {
    const doc = await content.create(sampleContent("收件箱冲突"));
    await page.goto(`/inbox/?view=all&q=${encodeURIComponent(doc.title)}`);
    const row = page.locator(`.inbox-item[data-id="${doc.id}"]`);
    await row.getByRole("checkbox").check();
    const latest = await unwrap<InboxData>(
      await context.request.get("/api/inbox?view=all"),
    );
    await unwrap(
      await context.request.put("/api/inbox/batch", {
        headers: { Origin: content.origin },
        data: {
          version: latest.version,
          documentIds: [doc.id],
          stage: "verified",
        },
      }),
    );
    await page.locator("#inbox-apply").click();
    await expect(page.locator("#inbox-status")).toContainText("其他页面已更新");
    await expect(row.getByRole("checkbox")).toBeChecked();
    await expect(page.locator("#inbox-apply")).toBeDisabled();
    await page.locator("#inbox-conflict-reload").click();
    await expect(row).toContainText("已验证");
    await expect(row.getByRole("checkbox")).toBeChecked();
    await expect(page.locator("#inbox-apply")).toBeEnabled();
    const unchanged = await unwrap<InboxData>(
      await context.request.get(
        `/api/inbox?view=all&q=${encodeURIComponent(doc.title)}`,
      ),
    );
    expect(unchanged.documents[0].stage).toBe("verified");
    await page.locator("#inbox-apply").click();
    await expect(page.locator("#inbox-status")).toContainText("整理进度已保存");
    await expect(row).toContainText("待验证");
  } finally {
    await content.cleanup();
  }
});

test("saved inbox filters sync and preserve a deleted route without widening results", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  let routeId = "";
  let viewId = "";
  try {
    const doc = await content.create(sampleContent("筛选保存"));
    const route = await unwrap<LearningPath>(
      await context.request.post("/api/learning-paths", {
        headers: { Origin: content.origin },
        data: {
          title: uniqueName("收件路线"),
          description: "",
          accent: "mint",
          chapters: [
            {
              id: "start",
              title: "开始",
              description: "",
              documentIds: [doc.id],
            },
          ],
        },
      }),
    );
    routeId = route.id;
    await page.goto(
      `/inbox/?view=all&q=${encodeURIComponent(doc.title)}&routeId=${route.id}`,
    );
    await expect(
      page.locator(`.inbox-item[data-id="${doc.id}"]`),
    ).toBeVisible();
    await expect(page.locator(".inbox-route-link")).toHaveAttribute(
      "href",
      `/learn/?id=${route.id}`,
    );
    await page.locator(".inbox-views summary").click();
    const viewName = uniqueName("已存筛选");
    await page.locator("#inbox-view-name").fill(viewName);
    await page.locator("#inbox-save-view").click();
    await expect(page.locator("#inbox-status")).toContainText("筛选视图已保存");
    const result = await unwrap<InboxData>(
      await context.request.get("/api/inbox"),
    );
    viewId = result.views.find((view) => view.name === viewName)!.id;
    await unwrap(
      await context.request.delete(`/api/learning-paths/${route.id}`, {
        headers: { Origin: content.origin },
        data: { version: route.version },
      }),
    );
    routeId = "";
    await page.goto("/inbox/");
    await page.locator(".inbox-views summary").click();
    await page.locator(`[data-saved-view="${viewId}"]`).click();
    await expect(page.locator("#inbox-route-warning")).toBeVisible();
    await expect(page.locator("#inbox-route")).toHaveValue(route.id);
    await expect(page.locator("#inbox-empty")).toBeVisible();
    await page.locator(`[data-delete-view="${viewId}"]`).click();
    await expect(page.locator("#inbox-status")).toContainText("筛选视图已删除");
    viewId = "";
  } finally {
    if (viewId) {
      const result = await unwrap<InboxData>(
        await context.request.get("/api/inbox"),
      );
      await context.request.put("/api/inbox/views", {
        headers: { Origin: content.origin },
        data: {
          version: result.version,
          views: result.views.filter((view) => view.id !== viewId),
        },
      });
    }
    if (routeId) {
      const route = await unwrap<LearningPath>(
        await context.request.get(`/api/learning-paths/${routeId}`),
      );
      await context.request.delete(`/api/learning-paths/${routeId}`, {
        headers: { Origin: content.origin },
        data: { version: route.version },
      });
    }
    await content.cleanup();
  }
});

test("inbox search, empty state and retry keep user input and never execute document HTML", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  try {
    const doc = await content.create({
      ...sampleContent("收件箱重试"),
      description: "<img src=x onerror=alert(1)>",
      tags: ["InboxQA"],
    });
    let failRead = true;
    let failWrite = true;
    await page.route("**/api/inbox?*", async (route) => {
      if (failRead) {
        failRead = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, message: "模拟读取失败" }),
        });
      } else await route.continue();
    });
    await page.route("**/api/inbox/batch", async (route) => {
      if (failWrite) {
        failWrite = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, message: "模拟保存失败" }),
        });
      } else await route.continue();
    });
    await page.goto(`/inbox/?view=all&q=${encodeURIComponent(doc.title)}`);
    await expect(page.locator("#inbox-status")).toContainText("模拟读取失败");
    await page.locator("#inbox-retry").click();
    const row = page.locator(`.inbox-item[data-id="${doc.id}"]`);
    await expect(row).toContainText("<img src=x onerror=alert(1)>");
    await expect(row.locator("img")).toHaveCount(0);
    await row.getByRole("checkbox").check();
    await page.locator("#inbox-apply").click();
    await expect(page.locator("#inbox-status")).toContainText("模拟保存失败");
    await expect(row.getByRole("checkbox")).toBeChecked();
    await page.locator("#inbox-apply").click();
    await expect(page.locator("#inbox-status")).toContainText("整理进度已保存");
    await row.getByRole("checkbox").check();
    await page.locator("#inbox-tag").selectOption("InboxQA");
    await page.locator("#inbox-search").fill("不存在" + uniqueName("empty"));
    failRead = true;
    await page.locator("#inbox-search").press("Enter");
    await expect(page.locator("#inbox-status")).toContainText("模拟读取失败");
    await expect(row.getByRole("checkbox")).toBeDisabled();
    await expect(page.locator("#inbox-apply")).toBeDisabled();
    await expect(page.locator("#inbox-save-view")).toBeDisabled();
    await page.locator("#inbox-retry").click();
    await expect(page.locator("#inbox-empty")).toBeVisible();
    await page.locator("#inbox-clear-filter").click();
    await expect(row).toBeVisible();
    await expect(page.locator("#inbox-search")).toHaveValue("");
    await expect(page.locator("#inbox-tag")).toHaveValue("");
  } finally {
    await content.cleanup();
  }
});

test("inbox pagination retains cross-page selection and restores the current page after navigation", async ({
  page,
}) => {
  const documents = Array.from({ length: 51 }, (_, index) => ({
    id: index.toString(16).padStart(32, "0"),
    title: `分页资料 ${index + 1}`,
    description: "",
    tags: [],
    stage: "pending",
    status: "draft",
    routes: [],
    updatedAt: "2026-11-01T00:00:00Z",
    hasUnpublishedChanges: false,
  }));
  await page.route("**/api/inbox?*", async (route) => {
    const offset =
      Number(new URL(route.request().url()).searchParams.get("offset")) || 0;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          version: 0,
          documents: documents.slice(offset, offset + 50),
          total: 51,
          counts: {
            all: 51,
            pending: 51,
            unassigned: 51,
            unverified: 0,
            verified: 0,
          },
          tags: [],
          routes: [],
          views: [],
        },
      }),
    });
  });
  await page.goto("/inbox/?view=all");
  await expect(page.locator(".inbox-item")).toHaveCount(50);
  await page.locator(".inbox-item").first().getByRole("checkbox").check();
  await page.locator("#inbox-next").click();
  await expect(page.locator(".inbox-item")).toHaveCount(1);
  await expect(page).toHaveURL(/offset=50/);
  await page.locator(".inbox-item").getByRole("checkbox").check();
  await expect(page.locator("#inbox-selected-count")).toContainText(
    "已选择 2 篇",
  );
  await page.locator("#inbox-previous").click();
  await expect(
    page.locator(".inbox-item").first().getByRole("checkbox"),
  ).toBeChecked();
  await page.locator("#inbox-next").click();
  await expect(page.locator("#inbox-page-number")).toHaveText("2 / 2");
  await page.reload();
  await expect(page.locator("#inbox-page-number")).toHaveText("2 / 2");
  await expect(page.locator("#inbox-next")).toBeDisabled();
  await expect(page.locator("#inbox-previous")).toBeEnabled();
});
