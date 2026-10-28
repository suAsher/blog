import { test, expect } from "./fixtures";
import {
  ContentHarness,
  sampleContent,
  unwrap,
  uniqueName,
} from "./content-helpers";
import type { Workspace } from "../../src/lib/workspaces";

test("topic workspace saves a reading path, compares published snapshots, and resolves conflicts explicitly", async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("https:"),
    "Requires the private content service.",
  );
  const content = new ContentHarness(context.request, baseURL!);
  const origin = new URL(baseURL!).origin;
  let workspaceId = "";
  try {
    let first = await content.create(
      sampleContent(
        "workspace first",
        "## Published evidence\n\nPUBLISHED SNAPSHOT ONLY",
      ),
    );
    first = await content.action(first, "publish");
    const publishedTitle = first.title;
    first = await content.save(first, {
      title: uniqueName("private working title"),
      source: "## Working changes\n\nPRIVATE WORKING TEXT",
    });
    const second = await content.action(
      await content.create(
        sampleContent(
          "workspace second",
          "## A second perspective\n\nSecond published body",
        ),
      ),
      "publish",
    );
    const draft = await content.create(
      sampleContent("workspace draft", "DRAFT MUST NOT APPEAR IN COMPARISON"),
    );
    await page.goto("/workspaces/");
    await page.getByRole("button", { name: "新建主题", exact: true }).click();
    const title = uniqueName("Topic");
    await page.getByLabel("主题标题", { exact: true }).fill(title);
    await page
      .getByLabel("主题说明", { exact: true })
      .fill("A focused research trail");
    for (const document of [
      { ...first, title: publishedTitle },
      second,
      draft,
    ]) {
      await page.getByLabel("搜索可加入的文档").fill(document.title);
      await page.locator(`[data-add-document="${document.id}"]`).click();
    }
    await page
      .getByRole("button", { name: `上移 ${second.title}`, exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: `下移 ${second.title}`, exact: true }),
    ).toBeFocused();
    await page.getByLabel("新问题").fill("What connects these ideas?");
    await page.getByRole("button", { name: "添加问题", exact: true }).click();
    await page.getByLabel("完成 What connects these ideas?").check();
    await page.getByRole("button", { name: "保存主题", exact: true }).click();
    await expect(page.locator("#ws-status")).toContainText("已保存");
    workspaceId = new URL(page.url()).searchParams.get("id") || "";
    expect(workspaceId).toMatch(/^[a-f0-9]{32}$/);
    await page.getByRole("tab", { name: "文章对照" }).click();
    await expect(page.locator("#ws-comparison")).toContainText(
      "PUBLISHED SNAPSHOT ONLY",
    );
    await expect(page.locator("#ws-comparison")).toContainText(
      "Second published body",
    );
    await expect(page.locator("#ws-comparison")).not.toContainText(
      "PRIVATE WORKING TEXT",
    );
    await expect(page.locator("#ws-comparison")).not.toContainText(
      "DRAFT MUST NOT APPEAR",
    );
    await expect(page.locator("#ws-compare-left option")).not.toContainText([
      draft.title,
    ]);
    await page.getByRole("tab", { name: "连接画布" }).click();
    const node = page.locator(".ws-canvas-node").first();
    await node.focus();
    await page.keyboard.press("ArrowRight");
    await page.getByRole("button", { name: "保存主题", exact: true }).click();
    await expect(page.locator("#ws-status")).toContainText("已保存");
    const saved = await unwrap<Workspace>(
      await context.request.get(`/api/workspaces/${workspaceId}`),
    );
    expect(saved.documentIds).toEqual([second.id, first.id, draft.id]);
    expect(saved.questions[0].done).toBe(true);
    expect(saved.positions.length).toBeGreaterThan(0);
    await page.getByLabel("主题标题", { exact: true }).fill(`${title} local`);
    await unwrap<Workspace>(
      await context.request.put(`/api/workspaces/${workspaceId}`, {
        headers: { Origin: origin },
        data: {
          title: `${title} remote`,
          description: saved.description,
          documentIds: saved.documentIds,
          questions: saved.questions,
          positions: saved.positions,
          version: saved.version,
        },
      }),
    );
    await page.getByRole("button", { name: "保存主题", exact: true }).click();
    await expect(page.locator("#ws-conflict")).toBeVisible();
    await expect(page.getByLabel("主题标题", { exact: true })).toHaveValue(
      `${title} local`,
    );
    await page
      .getByRole("button", { name: "将本地编辑应用到新版本", exact: true })
      .click();
    await expect(page.locator("#ws-status")).toContainText("已保存");
    await page.reload();
    await expect(page.getByLabel("主题标题", { exact: true })).toHaveValue(
      `${title} local`,
    );
    await expect(page.locator("#ws-reading-path")).toContainText("草稿");
  } finally {
    if (workspaceId) {
      const response = await context.request.get(
        `/api/workspaces/${workspaceId}`,
      );
      if (response.ok()) {
        const current = await unwrap<Workspace>(response);
        expect(
          (
            await context.request.delete(`/api/workspaces/${workspaceId}`, {
              headers: { Origin: origin },
              data: { version: current.version },
            })
          ).ok(),
        ).toBe(true);
      }
    }
    await content.cleanup();
  }
});

test("unavailable workspace references stay visible until explicitly removed", async ({
  page,
  context,
  baseURL,
}) => {
  test.skip(
    !baseURL?.startsWith("https:"),
    "Requires the private content service.",
  );
  const content = new ContentHarness(context.request, baseURL!);
  const origin = new URL(baseURL!).origin;
  let workspaceId = "";
  try {
    const document = await content.create(
      sampleContent("stale workspace reference"),
    );
    const workspace = await unwrap<Workspace>(
      await context.request.post("/api/workspaces", {
        headers: { Origin: origin },
        data: {
          title: uniqueName("stale topic"),
          description: "Preserve unavailable references",
          documentIds: [document.id],
          questions: [],
          positions: [],
        },
      }),
    );
    workspaceId = workspace.id;
    await content.action(document, "trash");
    await page.goto(`/workspaces/?id=${workspace.id}`);
    await expect(page.locator("#ws-reading-path")).toContainText(
      "不可用的文档",
    );
    await expect(page.locator("#ws-reading-path")).toContainText("引用保留");
    await page.getByRole("tab", { name: "文章对照" }).click();
    await expect(page.locator("#ws-comparison")).toContainText(
      "加入至少两篇已发布文章",
    );
    await page.getByRole("tab", { name: "阅读路径" }).click();
    await page
      .getByLabel("主题标题", { exact: true })
      .fill("Local changes remain until removal");
    await page.getByRole("button", { name: "保存主题", exact: true }).click();
    await expect(page.locator("#ws-status")).toContainText("已保存");
    await expect(page.getByLabel("主题标题", { exact: true })).toHaveValue(
      "Local changes remain until removal",
    );
    await expect(
      page.locator("#ws-reading-path li[data-document-id]"),
    ).toHaveCount(1);
    const retained = await unwrap<Workspace>(
      await context.request.get(`/api/workspaces/${workspace.id}`),
    );
    expect(retained.documentIds).toEqual([document.id]);
    expect(retained.title).toBe("Local changes remain until removal");
    await page
      .getByRole("button", { name: "移除 不可用的文档 1", exact: true })
      .click();
    await page.getByRole("button", { name: "保存主题", exact: true }).click();
    await expect(page.locator("#ws-status")).toContainText("已保存");
    const saved = await unwrap<Workspace>(
      await context.request.get(`/api/workspaces/${workspace.id}`),
    );
    expect(saved.documentIds).toEqual([]);
  } finally {
    if (workspaceId) {
      const response = await context.request.get(
        `/api/workspaces/${workspaceId}`,
      );
      if (response.ok()) {
        const workspace = await unwrap<Workspace>(response);
        expect(
          (
            await context.request.delete(`/api/workspaces/${workspaceId}`, {
              headers: { Origin: origin },
              data: { version: workspace.version },
            })
          ).ok(),
        ).toBe(true);
      }
    }
    await content.cleanup();
  }
});
