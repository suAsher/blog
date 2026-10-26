import { test as authenticatedTest, expect } from "./fixtures";
import type { DocumentDetail } from "../../src/lib/documents";
import {
  ContentHarness,
  sampleContent,
  uniqueName,
  unwrap,
} from "./content-helpers";

const test = authenticatedTest.extend<{ content: ContentHarness }>({
  content: async ({ context, baseURL }, use) => {
    const content = new ContentHarness(context.request, baseURL || "");
    try {
      await use(content);
    } finally {
      await content.cleanup();
    }
  },
});

test.describe("today and quick-note workflow", () => {
  test.skip(
    !process.env.BLOG_TEST_SSH_TARGET &&
      process.env.BLOG_TEST_LOCAL_AUTH !== "1",
    "Requires the authenticated persistent document API.",
  );

  test("the Today capture creates a real private quick-note draft", async ({
    page,
    content,
  }) => {
    const source = `${uniqueName("今日随手记")}\n\n这是不会自动发布的真实草稿。`;
    await page.goto("/");
    await expect(page.locator("#today-below")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          window.document.documentElement.scrollWidth -
          window.document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    await page.locator("#today-note").fill(source);

    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/documents" &&
        response.request().method() === "POST",
    );
    await page.locator('#today-capture button[type="submit"]').click();
    const document = await unwrap<DocumentDetail>(await created);
    content.track(document);

    expect(document.kind).toBe("note");
    expect(document.status).toBe("draft");
    expect(document.source).toBe(source);
    expect(
      (await content.list({ status: "published", q: document.title })).total,
    ).toBe(0);
    await expect(page.locator("#today-capture-status")).toContainText(
      "已保存为草稿",
    );
    await expect(
      page
        .locator("#today-capture-status")
        .getByRole("link", { name: "继续编辑", exact: false }),
    ).toHaveAttribute("href", `/manage/?id=${document.id}`);
  });

  test("long draft and published titles stay inside the Today viewport", async ({
    page,
    content,
  }) => {
    const title = "🌱".repeat(200);
    await content.create({ ...sampleContent("长标题草稿"), title });
    let published = await content.create({
      ...sampleContent("长标题已发布"),
      title,
    });
    published = await content.action(published, "publish");

    await page.goto("/");
    await expect(page.locator("#today-below")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          window.document.documentElement.scrollWidth -
          window.document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  });

  test("the global shortcut retains a failed note in this tab and retries successfully", async ({
    page,
    content,
  }) => {
    const source = `${uniqueName("失败重试")}\n\n网络恢复以后再保存。`;
    let rejected = false;
    let successReachedServer = false;
    let releaseSuccess!: () => void;
    const holdSuccessfulResponse = new Promise<void>((resolve) => {
      releaseSuccess = resolve;
    });
    await page.route("**/api/documents", async (route) => {
      if (route.request().method() === "POST" && !rejected) {
        rejected = true;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            message: "暂时无法保存，请重试。",
          }),
        });
        return;
      }
      if (route.request().method() === "POST") {
        const response = await route.fetch();
        successReachedServer = true;
        await holdSuccessfulResponse;
        await route.fulfill({ response });
        return;
      }
      await route.continue();
    });

    await page.goto("/articles/");
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Alt+N" : "Control+Alt+N",
    );
    const dialog = page.getByRole("dialog", { name: /^新建随手记/ });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("随手记内容", { exact: true }).fill(source);
    await page.keyboard.press("Control+K");
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "在知识里，找一点灵感" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+Alt+N");
    await expect(dialog.getByLabel("随手记内容", { exact: true })).toHaveValue(
      source,
    );
    await dialog
      .getByLabel("随手记内容", { exact: true })
      .press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
    await expect(dialog.getByRole("status")).toContainText("暂时无法保存");
    await expect(dialog.getByLabel("随手记内容", { exact: true })).toHaveValue(
      source,
    );

    await page.reload();
    await page.keyboard.press(
      process.platform === "darwin" ? "Meta+Alt+N" : "Control+Alt+N",
    );
    await expect(dialog.getByLabel("随手记内容", { exact: true })).toHaveValue(
      source,
    );
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/documents" &&
        response.request().method() === "POST" &&
        response.status() === 201,
    );
    await dialog
      .getByLabel("随手记内容", { exact: true })
      .press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
    await expect.poll(() => successReachedServer).toBe(true);
    const nextSource = `${uniqueName("保存中的下一个想法")}\n\n不能被上一次保存清空。`;
    await dialog.getByLabel("随手记内容", { exact: true }).fill(nextSource);
    releaseSuccess();
    const document = await unwrap<DocumentDetail>(await created);
    content.track(document);
    expect(document.kind).toBe("note");
    expect(document.status).toBe("draft");
    expect(document.source).toBe(source);
    await expect(dialog.getByLabel("随手记内容", { exact: true })).toHaveValue(
      nextSource,
    );
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("asher-quick-note-draft-v1"),
      ),
    ).toBe(nextSource);
    await expect(
      dialog.getByRole("link", { name: "继续编辑", exact: false }),
    ).toHaveAttribute("href", `/manage/?id=${document.id}`);
  });

  test("new-title intent and growth metadata save into the published snapshot", async ({
    page,
    content,
  }) => {
    const requestedTitle = ` \u0007${"🌱".repeat(205)} `;
    const expectedTitle = "🌱".repeat(200);
    const created = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/documents" &&
        response.request().method() === "POST",
    );
    await page.goto(
      `/manage/?new=1&title=${encodeURIComponent(requestedTitle)}`,
    );
    let document = await unwrap<DocumentDetail>(await created);
    content.track(document);
    await expect(page.getByLabel("文档标题", { exact: true })).toHaveValue(
      expectedTitle,
    );

    const related = await content.create(sampleContent("关联文档"));
    document = await content.save(document, { related: [related.id] });
    await page.reload();
    await page.locator(".metadata-details summary").click();
    await page.getByLabel("文档类型", { exact: true }).selectOption("note");
    await page
      .getByLabel("成长状态", { exact: true })
      .selectOption("evergreen");
    await page.getByLabel("系列", { exact: true }).fill("日常观察");
    await page
      .getByLabel("Markdown 正文", { exact: true })
      .fill("## 元数据验收\n\n发布快照应保留这些字段。");
    await expect(page.locator("#save-status")).toContainText("已保存");
    await page.locator("#publish-document").click();
    await expect(page.locator("#document-status")).toContainText("已发布");

    const working = await content.get(document.id);
    const published = await content.get(document.id, true);
    for (const snapshot of [working, published]) {
      expect(snapshot.title).toBe(expectedTitle);
      expect(snapshot.kind).toBe("note");
      expect(snapshot.maturity).toBe("evergreen");
      expect(snapshot.series).toBe("日常观察");
      expect(snapshot.related).toEqual([related.id]);
    }
  });
});
