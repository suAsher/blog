/** Exercise real upload/writing flows using generated examples and local QA only. */
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import {
  startPrivateServer,
  readLocalCredentials,
} from "./local-private-server.mjs";

const root = process.cwd();
const output = resolve(
  process.env.BLOG_RESEARCH_SCREENSHOTS || "docs/qa/research",
);
const service = await startPrivateServer({
  port: Number(process.env.BLOG_TEST_LOCAL_PORT || 4462),
});
let browser;
const marker = "演示 · 从一次阅读，到一份自己的结论";
const accessibility = [];
async function audit(page, name) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  accessibility.push({
    name,
    violations: result.violations.map((item) => ({
      id: item.id,
      impact: item.impact,
      targets: item.nodes.map((node) => node.target),
    })),
  });
  if (result.violations.length)
    throw new Error(
      `Generated showcase accessibility failed: ${name}: ${JSON.stringify(accessibility.at(-1))}`,
    );
}
try {
  const credentials = await readLocalCredentials(
    service.origin,
    service.fixture,
  );
  browser = await chromium.launch({
    channel: "chrome",
    args: [
      `--ignore-certificate-errors-spki-list=${credentials.certificateSPKI}`,
    ],
  });
  const context = await browser.newContext({
    baseURL: service.origin,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  const login = await context.request.post("/auth/login", {
    headers: { Origin: service.origin },
    data: { username: credentials.username, password: credentials.password },
  });
  if (login.status() !== 200)
    throw new Error("Temporary local QA login failed.");
  await mkdir(output, { recursive: true });
  const page = await context.newPage();
  await page.goto("/manage/?import=1");
  await page
    .locator("#import-folder")
    .setInputFiles(resolve(root, "examples/research/import-bundle"));
  await expect(page.locator("#import-preview")).toBeVisible();
  await expect(page.locator("#import-preview")).toContainText(
    "演示 · 把推理延迟",
  );
  await audit(page, "desktop-import-preview");
  await page.screenshot({
    path: join(output, "desktop-import-preview.png"),
    fullPage: true,
  });
  const importing = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/import" &&
      response.request().method() === "POST",
  );
  await page.locator("#confirm-import").click();
  const importedResponse = await importing;
  if (importedResponse.status() !== 200)
    throw new Error("Generated example import failed.");
  const report = (await importedResponse.json()).data;
  expect(report.imported).toHaveLength(5);
  expect(report.unresolvedImages).toHaveLength(0);
  await page.locator("#close-import").click();
  for (const document of report.imported) {
    await page.goto(`/manage/?id=${document.id}`);
    await expect(page.getByLabel("文档标题", { exact: true })).toHaveValue(
      document.title,
    );
    await page.locator("#publish-document").click();
    await expect(page.locator("#document-status")).toContainText("已发布");
  }
  await page.goto("/manage/");
  const creating = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/documents" &&
      response.request().method() === "POST",
  );
  await page.locator("#new-document").click();
  const written = (await (await creating).json()).data;
  const source = await readFile(
    resolve(root, "examples/research/written-article.md"),
    "utf8",
  );
  await page.getByLabel("文档标题", { exact: true }).fill(marker);
  await page
    .getByLabel("文档摘要", { exact: true })
    .fill(
      "生成演示：通过站内编辑器写入，展示从阅读、批注到专题整理的完整路径。",
    );
  await page.getByLabel("Markdown 正文", { exact: true }).fill(source);
  await expect(page.locator("#save-status")).toContainText("已保存");
  await page.locator("#publish-document").click();
  await expect(page.locator("#document-status")).toContainText("已发布");
  await page
    .getByLabel("Markdown 正文", { exact: true })
    .fill(
      source +
        "\n\n## 下一次补充\n\n生成演示：这一节保留在工作稿中，只有重新发布才改变线上正文。\n",
    );
  await expect(page.locator("#save-status")).toContainText("已保存");
  await page.locator("#open-document-history").click();
  await expect(page.locator("#revision-list")).toContainText("版本");
  await page.locator("#revision-list button").first().click();
  await expect(page.locator("#revision-comparison")).not.toBeEmpty();
  await audit(page, "desktop-history-diff");
  await page.screenshot({
    path: join(output, "desktop-history-diff.png"),
    fullPage: true,
  });
  await page.locator("#close-document-history").click();
  await page.locator("#new-document").click();
  await page.getByLabel("文档标题", { exact: true }).fill("演示 · 待验证实验的记录模板");
  await page.getByLabel("Markdown 正文", { exact: true }).fill(
    await readFile(resolve(root, "examples/research/experiment-template.md"), "utf8"),
  );
  await expect(page.locator("#save-status")).toContainText("已保存");
  await expect(page.locator("#document-status")).toContainText("草稿");
  const latency = report.imported.find((item) =>
    item.title.includes("推理延迟"),
  );
  await page.goto(`/articles/${latency.id}/`);
  await expect(page.locator("#annotation-status")).toContainText("选中正文");
  await page.locator("#article-body").evaluate((article) => {
    const text = "预算是下一次实验的地图，不是这一次结果的奖状。";
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent.indexOf(text);
      if (start === -1) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + text.length);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error("Generated demo quote not found.");
  });
  await page.getByRole("button", { name: "批注选中文字", exact: true }).click();
  await page
    .getByLabel("我的批注", { exact: true })
    .fill(
      "生成演示批注：把假设、预算和证据分别保存，下一次阅读时才容易判断结论适用的范围。",
    );
  await page.getByRole("button", { name: "保存批注", exact: true }).click();
  await expect(page.locator("#annotation-list")).toContainText("生成演示批注");
  await audit(page, "desktop-annotation");
  await page.locator("#annotations").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, "desktop-annotation.png") });
  await page.goto("/workspaces/");
  await page.getByRole("button", { name: "新建主题", exact: true }).click();
  await page
    .getByLabel("主题标题", { exact: true })
    .fill("演示 · 一次可复查的工程研究");
  await page
    .getByLabel("主题说明", { exact: true })
    .fill("全部为生成示例：沿着预算、实验与证据，整理自己的阅读路径。");
  const readingPath = ["推理延迟", "可复现实验", "源码阅读", "复盘结论"].map(
    (term) => report.imported.find((item) => item.title.includes(term)),
  );
  for (const document of readingPath) {
    await page.getByLabel("搜索可加入的文档").fill(document.title);
    await page.locator(`[data-add-document="${document.id}"]`).click();
  }
  await page.getByLabel("新问题").fill("哪些假设需要在真实环境中重新验证？");
  await page.getByRole("button", { name: "添加问题", exact: true }).click();
  await page.getByRole("button", { name: "保存主题", exact: true }).click();
  await expect(page.locator("#ws-status")).toContainText("已保存");
  const workspaceURL = page.url();
  for (const [name, viewport] of Object.entries({
    desktop: { width: 1440, height: 1000 },
    tablet: { width: 768, height: 1024 },
    mobile: { width: 390, height: 844 },
  })) {
    await page.setViewportSize(viewport);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => {
        localStorage.setItem("asher-theme", value);
        document.documentElement.dataset.theme = value;
      }, theme);
      await page.goto(workspaceURL);
      await expect(page.locator("#ws-title")).toHaveValue(
        "演示 · 一次可复查的工程研究",
      );
      await audit(page, `${name}-${theme}-workspace`);
      await page.screenshot({
        path: join(output, `${name}-${theme}-workspace.png`),
        fullPage: true,
      });
      await page.getByRole("tab", { name: "文章对照" }).click();
      await expect(page.locator("#ws-comparison")).toContainText("生成演示");
      await audit(page, `${name}-${theme}-compare`);
      await page.screenshot({
        path: join(output, `${name}-${theme}-compare.png`),
        fullPage: true,
      });
      if (theme === "dark" && name !== "tablet") {
        await page.goto("/");
        await expect(page.locator("h1")).toBeVisible();
        await page.screenshot({
          path: join(output, `${name}-home.png`),
          fullPage: true,
        });
      }
    }
  }
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        generatedOnly: true,
        importedDocuments: 5,
        writtenDocuments: 2,
        publishedDocuments: 6,
        draftDocuments: 1,
        annotations: 1,
        workspaces: 1,
        viewports: ["desktop", "tablet", "mobile"],
        themes: ["dark", "light"],
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(output, "accessibility.json"),
    JSON.stringify(accessibility, null, 2) + "\n",
  );
  console.log(
    "SHOWCASE PASS: uploaded 5 generated documents, wrote 2 documents in the editor, created annotation and workspace; screenshots saved.",
  );
  await context.close();
} finally {
  await browser?.close();
  await service.stop();
}
