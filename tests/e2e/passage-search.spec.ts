import { test, expect } from "./fixtures";
import { ContentHarness, sampleContent, unwrap } from "./content-helpers";
import type { PassageResults } from "../../src/lib/passage-search";
import AxeBuilder from "@axe-core/playwright";

const id = "a".repeat(32);
const revision = "b".repeat(64);
const anchor = `passage-${"c".repeat(20)}-1`;
const result = {
  documentId: id,
  title: "缓存与边界",
  tags: ["Go"],
  category: "系统设计",
  publishedAt: "2026-11-06",
  revision,
  anchor,
  kind: "paragraph",
  snippet: "缓存 cache 的窗口与 <img src=x onerror=alert(1)> 是纯文本。",
  headings: [{ depth: 2, slug: "boundary", text: "缓存边界" }],
  paths: [
    {
      pathId: id,
      pathTitle: "系统设计路线",
      chapterId: "one",
      chapterTitle: "缓存基础",
    },
  ],
};
const response = (passages = [result], extra = {}) => ({
  ok: true,
  data: {
    passages,
    total: passages.length,
    limit: 12,
    offset: 0,
    hasMore: false,
    truncated: false,
    message: "",
    ...extra,
  },
});

test.describe("passage search interface", () => {
  test.beforeEach(async ({ page }) => {
    await page.route("**/api/documents?status=published&limit=1", (route) =>
      route.fulfill({
        json: {
          ok: true,
          data: { documents: [], tags: [{ name: "Go", count: 2 }], total: 2 },
        },
      }),
    );
    await page.route("**/api/learning-paths", (route) =>
      route.fulfill({
        json: { ok: true, data: { paths: [{ id, title: "系统设计路线" }] } },
      }),
    );
  });
  test("safe highlighting, content facets, page URLs, keyboard access and themes", async ({
    page,
  }) => {
    await page.route("**/api/search/passages?**", (route) => {
      const params = new URL(route.request().url()).searchParams;
      return route.fulfill({
        json: response([result], {
          total: 13,
          offset: Number(params.get("offset") || 0),
          hasMore: !params.get("offset"),
        }),
      });
    });
    await page.goto("/search/?q=cache");
    await expect(page.locator(".passage-result")).toHaveCount(1);
    await expect(page.locator(".passage-snippet mark")).toHaveText("cache");
    await expect(page.locator(".passage-snippet img")).toHaveCount(0);
    await expect(page.locator(".passage-snippet")).toContainText("<img src=x");
    await page.locator("#passage-tag").selectOption("Go");
    await page.locator("#passage-path").selectOption(id);
    await expect(page).toHaveURL(new RegExp(`tag=Go&pathId=${id}`));
    await expect(page.locator(".passage-result-link")).toHaveAttribute(
      "href",
      new RegExp(`path=${id}#${anchor}`),
    );
    await page.locator("#passage-next").click();
    await expect(page).toHaveURL(/offset=12/);
    await expect(page.locator("#passage-results-heading")).toBeFocused();
    await page.goBack();
    await expect(page.locator("#passage-page-label")).toHaveText("第 1 页");
    for (const theme of ["dark", "light"]) {
      await page.locator("html").evaluate((root, theme) => {
        root.dataset.theme = theme;
      }, theme);
      const audit = await new AxeBuilder({ page })
        .include(".passage-page")
        .analyze();
      expect(audit.violations).toEqual([]);
    }
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  });
  test("failure retry, empty results and honest budget status", async ({
    page,
  }) => {
    let attempt = 0;
    await page.route("**/api/search/passages?**", (route) =>
      route.fulfill(
        ++attempt === 1
          ? { status: 503, json: { ok: false, message: "连接失败，请重试。" } }
          : {
              json: response([], {
                truncated: true,
                message: "达到检索预算，请缩小范围。",
              }),
            },
      ),
    );
    await page.goto("/search/?q=cache");
    await expect(page.locator("#passage-error")).toBeVisible();
    await page.locator("#passage-retry").click();
    await expect(page.locator("#passage-empty")).toBeVisible();
    await expect(page.locator("#passage-budget")).toContainText("检索预算");
    await expect(page.locator("#passage-status")).toContainText("已检索范围");
  });
  test("ignores an older request and waits for IME composition", async ({
    page,
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/search/passages?**", async (route) => {
      if (new URL(route.request().url()).searchParams.get("q") === "old")
        await gate;
      await route.fulfill({
        json: response([
          {
            ...result,
            title: new URL(route.request().url()).searchParams.get("q")!,
          },
        ]),
      });
    });
    await page.goto("/search/?q=old");
    await page.locator("#passage-query").dispatchEvent("compositionstart");
    await page.locator("#passage-query").fill("cache");
    await page.locator("#passage-query").dispatchEvent("compositionend");
    await expect(page.locator(".passage-result-link")).toHaveText("cache");
    release();
    await expect(page.locator(".passage-result-link")).toHaveText("cache");
  });
  test("rejects duplicate query parameters before sending a search", async ({
    page,
  }) => {
    let requests = 0;
    await page.route("**/api/search/passages?**", (route) => {
      requests++;
      return route.fulfill({ json: response() });
    });
    await page.goto("/search/?q=a&q=b");
    await expect(page.locator("#passage-error-message")).toContainText(
      "重复参数",
    );
    expect(requests).toBe(0);
  });
});

test.describe("published passage deep links", () => {
  test.skip(
    !process.env.BLOG_TEST_SSH_TARGET &&
      process.env.BLOG_TEST_LOCAL_AUTH !== "1",
    "Requires the persistent content API.",
  );
  test("keeps code captions and reveals a collapsed output when locating its passage", async ({
    page,
    context,
    baseURL,
  }) => {
    const content = new ContentHarness(context.request, baseURL || "");
    try {
      const source = [
        "## 示例",
        "",
        "代码文件：main.go；重点行：1。",
        "",
        "```go",
        'fmt.Println("hello")',
        "```",
        "",
        "运行输出：",
        "",
        "```text",
        "output-passage-proof",
        "```",
      ].join("\n");
      let document = await content.create(
        sampleContent("代码锚点兼容", source),
      );
      document = await content.action(document, "publish");
      const search = await unwrap<PassageResults>(
        await context.request.get(
          "/api/search/passages?q=output-passage-proof",
        ),
      );
      const hit = search.passages.find(
        (item) => item.documentId === document.id,
      )!;
      expect(hit.kind).toBe("code");
      await page.goto(
        `/articles/${document.id}/?passageRevision=${hit.revision}&q=output-passage-proof#${hit.anchor}`,
      );
      await expect(page.locator(".code-language").first()).toHaveText(
        "main.go",
      );
      await expect(
        page.locator(".code-line-gutter .is-emphasized"),
      ).toHaveCount(1);
      await expect(page.locator(".passage-target")).toContainText(
        "output-passage-proof",
      );
      await page
        .getByRole("button", { name: "收起运行输出", exact: true })
        .click();
      await expect(page.locator("[data-output-collapsed]")).toHaveCount(1);
      await page
        .getByRole("button", { name: "定位到段落", exact: true })
        .click();
      await expect(page.locator("[data-output-collapsed]")).toHaveCount(0);
      await expect(page.locator(".passage-target")).toBeFocused();
      await expect(page.locator(".passage-target")).toBeInViewport();
    } finally {
      await content.cleanup();
    }
  });
  test("opens exact body content, keeps draft edits private, and reports stale publication links", async ({
    page,
    context,
    baseURL,
  }) => {
    const content = new ContentHarness(context.request, baseURL || "");
    try {
      let document = await content.create(
        sampleContent(
          "段落跳转",
          "## 边界\n\npassage-proof-keyword 描述真实发布段落。\n\n## 尾声\n\n其他正文。",
        ),
      );
      document = await content.action(document, "publish");
      const found = await unwrap<PassageResults>(
        await context.request.get(
          "/api/search/passages?q=passage-proof-keyword",
        ),
      );
      const passage = found.passages.find(
        (item) => item.documentId === document.id,
      )!;
      expect(passage).toBeTruthy();
      const href = `/articles/${document.id}/?passageRevision=${passage.revision}&q=passage-proof-keyword#${passage.anchor}`;
      document = await content.save(document, {
        source: document.source + "\n\ndraft-only-passage-keyword",
      });
      await page.goto(href);
      await expect(page.locator(".passage-target")).toContainText(
        "passage-proof-keyword",
      );
      await expect(page.locator("#passage-target-status")).toContainText(
        "已定位",
      );
      expect(
        (
          await unwrap<PassageResults>(
            await context.request.get(
              "/api/search/passages?q=draft-only-passage-keyword",
            ),
          )
        ).passages.some((item) => item.documentId === document.id),
      ).toBe(false);
      document = await content.action(document, "publish");
      expect((await content.get(document.id, true)).passageRevision).not.toBe(
        passage.revision,
      );
      await page.reload();
      await expect(page.locator("#passage-target-status")).toContainText(
        "已更新",
      );
      document = await content.save(document, {
        source: "## 新的正文\n\n旧段落已移除。",
      });
      document = await content.action(document, "publish");
      await page.reload();
      await expect(page.locator("#passage-target-status")).toContainText(
        "未找到",
      );
      await expect(page.locator("#passage-target-status a")).toHaveAttribute(
        "href",
        "/search/?q=passage-proof-keyword",
      );
      await content.action(document, "unpublish");
      await page.reload();
      await expect(page.locator("#reader-error")).toBeVisible();
      await expect(page.locator("#passage-recovery-link")).toHaveAttribute(
        "href",
        "/search/?q=passage-proof-keyword",
      );
    } finally {
      await content.cleanup();
    }
  });
});
