import { test as authenticatedTest, expect } from "./fixtures";
import { ContentHarness, sampleContent, unwrap } from "./content-helpers";

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

test.describe("knowledge links", () => {
  test.skip(
    !process.env.BLOG_TEST_SSH_TARGET &&
      process.env.BLOG_TEST_LOCAL_AUTH !== "1",
    "Requires the private document API.",
  );

  test("published wiki links and backlinks never expose a draft snapshot", async ({
    page,
    context,
    content,
  }) => {
    let target = await content.create(sampleContent("链接目标"));
    target = await content.action(target, "publish");
    let source = await content.create(
      sampleContent(
        "链接来源",
        `## 连接\n\n[[${target.id}|${target.title}]]\n\n[[尚不存在的知识节点]]`,
      ),
    );
    source = await content.action(source, "publish");
    await content.save(target, { title: `${target.title} 草稿改名` });

    await page.goto(`/articles/${source.id}/`);
    await expect(
      page.locator("#article-body").getByRole("link", {
        name: target.title,
        exact: true,
      }),
    ).toHaveAttribute("href", `/articles/${target.id}/`);
    await expect(page.locator("#article-body .wiki-link--missing")).toHaveAttribute(
      "href",
      /\/manage\/\?new=1&title=/,
    );
    await expect(page.locator("#article-body .wiki-link--missing")).toHaveAccessibleName(
      /尚不存在的知识节点.*待创建/,
    );

    await page.goto(`/articles/${target.id}/`);
    const backlinks = page.getByRole("region", { name: "反向链接" });
    await expect(backlinks.getByRole("link", { name: source.title })).toBeVisible();
    await expect(backlinks).not.toContainText("草稿改名");

    const links = await unwrap<{
      backlinks: { id: string; title: string }[];
    }>(await context.request.get(`/api/documents/${target.id}/links`));
    expect(links.backlinks).toContainEqual({ id: source.id, title: source.title });

    await page.route(`**/api/documents/${target.id}/links?view=published`, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, message: "temporary" }),
      }),
    );
    await page.reload();
    await expect(backlinks).toContainText("连接暂时无法读取");
    await expect(page.locator("#backlinks-retry")).toBeVisible();
    await page.unroute(`**/api/documents/${target.id}/links?view=published`);
    await page.locator("#backlinks-retry").click();
    await expect(backlinks.getByRole("link", { name: source.title })).toBeVisible();
  });

  test("wiki completion supports IME-safe keyboard selection and stable insertion", async ({
    page,
    content,
  }) => {
    const target = await content.create(sampleContent("补全目标"));
    const document = await content.create(sampleContent("补全编辑器", ""));
    await page.goto(`/manage/?id=${document.id}`);
    const source = page.getByLabel("Markdown 正文", { exact: true });
    await source.fill("向上选择 [[");
    const listbox = page.getByRole("listbox", { name: "知识链接建议" });
    await expect(listbox).toBeVisible();
    const lastOption = listbox.getByRole("option").last();
    const lastId = (await lastOption.getAttribute("id"))?.replace("wiki-target-", "");
    expect(lastId).toMatch(/^[a-f0-9]{32}$/);
    await source.press("ArrowUp");
    await source.press("Enter");
    await expect(source).toHaveValue(new RegExp(`\\[\\[${lastId}\\|`));

    await source.fill(`连接 [[${target.title}`);
    await expect(listbox).toBeVisible();
    await source.press("ArrowDown");
    await source.press("Enter");
    await expect(source).toHaveValue(
      `连接 [[${target.id}|${target.title}]]`,
    );
    await expect(page.locator("#save-status")).toContainText("已保存");

    await source.fill(`再次连接 [[${target.title}`);
    await expect(listbox).toBeVisible();
    await listbox.getByRole("option", { name: new RegExp(target.title) }).click();
    await expect(source).toHaveValue(`再次连接 [[${target.id}|${target.title}]]`);

    await source.fill("`[[补全目标`");
    await expect(listbox).toBeHidden();
  });

  test("related documents are selected by title and saved without raw-id entry", async ({
    page,
    content,
  }) => {
    const related = await content.create(sampleContent("相关目标"));
    const document = await content.create(sampleContent("相关选择器"));
    await page.goto(`/manage/?id=${document.id}`);
    await page.locator(".metadata-details summary").click();
    const picker = page.getByRole("combobox", { name: "搜索相关文档" });
    await picker.fill(related.title);
    await page.getByRole("option", { name: new RegExp(related.title) }).click();
    await expect(page.locator("#save-status")).toContainText("已保存");
    const saved = await content.get(document.id);
    expect(saved.related).toEqual([related.id]);
  });

  test("a transient related-title lookup failure never removes saved relationships", async ({
    page,
    content,
  }) => {
    const related = await content.create(sampleContent("暂时不可读的相关目标"));
    const document = await content.create({
      ...sampleContent("保持相关关系"),
      related: [related.id],
    });
    await page.route(`**/api/documents/${related.id}`, (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ ok: false, message: "temporary" }),
          })
        : route.continue(),
    );
    await page.goto(`/manage/?id=${document.id}`);
    await page.getByLabel("文档摘要", { exact: true }).fill("只修改摘要，不应改变关系。");
    await expect(page.locator("#save-status")).toContainText("已保存");
    expect((await content.get(document.id)).related).toEqual([related.id]);
  });
});
