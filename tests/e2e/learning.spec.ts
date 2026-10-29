import { test, expect } from "./fixtures";
import { ContentHarness, sampleContent, unwrap } from "./content-helpers";

test("learning routes keep chapter sequence, published isolation and completion across navigation", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  let route: { id: string; version: number } | undefined;
  try {
    let first = await content.action(
      await content.create(
        sampleContent("第一节", "## 开始\n\n发布的学习正文"),
      ),
      "publish",
    );
    const second = await content.action(
      await content.create(
        sampleContent("第二节", "## 继续\n\n第二节已发布正文"),
      ),
      "publish",
    );
    const draft = await content.create(
      sampleContent("草稿课程", "PRIVATE LESSON BODY"),
    );
    first = await content.save(first, {
      title: "PRIVATE WORKING TITLE",
      description: "PRIVATE WORKING DESCRIPTION",
      source: "PRIVATE WORKING BODY",
    });
    route = await unwrap(
      await context.request.post("/api/learning-paths", {
        headers: { Origin: content.origin },
        data: {
          title: "QA 从零到实践",
          description: "循序学习",
          accent: "blue",
          chapters: [
            {
              id: "start",
              title: "起步",
              description: "第一步",
              documentIds: [first.id, draft.id],
            },
            {
              id: "next",
              title: "实践",
              description: "第二步",
              documentIds: [second.id],
            },
          ],
        },
      }),
    );
    await page.goto(`/learn/?id=${route!.id}`);
    await expect(
      page.getByRole("heading", { name: "QA 从零到实践", exact: true }),
    ).toBeVisible();
    await expect(page.locator("main")).not.toContainText(
      "PRIVATE WORKING TITLE",
    );
    await expect(page.locator("main")).not.toContainText(
      "PRIVATE WORKING DESCRIPTION",
    );
    await expect(page.locator("main")).not.toContainText("PRIVATE LESSON BODY");
    await page.goto(`/articles/${first.id}/?path=${route!.id}`);
    const navigation = page.getByRole("region", { name: "技术路线章节导航" });
    await expect(navigation).toContainText("第 1 / 2 篇可读文章");
    await expect(page.locator("#article-body")).toContainText("发布的学习正文");
    await navigation
      .getByRole("button", { name: "完成本节，继续学习 →" })
      .click();
    await expect(page).toHaveURL(new RegExp(`/articles/${second.id}/\\?path=`));
    await expect(navigation).toContainText("第 2 / 2 篇可读文章");
    await navigation
      .getByRole("link", { name: "返回技术路线", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`/learn/\\?id=${route!.id}`));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    if (route)
      await context.request.delete(`/api/learning-paths/${route.id}`, {
        headers: { Origin: content.origin },
        data: { version: route.version },
      });
    await content.cleanup();
  }
});
