import { test, expect } from "./fixtures";
import { ContentHarness, sampleContent } from "./content-helpers";

test("editorial code keeps exact copy text, offers line cues and folds matching output", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  const code = "def twice(value):\n    return value * 2\nprint(twice(3))\n";
  const wideCode = `// ${"wide code ".repeat(100)}\n`;
  const source =
    "## 一个可验证的问题\n\n先看输入怎样产生输出。\n\n代码文件：`main.py`；重点行：2\n\n```python\n" +
    code +
    "```\n\n运行输出：\n\n```text\n6\n```\n\n## 再看失败的边界\n\n普通正文仍然可以选中批注。\n\n```go\n" +
    wideCode +
    "```\n\n代码文件：`bad.go`；重点行：999\n\n```go\n" +
    wideCode +
    "```";
  try {
    const doc = await content.action(
      await content.create(sampleContent("editorial code", source)),
      "publish",
    );
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (value: string) => {
            sessionStorage.setItem("qa-copied", value);
          },
        },
      });
    });
    await page.goto(`/articles/${doc.id}/`);
    await expect(page.locator("#article-overview")).toContainText(
      "一个可验证的问题",
    );
    const card = page.locator(".editorial-code").first();
    await expect(card.locator(".code-language")).toHaveText("main.py");
    await expect(card.locator(".code-line-gutter > span")).toHaveCount(3);
    await expect(card.locator("pre code")).toHaveText(code);
    await card.getByRole("button", { name: "复制代码", exact: true }).click();
    expect(await page.evaluate(() => sessionStorage.getItem("qa-copied"))).toBe(
      code,
    );
    await card
      .getByRole("button", { name: "收起运行输出", exact: true })
      .click();
    await expect(page.locator(".code-container").nth(1)).toBeHidden();
    await card
      .getByRole("button", { name: "显示运行输出", exact: true })
      .click();
    await expect(page.locator(".code-container").nth(1)).toBeVisible();
    for (const index of [2, 3]) {
      const plain = page.locator(".code-container").nth(index).locator("pre");
      await expect(plain).toHaveAttribute("tabindex", "0");
      await expect(plain).toHaveAttribute("role", "region");
      await expect(plain).toHaveAttribute("aria-label", /GO 代码，可横向滚动/);
      await expect(plain.locator("code")).toHaveText(wideCode);
      await plain.focus();
      await expect(plain).toBeFocused();
      await plain.press("ArrowRight");
      await expect
        .poll(() => plain.evaluate((node) => node.scrollLeft))
        .toBeGreaterThan(0);
    }
    await page.getByRole("button", { name: "专注阅读", exact: false }).click();
    await expect(page.locator("#article-overview")).toBeHidden();
    await expect(page.locator("#article-body")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await content.cleanup();
  }
});

test("a slow article response keeps the footer below the initial viewport", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  try {
    const doc = await content.action(
      await content.create(
        sampleContent("loading stability", "## 正文\n\n稳定的阅读入口。"),
      ),
      "publish",
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      `**/api/documents/${doc.id}?view=published`,
      async (route) => {
        await gate;
        await route.continue();
      },
    );
    try {
      await page.goto(`/articles/${doc.id}/`);
      await expect(page.locator("#reader-loading")).toBeVisible();
      expect(
        await page
          .locator(".site-footer")
          .evaluate(
            (footer) => footer.getBoundingClientRect().top >= innerHeight,
          ),
      ).toBe(true);
    } finally {
      release();
    }
    await expect(page.locator("#article-body")).toContainText("稳定的阅读入口");
  } finally {
    await content.cleanup();
  }
});

test("folding output preserves the adjacent paragraph annotation after reload", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  try {
    const doc = await content.action(
      await content.create(
        sampleContent(
          "stable folded output",
          "## 实验\n\n代码文件：`main.py`\n\n```python\nprint(6)\n```\n\n运行输出：\n\n```text\n6\n```\n\n保留这个结论，折叠以后仍可定位原文。",
        ),
      ),
      "publish",
    );
    await page.goto(`/articles/${doc.id}/`);
    await page
      .getByRole("button", { name: "收起运行输出", exact: true })
      .click();
    await expect(page.locator("#annotation-status")).toContainText("选中正文");
    await page.locator("#article-body").evaluate((article) => {
      const text = [...article.querySelectorAll("p")].find((node) =>
        node.textContent?.includes("保留这个结论"),
      )!.firstChild!;
      const range = document.createRange();
      range.selectNodeContents(text);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page
      .getByRole("button", { name: "批注选中文字", exact: true })
      .click();
    await page.getByLabel("我的批注", { exact: true }).fill("折叠只影响显示");
    await page.getByRole("button", { name: "保存批注", exact: true }).click();
    await expect(page.locator("#annotation-list")).toContainText(
      "折叠只影响显示",
    );
    await page.reload();
    await expect(page.locator("#annotation-list")).toContainText("已定位原文");
    await expect(
      page.getByRole("button", { name: "定位原文", exact: true }),
    ).toBeEnabled();
  } finally {
    await content.cleanup();
  }
});
