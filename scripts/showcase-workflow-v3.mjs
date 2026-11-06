/** Generated fixtures only. Real loopback HTTPS, Go auth/store and browser; no production access. */
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { startPrivateServer, readLocalCredentials } from "./local-private-server.mjs";

const output = "docs/qa/workflow-v3";
const viewports = [
  ["desktop", { width: 1440, height: 1000 }],
  ["tablet", { width: 834, height: 1112 }],
  ["mobile", { width: 390, height: 844 }],
];
const audits = [], screenshots = [], browserErrors = [], failures = [];
const measuredAt = new Date().toISOString();
let browser, service, activeState = "setup", chromeVersion, documentCount = 0;
const cleanError = (message) => String(message).replace(/https:\/\/127\.0\.0\.1:\d+/gu, "(local)").slice(0, 3000);

await mkdir(output, { recursive: true });
try {
  service = await startPrivateServer({ port: 4493 });
  const credentials = await readLocalCredentials(service.origin, service.fixture);
  browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    args: [`--ignore-certificate-errors-spki-list=${credentials.certificateSPKI}`],
  });
  chromeVersion = browser.version();
  async function session(viewport, selectedTheme = "dark") {
    const context = await browser.newContext({
      baseURL: service.origin, ignoreHTTPSErrors: true, viewport, reducedMotion: "reduce",
    });
    const response = await context.request.post("/auth/login", {
      headers: { Origin: service.origin },
      data: { username: credentials.username, password: credentials.password },
    });
    if (!response.ok()) throw new Error(`Local private QA login: ${response.status()}`);
    await context.addInitScript((theme) => localStorage.setItem("asher-theme", theme), selectedTheme);
    return context;
  }
  function apiFor(context) {
    return async (method, path, data) => {
      const response = await context.request.fetch(path, { method, data, headers: { Origin: service.origin } });
      if (!response.ok()) throw new Error(`${method} ${path}: ${response.status()}`);
      const body = await response.json();
      if (body.ok !== true) throw new Error(`${method} ${path}: invalid envelope`);
      return body.data;
    };
  }
  const setup = await session(viewports[0][1]);
  const seedApi = apiFor(setup);
  const longSource = (await readFile("examples/ai-infrastructure/02-load-model.md", "utf8"))
    .replace(/^---\n[\s\S]*?\n---\n/u, "") +
    "\n\n## 将观察变成可复核的证据\n\n边界探针：保留提交、接收、拒绝与完成的完整分母，再解释等待时间。这里是生成验收段落，不代表真实服务的测量结果。\n";
  const fixtures = [
    { title: "生成演示 · 用确定性负载看懂时延与吞吐", description: "固定输入，记录拒绝，把性能判断变成可以复核的实验。", source: longSource, published: true },
    { title: "生成演示 · 请求边界与取消", description: "把请求期限、任务退出和清理责任放到同一张清单。", source: "## 请求契约\n\n请求应该有明确的输入、时间预算和退出路径。\n\n## 实践\n\n记录取消后仍在执行的任务，并注明尚未验证的假设。", published: true },
    { title: "生成演示 · 一次排障的观察窗口", description: "导入后待整理的笔记：先确定指标起点和终点。", source: "## 待整理\n\n生成资料。补充环境、输入和观察窗口后再验证。", published: false },
    { title: "生成演示 · 缓存预算备忘", description: "未归入路线的草稿，保留问题和下一步。", source: "## 待验证\n\n生成资料。先写下资源边界，再执行实验。", published: false },
  ];
  const documents = [];
  for (const fixture of fixtures) {
    const draft = await seedApi("POST", "/api/documents", {
      title: fixture.title, description: fixture.description, source: fixture.source,
      date: "2026-11-06", tags: ["生成演示", "工作流验收"], category: "", cover: "",
    });
    documents.push(fixture.published ? await seedApi("POST", `/api/documents/${draft.id}/publish`, { version: draft.version }) : draft);
  }
  documentCount = documents.length;
  const route = await seedApi("POST", "/api/learning-paths", {
    title: "从资料到一次可以复核的实践", description: "生成演示 · 整理输入、动手验证，再留下可以继续修改的成果。",
    accent: "blue", objectives: ["把一份资料变成可执行的验证步骤", "让结论带着输入、边界与原始观察"], prerequisites: ["能够阅读简单的请求与队列示例"],
    chapters: [{ id: "verify", title: "用证据解释一次等待", description: "从确定性模型开始，保留每一步的输入与输出。", goal: "区分等待、完成与拒绝，保留实验分母。", exercise: "运行固定输入，记录预期和实际结果；解释一个失败分支，并把尚未验证的判断标出来。", practiced: false, documentIds: documents.slice(0, 2).map((doc) => doc.id) }],
  });
  const lesson = documents[0];
  await seedApi("PUT", `/api/documents/${lesson.id}`, {
    title: lesson.title, description: lesson.description, date: lesson.date,
    tags: lesson.tags, category: lesson.category, cover: lesson.cover,
    source: `${longSource}\n\n未发布隔离探针只存在于工作稿。\n`, version: lesson.version,
  });
  expect((await seedApi("GET", "/api/search/passages?q=未发布隔离探针&limit=20&offset=0")).total).toBe(0);
  const publishedHits = await seedApi("GET", "/api/search/passages?q=边界探针&limit=20&offset=0");
  expect(publishedHits.passages.some((hit) => hit.documentId === lesson.id)).toBe(true);
  await setup.close();

  for (const [device, viewport] of viewports) {
    for (const selectedTheme of ["dark", "light"]) {
      const context = await session(viewport, selectedTheme);
      const api = apiFor(context);
      const page = await context.newPage();
      page.on("pageerror", (error) => browserErrors.push({ state: activeState, kind: "pageerror", message: cleanError(error.message) }));
      page.on("console", (message) => {
        if (message.type() === "error") browserErrors.push({ state: activeState, kind: "console", message: cleanError(message.text()) });
      });
      const state = (name) => { activeState = `${device}-${selectedTheme}-${name}`; };
      async function capture(name) {
        state(name);
        await page.evaluate(() => document.fonts.ready);
        const filename = `${activeState}.png`;
        await page.screenshot({ path: `${output}/${filename}`, animations: "disabled" });
        screenshots.push(filename);
        const overflow = await page.evaluate(() => ({
          viewport: innerWidth, width: document.documentElement.scrollWidth,
          overflowing: [...document.querySelectorAll("body *")].filter((node) => {
            const box = node.getBoundingClientRect();
            return box.width > 0 && (box.right > innerWidth + 1 || box.left < -1) && getComputedStyle(node).position !== "fixed";
          }).slice(0, 12).map((node) => ({ tag: node.tagName, id: node.id, className: typeof node.className === "string" ? node.className : "" })),
        }));
        const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
        const violations = result.violations.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.map((node) => node.target), details: item.nodes.map((node) => ({ target: node.target, failureSummary: node.failureSummary })) }));
        audits.push({ view: name, device, theme: selectedTheme, overflow, violations });
        if (overflow.width > overflow.viewport) failures.push({ state: activeState, message: `Horizontal overflow: ${overflow.width} > ${overflow.viewport}` });
        if (violations.length) failures.push({ state: activeState, message: `Axe violations: ${violations.map((item) => item.id).join(", ")}` });
        console.log(`Captured ${activeState}: axe=${violations.length}, width=${overflow.width}/${overflow.viewport}`);
      }
      async function inboxView(view) {
        const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/inbox" && new URL(item.url()).searchParams.get("view") === view);
        await page.locator(`#inbox-tabs [data-view="${view}"]`).click();
        await response;
        await expect(page.locator(`#inbox-tabs [data-view="${view}"]`)).toHaveAttribute("aria-pressed", "true");
      }
      async function applyStage(stage) {
        for (const doc of documents.slice(0, 2)) await page.locator(`.inbox-item[data-id="${doc.id}"] input[type="checkbox"]`).check();
        await page.locator("#inbox-stage").selectOption(stage);
        const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/inbox/batch" && item.request().method() === "PUT");
        await page.locator("#inbox-apply").click();
        expect((await response).ok()).toBe(true);
        await expect.poll(async () => (await api("GET", "/api/inbox?view=all&limit=50")).documents.filter((doc) => documents.slice(0, 2).some((item) => item.id === doc.id)).map((doc) => doc.stage)).toEqual([stage, stage]);
        await expect(page.locator("#inbox-results")).toHaveAttribute("aria-busy", "false");
        await expect(page.locator(`.inbox-stage[data-stage="${stage}"]`)).toHaveCount(2);
        await expect(page.locator("#inbox-apply")).toBeDisabled();
      }
      state("inbox-content");
      const inbox = await api("GET", "/api/inbox?view=all&limit=50");
      await api("PUT", "/api/inbox/batch", { version: inbox.version, documentIds: documents.map((doc) => doc.id), stage: "pending" });
      await page.goto("/inbox/");
      await expect(page.locator(".inbox-item")).toHaveCount(documentCount);
      await capture("inbox-hero");
      await page.locator(".inbox-item").first().scrollIntoViewIfNeeded();
      await capture("inbox-content");
      await inboxView("all");
      await applyStage("organized");
      await capture("inbox-organized");
      await applyStage("verified");
      await inboxView("verified");
      await capture("inbox-verified");
      for (const doc of documents) expect((await api("GET", `/api/documents/${doc.id}`)).status).toBe(doc.status);

      await inboxView("unassigned");
      await page.locator(".inbox-views summary").click();
      await page.locator("#inbox-view-name").fill(`待归入路线 · ${device} ${selectedTheme}`);
      const savedResponse = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/inbox/views" && item.request().method() === "PUT");
      await page.locator("#inbox-save-view").click();
      expect((await savedResponse).ok()).toBe(true);
      await expect(page.locator("#inbox-saved-views [data-saved-view]")).toHaveCount(screenshots.filter((name) => name.endsWith("inbox-saved-view.png")).length + 1);
      await capture("inbox-saved-view");
      await page.locator("#inbox-search").fill("不存在的生成验收条目");
      await page.locator("#inbox-filter-submit").click();
      await expect(page.locator("#inbox-empty")).toBeVisible();
      await page.locator("#inbox-empty").scrollIntoViewIfNeeded();
      await capture("inbox-empty");
      await page.locator("#inbox-saved-views [data-saved-view]").last().click();
      await expect(page.locator("#inbox-search")).toHaveValue("");
      await expect(page.locator("#inbox-empty")).toBeHidden();

      state("practice-create");
      await page.goto(`/learn/?id=${route.id}`);
      await expect(page.locator("#learn-detail h2")).toHaveText(route.title);
      await page.getByRole("button", { name: "新建实践记录", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "记录这次实践" });
      const recordTitle = `生成演示 · 等待时间实验记录 · ${device} ${selectedTheme}`;
      await dialog.getByLabel("记录标题", { exact: true }).fill(recordTitle);
      const createdResponse = page.waitForResponse((item) => new URL(item.url()).pathname === "/api/documents" && item.request().method() === "POST");
      await dialog.getByRole("button", { name: "创建草稿并关联", exact: true }).click();
      const record = (await (await createdResponse).json()).data;
      documentCount++;
      expect(record.status).toBe("draft");
      expect(record.source).toContain("## 失败原因");
      await expect(dialog.getByRole("status")).toContainText("已关联");
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(page.locator(".learn-record-list")).toContainText(recordTitle);
      await expect(page.locator(".learn-practice-toggle")).toHaveAttribute("aria-pressed", "false");
      await expect(page.locator(".learn-completion")).toHaveText("0%");
      const currentRoute = await api("GET", `/api/learning-paths/${route.id}`);
      expect(currentRoute.chapters[0].documentIds).toEqual(documents.slice(0, 2).map((doc) => doc.id));
      expect(currentRoute.chapters[0].practiceDocumentIds).toContain(record.id);
      expect(currentRoute.chapters[0].practiced).not.toBe(true);
      await page.locator(".learn-records").scrollIntoViewIfNeeded();
      await capture("practice-records");
      await page.locator(".learn-record-list").getByRole("link", { name: recordTitle, exact: true }).click();
      await expect(page.locator("#document-source")).toHaveValue(/尚未完成验证/u);
      const source = `${record.source}\n## 本次整理\n\n这是一份生成验收草稿：已确认记录结构，实验结果仍待本人实际执行后填写。\n`;
      await page.locator("#document-source").fill(source);
      await page.locator("#save-document").click();
      await expect(page.locator("#save-status")).toHaveText("所有修改已保存");
      expect((await api("GET", `/api/documents/${record.id}`)).source).toBe(source);
      expect((await api("GET", `/api/documents/${record.id}`)).status).toBe("draft");
      await page.locator("#document-source").scrollIntoViewIfNeeded();
      await capture("practice-draft");

      state("passage-search");
      await page.goto("/search/?q=边界探针");
      await expect(page.locator("#passage-query")).toHaveValue("边界探针");
      await expect(page.locator(".passage-result")).toHaveCount(1);
      await expect(page.locator(".passage-snippet")).toContainText("完整分母");
      await page.locator("#passage-results").scrollIntoViewIfNeeded();
      await capture("passage-search");
      const target = page.locator(".passage-result-link").first();
      const href = await target.getAttribute("href");
      expect(href).toContain(`/articles/${lesson.id}/`);
      expect(href).toContain("#passage-");
      await target.click();
      await expect(page.locator("#live-title")).toHaveText(lesson.title);
      await expect(page.locator(".passage-target")).toContainText("边界探针");
      await expect(page.locator(".passage-target")).toBeInViewport();
      await capture("passage-location");
      await context.close();
    }
  }
} catch (error) {
  failures.push({ state: activeState, message: cleanError(error?.stack || error) });
} finally {
  await browser?.close();
  await service?.stop();
  const result = {
    measuredAt, completedAt: new Date().toISOString(), passed: failures.length === 0 && browserErrors.length === 0,
    generatedOnly: true, chromeVersion,
    environment: "Local loopback HTTPS; real Go authentication and temporary content store; ephemeral random credentials; no production requests",
    viewports: viewports.map(([name, viewport]) => ({ name, ...viewport })), themes: ["dark", "light"],
    documents: documentCount, audits, screenshots, browserErrors, failures,
  };
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2) + "\n");
  console.log(`${result.passed ? "PASS" : "FAIL"}: ${audits.length} Axe states / ${screenshots.length} screenshots / ${browserErrors.length} browser errors / ${failures.length} failures`);
  if (!result.passed) process.exitCode = 1;
}
