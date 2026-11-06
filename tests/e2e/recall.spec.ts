import { test as authenticatedTest, expect } from "./fixtures";
import { ContentHarness, sampleContent, unwrap } from "./content-helpers";
import type { Annotation } from "../../src/lib/annotations";
import type { DocumentDetail } from "../../src/lib/documents";
import type { ReadingSnapshot } from "../../src/lib/reading-sync";
import AxeBuilder from "@axe-core/playwright";

const test = authenticatedTest.extend<{ content: ContentHarness }>({
  content: async ({ context, baseURL }, use) => {
    const content = new ContentHarness(context.request, baseURL || "");
    try { await use(content); } finally { await content.cleanup(); }
  },
});

test("an annotation becomes a draft question card with a citation and existing review schedule", async ({ page, context, content }) => {
  let article = await content.create(sampleContent("问题卡出处", "## 排队\n\n槽位正在忙，新到达的请求需要等待。"));
  article = await content.action(article, "publish");
  const annotation = await unwrap<Annotation>(await context.request.post("/api/annotations", {
    headers: { Origin: content.origin },
    data: { documentId: article.id, quote: { exact: "新到达的请求需要等待", prefix: "", suffix: "" }, body: "排队属于等待，并非正在计算。", color: "mint" },
  }));
  await page.goto(`/articles/${article.id}/`);
  await page.getByRole("button", { name: "制作问题卡", exact: true }).click();
  await page.getByLabel("复习问题", { exact: true }).fill("为什么短请求也会等待？");
  await expect(page.getByLabel("参考解释", { exact: true })).toHaveValue(/新到达的请求需要等待/);
  await page.getByLabel("参考解释", { exact: true }).fill("已有请求占用槽位。<script>alert(1)</script>");
  const response = page.waitForResponse((value) => value.url().endsWith("/api/documents") && value.request().method() === "POST");
  await page.getByRole("button", { name: "保存问题卡草稿", exact: true }).click();
  let card = await unwrap<DocumentDetail>(await response);
  content.track(card);
  expect(card.status).toBe("draft");
  expect(card.kind).toBe("note");
  expect(card.source).toContain(`#annotation-${annotation.id}`);
  await expect(page.getByRole("link", { name: "打开问题卡草稿", exact: true })).toHaveAttribute("href", `/manage/?id=${card.id}`);
  card = await content.action(card, "publish");
  await page.goto(`/articles/${card.id}/`);
  const widget = page.locator(".recall-widget");
  await expect(widget.getByRole("heading", { name: "为什么短请求也会等待？" })).toBeVisible();
  await expect(widget.locator(".recall-answer-text")).toBeHidden();
  await widget.locator(".recall-answer summary").focus();
  await page.keyboard.press("Enter");
  await expect(widget.locator(".recall-answer-text")).toHaveText("已有请求占用槽位。<script>alert(1)</script>");
  await expect(widget.locator("script")).toHaveCount(0);
  await expect(widget.getByRole("link", { name: "回到原文批注 ↗" })).toHaveAttribute("href", `/articles/${article.id}/#annotation-${annotation.id}`);
  await page.getByRole("button", { name: "加入回顾", exact: true }).click();
  await expect.poll(async () => (await unwrap<ReadingSnapshot>(await context.request.get("/api/reading-state"))).entries[card.id]?.review?.step).toBe(0);
  for (const theme of ["dark", "light"] as const) {
    await page.locator("html").evaluate((root, value) => { root.dataset.theme = value; }, theme);
    expect((await new AxeBuilder({ page }).include(".recall-widget").analyze()).violations).toEqual([]);
  }
});

test("cards reject invalid definitions and respect the ten-card budget", async ({ page, content }) => {
  const definition = (value: unknown) => `\`\`\`recall\n${JSON.stringify(value)}\n\`\`\`\n\n`;
  const valid = definition({ question: "试着回答", answer: "参考解释" });
  let article = await content.create(sampleContent("问题卡预算", valid.repeat(10) + valid + definition({ question: "非法来源", answer: "不可跳转", source: "javascript:alert(1)" })));
  article = await content.action(article, "publish");
  await page.goto(`/articles/${article.id}/`);
  await expect(page.locator(".recall-answer")).toHaveCount(10);
  await expect(page.locator(".recall-widget .widget-error")).toHaveCount(2);
  await expect(page.locator('.recall-widget a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.locator(".recall-widget").nth(10)).toContainText("最多展示 10 张");
});

test("revealing cards keeps a neighboring annotation anchored after reload", async ({ page, context, content }) => {
  let article = await content.create(sampleContent("问题卡批注", '## 思考\n\n```recall\n{"question":"为什么？","answer":"这是解释"}\n```\n\n卡片后面的这句话有明确出处。'));
  article = await content.action(article, "publish");
  await context.request.post("/api/annotations", {
    headers: { Origin: content.origin },
    data: { documentId: article.id, quote: { exact: "卡片后面的这句话有明确出处", prefix: "", suffix: "" }, body: "展开不会改变原文锚点", color: "violet" },
  });
  await page.goto(`/articles/${article.id}/`);
  await expect(page.locator("#annotation-list")).toContainText("已定位原文");
  await page.locator(".recall-answer summary").click();
  await page.getByRole("button", { name: "定位原文", exact: true }).click();
  await page.reload();
  await expect(page.locator("#annotation-list")).toContainText("已定位原文");
  await expect(page.locator(".recall-answer-text")).toBeHidden();
});
