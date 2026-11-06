import { test, expect } from "./fixtures";
import { ContentHarness, unwrap, uniqueName } from "./content-helpers";
import type { LearningPath } from "../../src/lib/learning-paths";
import type { SavedImportReport } from "../../src/lib/import-inbox";


test("new upload can be arranged into a route while all imported articles remain drafts", async ({page, context, baseURL}) => {
  const content = new ContentHarness(context.request, baseURL!);
  let route: LearningPath | undefined;
  try {
    await page.goto("/manage/?import=1");
    const title = uniqueName("编排导入");
    await page.locator("#import-files").setInputFiles([
      {name:"first.md",mimeType:"text/markdown",buffer:Buffer.from(`---\ntitle: "${title}"\n---\n\n真实导入正文`)},
      {name:"missing.md",mimeType:"text/markdown",buffer:Buffer.from(`---\ntitle: "${title} 缺图"\n---\n\n![missing](missing.png)`)},
    ]);
    await expect(page.locator("#import-preview")).toContainText(title);
    const imported = page.waitForResponse(response => new URL(response.url()).pathname === "/api/import" && response.request().method() === "POST");
    await page.locator("#confirm-import").click();
    const report = await unwrap<SavedImportReport>(await imported);
    report.imported.forEach(item => content.track(item));
    await page.getByRole("button", {name:"编排为学习路线",exact:true}).click();
    await expect(page.locator(".import-route")).toContainText("1 篇可编排文档");
    await expect(page.locator(".import-route-lesson")).toHaveCount(1);
    await page.getByLabel("新路线名称", {exact:true}).fill(`${title} 路线`);
    await page.getByLabel("章节 1 名称", {exact:true}).fill("导读与实践");
    const saved = page.waitForResponse(response => new URL(response.url()).pathname === "/api/learning-paths" && response.request().method() === "POST");
    await page.getByRole("button", {name:"确认创建学习路线",exact:true}).click();
    route = await unwrap<LearningPath>(await saved);
    expect(route.chapters[0].title).toBe("导读与实践");
    expect(route.chapters[0].documentIds).toHaveLength(1);
    await expect(page.getByRole("link",{name:`打开路线：${title} 路线 →`})).toBeVisible();
    for (const item of report.imported) expect((await content.get(item.id)).status).toBe("draft");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    if (route) await context.request.delete(`/api/learning-paths/${route.id}`, {headers:{Origin:content.origin},data:{version:route.version}});
    await content.cleanup();
  }
});

test("directory report keeps edited ordering and safely recovers a lost route response", async ({page, context, baseURL}) => {
  const content = new ContentHarness(context.request, baseURL!);
  let route: LearningPath | undefined;
  let reportId = "";
  try {
    const title = uniqueName("目录编排");
    const imported = await content.import([
      {path:`${title}/01 基础/a.md`,buffer:Buffer.from(`---\ntitle: "${title} A"\n---\n\nA 正文`)},
      {path:`${title}/02 实践/b.md`,buffer:Buffer.from(`---\ntitle: "${title} B"\n---\n\nB 正文`)},
      {path:`${title}/02 实践/c.md`,buffer:Buffer.from(`---\ntitle: "${title} C"\n---\n\nC 正文`)},
    ]);
    reportId = (imported as SavedImportReport).id;
    await page.goto("/manage/?import=1");
    await page.getByRole("button",{name:"查看最近导入报告"}).click();
    await page.locator(`[data-import-report="${reportId}"]`).click();
    await page.getByRole("button",{name:"编排为学习路线",exact:true}).click();
    await expect(page.getByLabel("新路线名称",{exact:true})).toHaveValue(title);
    const firstChapter = await page.getByLabel(`章节归属：${title}/01 基础/a.md`).inputValue();
    await page.getByLabel(`章节归属：${title}/02 实践/b.md`).selectOption(firstChapter);
    await page.getByRole("button",{name:`${title} B 上移`,exact:true}).click();
    await page.getByRole("button",{name:"章节 2 上移",exact:true}).click();
    await page.getByLabel("章节 1 名称",{exact:true}).fill("先看实践");
    let posted = 0;
    await page.route("**/api/learning-paths", async interception => {
      if (interception.request().method() !== "POST") { await interception.continue(); return; }
      posted++;
      const response = await interception.fetch();
      route = await unwrap<LearningPath>(response);
      await interception.abort("failed");
    });
    await page.getByRole("button",{name:"确认创建学习路线",exact:true}).click();
    await expect(page.locator(".import-route [role=status]")).toContainText("当前编排仍保留");
    expect(route!.chapters[0].title).toBe("先看实践");
    const byTitle = new Map(imported.imported.map(item => [item.title,item.id]));
    expect(route!.chapters[1].documentIds).toEqual([byTitle.get(`${title} B`),byTitle.get(`${title} A`)]);
    await page.getByRole("button",{name:"确认创建学习路线",exact:true}).click();
    await expect(page.getByRole("link",{name:`打开路线：${title} →`})).toBeVisible();
    expect(posted).toBe(1);
    await page.reload();
    await expect(page.locator("#import-dialog")).toBeVisible();
    await page.getByRole("button",{name:"查看最近导入报告"}).click();
    await page.locator(`[data-import-report="${reportId}"]`).click();
    await page.getByRole("button",{name:"编排为学习路线",exact:true}).click();
    await expect(page.getByRole("link",{name:`打开路线：${title} →`})).toHaveAttribute("href",`/learn/?id=${route!.id}`);
    const all = await unwrap<{paths:(LearningPath & {creationKey?:string})[]}>(await context.request.get("/api/learning-paths"));
    expect(all.paths.filter(item => item.creationKey === `import-${reportId}`)).toHaveLength(1);
  } finally {
    await page.unroute("**/api/learning-paths");
    if (route) await context.request.delete(`/api/learning-paths/${route.id}`,{headers:{Origin:content.origin},data:{version:route.version}});
    await content.cleanup();
  }
});
