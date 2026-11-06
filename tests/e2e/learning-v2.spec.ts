import { test, expect } from "./fixtures";
import { ContentHarness, sampleContent, uniqueName, unwrap } from "./content-helpers";
import type { LearningPath } from "../../src/lib/learning-paths";

async function removeRoute(content: ContentHarness, id: string) {
  if (!id) return;
  const response = await content.request.get(`/api/learning-paths/${id}`);
  if (!response.ok()) return;
  const current = await unwrap<LearningPath>(response);
  await content.request.delete(`/api/learning-paths/${id}`, {
    headers: { Origin: content.origin }, data: { version: current.version },
  });
}

test("a route keeps goals and prerequisites and tracks practice independently from reading", async ({ page, context, baseURL }) => {
  const content = new ContentHarness(context.request, baseURL!);
  let id = "";
  try {
    const document = await content.action(await content.create(sampleContent("practice route lesson")), "publish");
    await page.goto("/learn/");
    await expect(page.locator("#learn-status")).not.toContainText("正在");
    await page.getByRole("button", { name: "＋ 新建方向" }).click();
    const title = uniqueName("学习与实践");
    await page.getByLabel("方向名称", { exact: true }).fill(title);
    await page.getByLabel("学习目标", { exact: true }).fill("解释队列等待\n复现一次超时");
    await page.getByLabel("先修知识", { exact: true }).fill("能运行本地程序");
    await page.getByRole("button", { name: "＋ 添加章节" }).click();
    await page.getByLabel("章节标题", { exact: true }).fill("第一章 · 从问题出发");
    await page.getByLabel("章节目标", { exact: true }).fill("用时间线解释等待时间");
    await page.getByLabel("实践任务与交付物", { exact: true }).fill("提交一段可复现代码与预期输出");
    await page.getByLabel("加入已有文章或草稿", { exact: true }).selectOption(document.id);
    await page.getByRole("button", { name: "保存路线", exact: true }).click();
    await expect(page.locator("#learn-dialog")).not.toBeVisible();
    id = new URL(page.url()).searchParams.get("id") || "";
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    await expect(page.locator(".learn-context")).toContainText("解释队列等待");
    await expect(page.locator(".learn-context")).toContainText("能运行本地程序");
    await expect(page.locator(".learn-chapter-goal")).toContainText("用时间线解释等待时间");
    const summary = page.locator(".learn-chapter summary");
    await summary.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".learn-practice-toggle")).not.toBeVisible();
    await page.getByRole("link", { name: "前往下一项实践 ↘" }).click();
    await expect(page.locator(".learn-practice-toggle")).toBeVisible();
    await page.getByRole("button", { name: "我已完成这项实践", exact: true }).click();
    await expect(page.locator(".learn-practice-toggle")).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".learn-completion")).toHaveText("0%");
    await expect(page.locator(".learn-practice-summary")).toContainText("1 / 1 项实践已完成");
    await page.reload();
    await expect(page.locator(".learn-practice-toggle")).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "✓ 已完成实践 · 撤销", exact: true }).click();
    await expect(page.locator(".learn-practice-summary")).toContainText("0 / 1 项实践已完成");
    await page.getByRole("button", { name: "整理章节", exact: true }).click();
    await expect(page.getByLabel("学习目标", { exact: true })).toHaveValue("解释队列等待\n复现一次超时");
    await expect(page.getByLabel("章节目标", { exact: true })).toHaveValue("用时间线解释等待时间");
    await page.getByLabel("学习目标", { exact: true }).fill("");
    await page.getByRole("button", { name: "保存路线", exact: true }).click();
    await expect(page.locator("#learn-dialog")).not.toBeVisible();
    const saved = await unwrap<LearningPath>(await context.request.get(`/api/learning-paths/${id}`));
    expect(saved.objectives || []).toEqual([]);
    expect(saved.prerequisites).toEqual(["能运行本地程序"]);
    const layout = await page.evaluate(() => {
      return {
        viewport: innerWidth,
        width: window.document.documentElement.scrollWidth,
      };
    });
    expect(layout.width, JSON.stringify(layout)).toBeLessThanOrEqual(layout.viewport);
  } finally {
    await removeRoute(content, id);
    await content.cleanup();
  }
});

test("a stale practice toggle cannot overwrite another device's route changes", async ({ page, context, baseURL }) => {
  const content = new ContentHarness(context.request, baseURL!);
  let id = "";
  try {
    const route = await unwrap<LearningPath>(await context.request.post("/api/learning-paths", {
      headers: { Origin: content.origin }, data: {
        title: uniqueName("练习冲突"), description: "", accent: "violet",
        objectives: ["保留其他设备的修改"], prerequisites: [],
        chapters: [{ id: "practice", title: "第一章", description: "", documentIds: [], exercise: "记录一次验证" }],
      },
    }));
    id = route.id;
    await page.goto(`/learn/?id=${id}`);
    await expect(page.locator(".learn-practice-toggle")).toBeVisible();
    const remote = await unwrap<LearningPath>(await context.request.put(`/api/learning-paths/${id}`, {
      headers: { Origin: content.origin }, data: {
        title: route.title, description: "远端修改需要保留", accent: route.accent,
        chapters: route.chapters, version: route.version,
      },
    }));
    await page.getByRole("button", { name: "我已完成这项实践", exact: true }).click();
    await expect(page.locator(".learn-practice-status")).toContainText("本次实践标记尚未保存");
    await expect(page.locator(".learn-practice-toggle")).toHaveAttribute("aria-pressed", "false");
    let current = await unwrap<LearningPath>(await context.request.get(`/api/learning-paths/${id}`));
    expect(current.version).toBe(remote.version);
    expect(current.description).toBe("远端修改需要保留");
    await page.getByRole("button", { name: "读取最新路线后再确认", exact: true }).click();
    await expect(page.locator(".learn-overview")).toContainText("远端修改需要保留");
    await page.getByRole("button", { name: "我已完成这项实践", exact: true }).click();
    await expect(page.locator(".learn-practice-toggle")).toHaveAttribute("aria-pressed", "true");
    current = await unwrap<LearningPath>(await context.request.get(`/api/learning-paths/${id}`));
    expect(current.description).toBe("远端修改需要保留");
    expect(current.objectives).toEqual(["保留其他设备的修改"]);
  } finally {
    await removeRoute(content, id);
    await content.cleanup();
  }
});
