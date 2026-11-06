/** Generated-only, real local Go import/publish and browser QA. No production access. */
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  startPrivateServer,
  readLocalCredentials,
} from "./local-private-server.mjs";

const output = "docs/qa/learning-v2";
const service = await startPrivateServer({ port: 4491 });
const viewports = [
  ["desktop", { width: 1440, height: 1000 }],
  ["tablet", { width: 834, height: 1112 }],
  ["mobile", { width: 390, height: 844 }],
];
let browser;
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
    viewport: viewports[0][1],
    reducedMotion: "reduce",
  });
  const login = await context.request.post("/auth/login", {
    headers: { Origin: service.origin },
    data: { username: credentials.username, password: credentials.password },
  });
  if (!login.ok()) throw new Error("Local private QA login failed");
  const api = async (method, path, data) => {
    const response = await context.request.fetch(path, {
      method,
      data,
      headers: { Origin: service.origin },
    });
    if (!response.ok())
      throw new Error(`${method} ${path}: ${response.status()}`);
    return (await response.json()).data;
  };
  async function upload(files) {
    const form = new FormData();
    form.append("paths", JSON.stringify(files.map((file) => file.path)));
    form.append(
      "decisions",
      JSON.stringify({
        requestId: crypto.randomUUID().replaceAll("-", ""),
        paths: files
          .filter((file) => file.path.endsWith(".md"))
          .map((file) => ({ path: file.path, action: "create" })),
      }),
    );
    for (const file of files)
      form.append(
        "files",
        new Blob([file.source]),
        file.path.split("/").at(-1),
      );
    const response = await context.request.post("/api/import", {
      headers: { Origin: service.origin },
      multipart: form,
    });
    if (!response.ok())
      throw new Error(`Generated upload failed: ${response.status()}`);
    const report = (await response.json()).data;
    expect(report.imported).toHaveLength(
      files.filter((file) => file.path.endsWith(".md")).length,
    );
    expect(report.unresolvedImages).toHaveLength(0);
    return report;
  }
  const meta = JSON.parse(
    await readFile("examples/ai-infrastructure/index.json", "utf8"),
  );
  const files = await Promise.all(
    meta.chapters
      .filter((chapter) => chapter.file)
      .map(async (chapter) => ({
        path: `ai-infrastructure/${chapter.file}`,
        source: await readFile(`examples/ai-infrastructure/${chapter.file}`),
      })),
  );
  files.push(
    {
      path: "field-guides/inference.md",
      source: await readFile("examples/field-guides/inference.md"),
    },
    {
      path: "field-guides/images/inference.png",
      source: await readFile("examples/field-guides/images/inference.png"),
    },
  );
  const report = await upload(files);
  const byPath = new Map();
  for (const item of report.imported) {
    const published = await api("POST", `/api/documents/${item.id}/publish`, {
      version: item.version,
    });
    byPath.set(
      report.outcomes.find((outcome) => outcome.id === item.id).path,
      published,
    );
  }
  const route = await api("POST", "/api/learning-paths", {
    title: meta.title,
    description: meta.description,
    accent: meta.accent,
    objectives: meta.objectives,
    prerequisites: meta.prerequisites,
    chapters: meta.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      description: "",
      goal: chapter.goal,
      exercise: chapter.exercise,
      practiced: false,
      documentIds: [
        byPath.get(
          chapter.file
            ? `ai-infrastructure/${chapter.file}`
            : "field-guides/inference.md",
        ).id,
      ],
    })),
  });
  const guide = byPath.get("field-guides/inference.md");
  const lesson = byPath.get("ai-infrastructure/02-load-model.md");
  const recallDraft = await api("POST", "/api/documents", {
    title: "生成演示 · 为什么排队会拉长首响？",
    description: "先解释，再核对原文。",
    date: "2026-10-31",
    tags: ["生成演示"],
    category: "",
    cover: "",
    kind: "note",
    source:
      "```recall\n" +
      JSON.stringify({
        question:
          "为什么增加并发后，即使单次计算没有变慢，首个响应仍可能变迟？",
        answer:
          "当服务槽已被占用时，新请求先排队。首响包含排队、输入处理和产生首个输出的等待；需要分别观察，不能直接把首响变慢归因于模型计算。这里讨论确定性教学模型，真实服务还需测量各阶段。",
        source: `/articles/${guide.id}/`,
      }) +
      "\n```\n",
  });
  const recall = await api("POST", `/api/documents/${recallDraft.id}/publish`, {
    version: recallDraft.version,
  });
  await mkdir(output, { recursive: true });
  const page = await context.newPage();
  const audits = [],
    screenshots = [];
  async function theme(value) {
    await page.evaluate((value) => {
      localStorage.setItem("asher-theme", value);
      document.documentElement.dataset.theme = value;
    }, value);
  }
  async function capture(name) {
    await page.screenshot({ path: `${output}/${name}.png` });
    screenshots.push(`${name}.png`);
  }
  async function audit(view, device, selectedTheme) {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const violations = result.violations.map((item) => ({
      id: item.id,
      nodes: item.nodes.map((node) => node.target),
    }));
    audits.push({ view, device, theme: selectedTheme, violations });
    if (violations.length)
      throw new Error(`Accessibility: ${JSON.stringify(audits.at(-1))}`);
  }
  for (const [device, viewport] of viewports) {
    await page.setViewportSize(viewport);
    for (const selectedTheme of ["dark", "light"]) {
      await page.goto(`/learn/?id=${route.id}`);
      await theme(selectedTheme);
      await expect(page.locator("#learn-detail h2")).toHaveText(meta.title);
      await expect(page.locator(".learn-chapter")).toHaveCount(7);
      await capture(`${device}-${selectedTheme}-route-hero`);
      await page.locator("#learn-detail").scrollIntoViewIfNeeded();
      await page.evaluate(() =>
        window.scrollTo(
          0,
          document.getElementById("learn-detail").getBoundingClientRect().top +
            scrollY -
            100,
        ),
      );
      await capture(`${device}-${selectedTheme}-route-detail`);
      await audit("route", device, selectedTheme);

      await page.goto(`/articles/${lesson.id}/?path=${route.id}`);
      await expect(page.locator("#live-title")).toHaveText(lesson.title);
      await expect(page.locator("#article-body")).toContainText("生成演示");
      await capture(`${device}-${selectedTheme}-lesson-hero`);
      const code = page.locator('#article-body pre[data-language="python"]');
      await expect(code).toHaveCount(1);
      await code.evaluate((node) => window.scrollTo({
        top: node.getBoundingClientRect().top + scrollY - 140,
        behavior: "instant",
      }));
      await capture(`${device}-${selectedTheme}-lesson-code`);
      await expect(page.locator(".recall-widget")).toHaveCount(1);
      await audit("deep-lesson", device, selectedTheme);
    }
  }
  for (const [device, viewport, selectedTheme] of [
    ["desktop", viewports[0][1], "dark"],
    ["mobile", viewports[2][1], "light"],
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`/manage/?id=${guide.id}`);
    await theme(selectedTheme);
    await expect(page.locator("#document-source")).toHaveValue(/请求/);
    await page.getByRole("button", { name: "从模板新建", exact: true }).click();
    await expect(page.locator("#writing-template-preview")).toContainText(
      "验证结果",
    );
    await capture(`${device}-${selectedTheme}-writing-templates`);
    await audit("writing-templates", device, selectedTheme);
    await page.locator("#close-writing-template").click();

    await page.locator("#configure-explorer").click();
    await page.getByLabel("教学模型", { exact: true }).selectOption("network");
    await page.getByLabel(/实验标题/).fill("从一个症状，定位失败的层次");
    await expect(
      page.locator("#explorer-config-preview .explore-body select"),
    ).toBeVisible();
    await capture(`${device}-${selectedTheme}-experiment-authoring`);
    await audit("experiment-authoring", device, selectedTheme);
    await page.locator("#close-explorer-config").click();

    const imported = await upload([
      {
        path: "我的工程笔记/01 请求与接口/请求边界.md",
        source:
          "---\ntitle: 生成演示 · 请求边界\n---\n\n## 观察\n\n记录输入与输出之间的约定。",
      },
      {
        path: "我的工程笔记/02 观察与验证/观察窗口.md",
        source:
          "---\ntitle: 生成演示 · 观察窗口\n---\n\n## 实践\n\n明确指标的起点、终点与单位。",
      },
      {
        path: "我的工程笔记/02 观察与验证/失败分析.md",
        source:
          "---\ntitle: 生成演示 · 失败分析\n---\n\n## 排查\n\n保留假设、证据与验证结果。",
      },
    ]);
    await page.getByRole("button", { name: "导入文档", exact: true }).click();
    await page
      .getByRole("button", { name: "查看最近导入报告", exact: true })
      .click();
    await page.locator(`[data-import-report="${imported.id}"]`).click();
    await page
      .getByRole("button", { name: "编排为学习路线", exact: true })
      .click();
    await expect(page.locator(".import-route-lesson")).toHaveCount(3);
    await page.locator(".import-route-form").scrollIntoViewIfNeeded();
    await capture(`${device}-${selectedTheme}-import-arrangement`);
    await audit("import-arrangement", device, selectedTheme);
    const arranged = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/learning-paths" &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "确认创建学习路线", exact: true })
      .click();
    const result = (await (await arranged).json()).data;
    expect(result.chapters).toHaveLength(2);
    expect(
      result.chapters.flatMap((chapter) => chapter.documentIds),
    ).toHaveLength(3);
    for (const document of imported.imported)
      expect((await api("GET", `/api/documents/${document.id}`)).status).toBe(
        "draft",
      );
    await page.locator("#close-import").click();

    await page.goto(`/articles/${recall.id}/`);
    await expect(page.locator(".recall-widget")).toBeVisible();
    await page.locator(".recall-widget").scrollIntoViewIfNeeded();
    await page.locator(".recall-answer summary").click();
    await expect(page.locator(".recall-answer-text")).toBeVisible();
    await capture(`${device}-${selectedTheme}-recall`);
    await audit("recall", device, selectedTheme);
  }
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        generatedOnly: true,
        environment:
          "Local loopback HTTPS, real Go authentication and content store, ephemeral random credentials",
        chapters: 7,
        deepArticles: 6,
        existingGuide: 1,
        viewports: 3,
        themes: 2,
        importedDraftsPreserved: 6,
        arrangedRoutes: 2,
        audits,
        screenshots,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS: 7 chapters / 6 deep articles + guide / ${audits.length} Axe states / ${screenshots.length} screenshots`,
  );
} finally {
  await browser?.close();
  await service.stop();
}
