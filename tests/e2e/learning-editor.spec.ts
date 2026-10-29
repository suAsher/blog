import { test, expect } from "./fixtures";
import {
  ContentHarness,
  sampleContent,
  uniqueName,
  unwrap,
} from "./content-helpers";
import type { LearningPath } from "../../src/lib/learning-paths";

test("learning route editor saves chapters and published/draft lessons, preserves conflicts and deletes only the route", async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("https:"),
    "Requires the private content service.",
  );
  const content = new ContentHarness(context.request, baseURL!);
  let id = "";
  const origin = new URL(baseURL!).origin;
  try {
    const published = await content.action(
      await content.create(sampleContent("route lesson")),
      "publish",
    );
    const draft = await content.create(sampleContent("route draft"));
    await page.goto("/learn/");
    await expect(page.locator("#learn-status")).not.toContainText("正在");
    await page.getByRole("button", { name: "新建方向", exact: false }).click();
    const title = uniqueName("course route");
    await page.getByLabel("方向名称", { exact: true }).fill(title);
    await page
      .getByLabel("方向说明", { exact: true })
      .fill("From first principles to working knowledge");
    await page.getByRole("button", { name: "添加章节", exact: false }).click();
    await page
      .getByLabel("章节标题", { exact: true })
      .fill("第一章 · 从零开始");
    await page
      .getByLabel("章节导读", { exact: true })
      .fill("A small, coherent first step");
    await page
      .getByLabel("加入已有文章或草稿", { exact: true })
      .selectOption(published.id);
    await page
      .getByLabel("加入已有文章或草稿", { exact: true })
      .selectOption(draft.id);
    await page.getByRole("button", { name: "保存路线", exact: true }).click();
    await expect(page.locator("#learn-dialog")).not.toBeVisible();
    await expect(page.locator("#learn-detail h2")).toHaveText(title);
    id = new URL(page.url()).searchParams.get("id") || "";
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    await page.reload();
    await expect(page.locator(".learn-chapter")).toContainText(published.title);
    await expect(page.locator(".learn-chapter")).toContainText(draft.title);
    await expect(page.locator(".learn-chapter")).toContainText("草稿");
    await expect(page.locator(".learn-completion")).toHaveText("0%");
    await expect(page.locator(".learn-lesson-body a").first()).toHaveAttribute(
      "href",
      `/articles/${published.id}/?path=${id}`,
    );
    await page
      .getByLabel("我的技术方向", { exact: false })
      .fill("no-matching-path-93849");
    await expect(page.locator(".learn-empty-filter")).toBeVisible();
    await page.getByLabel("我的技术方向", { exact: false }).fill("");
    await page.getByRole("button", { name: "整理章节", exact: true }).click();
    await page.getByLabel("方向名称", { exact: true }).fill(`${title} local`);
    const saved = await unwrap<LearningPath>(
      await context.request.get(`/api/learning-paths/${id}`),
    );
    await unwrap(
      await context.request.put(`/api/learning-paths/${id}`, {
        headers: { Origin: origin },
        data: {
          title: `${title} remote`,
          description: saved.description,
          accent: saved.accent,
          chapters: saved.chapters,
          version: saved.version,
        },
      }),
    );
    await page.getByRole("button", { name: "保存路线", exact: true }).click();
    await expect(page.locator("#learn-conflict")).toBeVisible();
    await expect(page.getByLabel("方向名称", { exact: true })).toHaveValue(
      `${title} local`,
    );
    await page
      .getByRole("button", {
        name: "用当前编辑替换最新路线并保存",
        exact: true,
      })
      .click();
    await expect(page.locator("#learn-dialog")).not.toBeVisible();
    await page.reload();
    await expect(page.locator("#learn-detail h2")).toHaveText(`${title} local`);
    await page.getByRole("button", { name: "整理章节", exact: true }).click();
    await page.getByRole("button", { name: "删除路线", exact: true }).click();
    await page
      .getByRole("button", { name: "确认删除路线", exact: true })
      .click();
    await expect(page).toHaveURL(/\/learn\/$/);
    expect(
      (await context.request.get(`/api/learning-paths/${id}`)).status(),
    ).toBe(404);
    expect(
      (await context.request.get(`/api/documents/${published.id}`)).ok(),
    ).toBe(true);
    id = "";
  } finally {
    if (id) {
      const response = await context.request.get(`/api/learning-paths/${id}`);
      if (response.ok()) {
        const current = await unwrap<LearningPath>(response);
        await context.request.delete(`/api/learning-paths/${id}`, {
          headers: { Origin: origin },
          data: { version: current.version },
        });
      }
    }
    await content.cleanup();
  }
});

test("an empty learning collection invites creation and has keyboard accessible dialog controls", async ({
  page,
  baseURL,
}) => {
  test.skip(!baseURL?.startsWith("https:"), "Requires private API.");
  await page.route("**/api/learning-paths", async (route) => {
    if (route.request().method() === "GET")
      await route.fulfill({ json: { ok: true, data: { paths: [] } } });
    else await route.continue();
  });
  await page.goto("/learn/");
  await expect(page.locator("#learn-empty")).toBeVisible();
  await page
    .getByRole("button", { name: "创建第一条路线", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("方向名称", { exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#learn-dialog")).not.toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});
