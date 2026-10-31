import { test, expect } from "./fixtures";
import { ContentHarness, sampleContent } from "./content-helpers";

test("locating a quote inside folded output reveals the target and updates its toggle", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  try {
    const doc = await content.action(
      await content.create(
        sampleContent(
          "output quote",
          "## 实验\n\n代码文件：`main.py`\n\n```python\nprint('output sample')\n```\n\n运行输出：\n\n```text\noutput sample\n```",
        ),
      ),
      "publish",
    );
    await page.goto(`/articles/${doc.id}/`);
    await expect(page.locator("#annotation-status")).toContainText("选中正文");
    await page
      .locator(".code-container")
      .nth(1)
      .locator("code")
      .evaluate((code) => {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
    await page
      .getByRole("button", { name: "批注选中文字", exact: true })
      .click();
    await page.getByLabel("我的批注", { exact: true }).fill("这份输出的依据");
    await page.getByRole("button", { name: "保存批注", exact: true }).click();
    await expect(page.locator("#annotation-list")).toContainText(
      "这份输出的依据",
    );
    await page
      .getByRole("button", { name: "收起运行输出", exact: true })
      .click();
    await expect(page.locator(".code-container").nth(1)).toBeHidden();
    await page.getByRole("button", { name: "定位原文", exact: true }).click();
    await expect(page.locator(".code-container").nth(1)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "收起运行输出", exact: true }),
    ).toHaveAttribute("aria-expanded", "true");
  } finally {
    await content.cleanup();
  }
});
