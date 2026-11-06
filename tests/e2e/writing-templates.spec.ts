import { test, expect } from "./fixtures";
import { ContentHarness, sampleContent } from "./content-helpers";

test("a writing structure creates an editable new draft without replacing existing work", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  try {
    const original = await content.create(
      sampleContent("template original", "## 原始记录\n\n保留这份观察。"),
    );
    await page.goto(`/manage/?id=${original.id}`);
    await expect(page.locator("#document-source")).toHaveValue(original.source);
    await page.getByRole("button", { name: "从模板新建", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "给思考一个起点。",
      exact: true,
    });
    await dialog.getByRole("radio", { name: /排错记录/ }).check();
    await expect(dialog.locator("#writing-template-preview")).toContainText(
      "事实与假设",
    );
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.locator("#document-source")).toHaveValue(original.source);

    await page
      .locator("#document-source")
      .fill(original.source + "\n\n新观察也需要保留。");
    await page.getByRole("button", { name: "从模板新建", exact: true }).click();
    await dialog.getByRole("radio", { name: /循序教程/ }).check();
    const created = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/documents") &&
        response.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "创建这份草稿", exact: true })
      .click();
    const result = (await (await created).json()).data;
    content.track(result);
    await expect(dialog).not.toBeVisible();
    await expect(page.locator("#document-source")).toHaveValue(/写作骨架/);
    await expect(page.locator("#document-source")).toHaveValue(/验证结果/);
    expect((await content.get(original.id)).source).toContain(
      "新观察也需要保留",
    );
    expect(result.status).toBe("draft");
    expect(result.id).not.toBe(original.id);

    const rewritten = "## 我实际验证的结果\n\n模板里的每个段落都可以替换。";
    await page.locator("#document-source").fill(rewritten);
    await page.locator("#save-document").click();
    await expect(page.locator("#save-status")).toHaveText("所有修改已保存");
    await page.reload();
    await expect(page.locator("#document-source")).toHaveValue(rewritten);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await content.cleanup();
  }
});

test("a configured teaching model previews safely and is inserted at the original cursor", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  try {
    const original = await content.create(
      sampleContent(
        "configured experiment",
        "## 我的推演\n\n前面的解释。\n\n后面的结论。",
      ),
    );
    await page.goto(`/manage/?id=${original.id}`);
    const source = page.locator("#document-source");
    await expect(source).toHaveValue(original.source);
    await source.evaluate((node: HTMLTextAreaElement) => {
      const at = node.value.indexOf("后面的结论");
      node.setSelectionRange(at, at);
    });
    await page.getByRole("button", { name: "◇ 教学实验", exact: true }).click();
    await expect(page.locator("#explorer-config-dialog")).toHaveAccessibleName("让读者动手理解。");
    const dialog = page.getByRole("dialog", {
      name: "让读者动手理解。",
      exact: true,
    });
    await dialog
      .getByLabel("教学模型", { exact: true })
      .selectOption("network");
    const title = '<img src=x onerror="window.templateUnsafe=1">';
    await dialog.getByLabel(/实验标题/).fill(title);
    await expect(
      dialog.locator(".explore-widget figcaption strong"),
    ).toHaveText(title);
    await expect(dialog.locator(".explore-widget img")).toHaveCount(0);
    expect(
      await page.evaluate(() => Reflect.get(window, "templateUnsafe")),
    ).toBeUndefined();
    await expect(dialog.locator(".explore-body select")).toBeVisible();
    const bounds = await dialog.evaluate((node) => ({
      top: node.getBoundingClientRect().top,
      bottom: node.getBoundingClientRect().bottom,
      viewport: innerHeight,
    }));
    expect(bounds.top).toBeGreaterThanOrEqual(0);
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewport);
    await dialog
      .getByRole("button", { name: "插入到光标位置", exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    await expect(source).toBeFocused();
    const markdown = await source.inputValue();
    expect(markdown.indexOf("前面的解释")).toBeLessThan(
      markdown.indexOf("```explore"),
    );
    expect(markdown.indexOf("```explore")).toBeLessThan(
      markdown.indexOf("后面的结论"),
    );
    expect(markdown).toContain('"kind": "network"');
    await page.locator("#save-document").click();
    await expect(page.locator("#save-status")).toHaveText("所有修改已保存");
    await page.getByRole("button", { name: "预览", exact: true }).click();
    await expect(
      page.locator("#document-preview .explore-widget figcaption strong"),
    ).toHaveText(title);
    expect((await content.get(original.id)).source).toBe(markdown);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await content.cleanup();
  }
});

test("failed saves keep existing content and the template chooser available for retry", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  try {
    const original = await content.create(
      sampleContent("template save failure"),
    );
    await page.goto(`/manage/?id=${original.id}`);
    await expect(page.locator("#document-source")).toHaveValue(original.source);
    await page.route(`**/api/documents/${original.id}`, (route) => {
      if (route.request().method() === "PUT")
        return route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ ok: false, error: "本次测试模拟保存失败。" }),
        });
      return route.continue();
    });
    const pending = "## 这段修改不能丢失\n\n即使创建模板时保存失败。";
    await page.locator("#document-source").fill(pending);
    await page.getByRole("button", { name: "从模板新建", exact: true }).click();
    const dialog = page.locator("#writing-template-dialog");
    await dialog
      .getByRole("button", { name: "创建这份草稿", exact: true })
      .click();
    await expect(dialog.locator("#writing-template-status")).toContainText(
      "草稿没有创建",
    );
    await expect(page).toHaveURL(new RegExp(`id=${original.id}$`));
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.locator("#document-source")).toHaveValue(pending);
    await page.unroute(`**/api/documents/${original.id}`);
    await page.locator("#save-document").click();
    await expect(page.locator("#save-status")).toHaveText("所有修改已保存");
    expect((await content.get(original.id)).source).toBe(pending);
  } finally {
    await content.cleanup();
  }
});
