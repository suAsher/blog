import { test, expect } from "./fixtures";
import { ContentHarness, sampleContent } from "./content-helpers";

test("teaching models keep controls bounded and raw Markdown safe", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  try {
    const doc = await content.action(
      await content.create(
        sampleContent(
          "交互解释",
          [
            "## 观察一个现象",
            "这段正文在改变教学参数后仍然保留。",
            '```explore\n{"kind":"inference"}\n```',
            '```explore\n{"kind":"go-request"}\n```',
            '```explore\n{"kind":"network"}\n```',
          ].join("\n\n"),
        ),
      ),
      "publish",
    );
    await page.goto(`/articles/${doc.id}/`);
    await page.locator(".explore-widget").first().scrollIntoViewIfNeeded();
    const input = page.getByLabel("输入长度（token）", { exact: true });
    await input.scrollIntoViewIfNeeded();
    await expect(input).toBeVisible();
    const result = page
      .locator(".explore-widget")
      .first()
      .locator(".explore-result");
    const original = await result.innerText();
    await input.focus();
    await input.press("End");
    await expect(result).not.toHaveText(original);
    await page.getByRole("button", { name: "还原参数", exact: true }).click();
    await expect(result).toHaveText(original);
    await page.locator(".explore-widget").nth(1).scrollIntoViewIfNeeded();
    const scenario = page.getByLabel("请求场景", { exact: true });
    await scenario.scrollIntoViewIfNeeded();
    await scenario.selectOption("invalid");
    const go = page.locator(".explore-widget").nth(1);
    for (let i = 0; i < 4; i++)
      await go.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(go.locator(".explore-result")).toContainText("400");
    await page.locator(".explore-widget").nth(2).scrollIntoViewIfNeeded();
    const network = page.getByLabel("诊断场景", { exact: true });
    await network.scrollIntoViewIfNeeded();
    await network.selectOption("port");
    const net = page.locator(".explore-widget").nth(2);
    await net.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(net.locator(".explore-result")).toContainText("拒绝");
    await expect(page.locator("#article-body")).toContainText(
      "这段正文在改变教学参数后仍然保留。",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await content.cleanup();
  }
});

test("invalid teaching data retains its source without evaluating code", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  try {
    const doc = await content.action(
      await content.create(
        sampleContent(
          "错误教学块",
          '## 原文保留\n\n```explore\n{"kind":"inference","script":"window.__unsafe=true"}\n```',
        ),
      ),
      "publish",
    );
    await page.goto(`/articles/${doc.id}/`);
    const widget = page.locator(".explore-widget");
    await widget.scrollIntoViewIfNeeded();
    await expect(widget).toContainText("不允许");
    await expect(widget.locator("pre")).toContainText("window.__unsafe=true");
    expect(await page.evaluate(() => Object.hasOwn(window, "__unsafe"))).toBe(
      false,
    );
  } finally {
    await content.cleanup();
  }
});

test("manual reduced-motion steps do not disturb a persisted paragraph annotation", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  try {
    const doc = await content.action(
      await content.create(
        sampleContent(
          "模型之后的批注",
          '## 推演\n\n```explore\n{"kind":"go-request"}\n```\n\n让实验服务于理解，正文引用保持稳定。',
        ),
      ),
      "publish",
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/articles/${doc.id}/`);
    const widget = page.locator(".explore-widget");
    await widget.scrollIntoViewIfNeeded();
    await expect(
      widget.getByRole("button", { name: "播放步骤", exact: true }),
    ).toBeDisabled();
    await widget.getByRole("button", { name: "下一步", exact: true }).click();
    await expect(widget.locator(".explore-result")).toContainText("第 2 步");
    await expect(page.locator("#annotation-status")).toContainText("选中正文");
    await page.locator("#article-body").evaluate((article) => {
      const text = [...article.querySelectorAll("p")].find((node) =>
        node.textContent?.includes("正文引用保持稳定"),
      )!.firstChild!;
      const range = document.createRange();
      const start = text.textContent!.indexOf("正文引用保持稳定");
      range.setStart(text, start);
      range.setEnd(text, start + "正文引用保持稳定".length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page
      .getByRole("button", { name: "批注选中文字", exact: true })
      .click();
    await page
      .getByLabel("我的批注", { exact: true })
      .fill("实验之后仍然能回到这句话");
    await page.getByRole("button", { name: "保存批注", exact: true }).click();
    await expect(page.locator("#annotation-list")).toContainText(
      "实验之后仍然能回到这句话",
    );
    await page.reload();
    await expect(page.locator("#annotation-list")).toContainText(
      "实验之后仍然能回到这句话",
    );
    await expect(page.locator("#annotation-list")).toContainText("已定位原文");
    await expect(
      page.getByRole("button", { name: "定位原文", exact: true }),
    ).toBeEnabled();
  } finally {
    await content.cleanup();
  }
});
