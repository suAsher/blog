/** Reproduce the generated multi-direction library against an isolated real API. */
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  startPrivateServer,
  readLocalCredentials,
} from "./local-private-server.mjs";

const directions = [
  "go",
  "linux-network",
  "python",
  "git-engineering",
  "containers-delivery",
  "distributed-systems",
  "performance-observability",
  "ai-inference",
];
const output = "docs/qa/learning-catalog";
const service = await startPrivateServer({ port: 4480 });
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
  });
  const login = await context.request.post("/auth/login", {
    headers: { Origin: service.origin },
    data: { username: credentials.username, password: credentials.password },
  });
  if (!login.ok()) throw new Error("Temporary local QA login failed");
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
  const paths = [];
  let documents = 0;
  for (const slug of directions) {
    const manifest = JSON.parse(
      await readFile(`examples/learning/${slug}/index.json`, "utf8"),
    );
    const lessons = manifest.chapters.flatMap((chapter) => chapter.lessons);
    const form = new FormData();
    const files = lessons.map((lesson) => `learning-${slug}/${lesson.file}`);
    form.append("paths", JSON.stringify(files));
    form.append(
      "decisions",
      JSON.stringify({
        requestId: crypto.randomUUID().replaceAll("-", ""),
        paths: files.map((path) => ({ path, action: "create" })),
      }),
    );
    for (const lesson of lessons) {
      const source = await readFile(`examples/learning/${slug}/${lesson.file}`);
      form.append(
        "files",
        new Blob([source], { type: "text/markdown" }),
        lesson.file,
      );
    }
    const response = await context.request.post("/api/import", {
      headers: { Origin: service.origin },
      multipart: form,
    });
    if (!response.ok())
      throw new Error(`Generated import failed: ${slug}: ${response.status()}`);
    const report = (await response.json()).data;
    expect(report.imported).toHaveLength(lessons.length);
    expect(report.unresolvedImages).toHaveLength(0);
    const ids = new Map(report.outcomes.map((value) => [value.path, value.id]));
    for (const item of report.imported) {
      const working = await api("GET", `/api/documents/${item.id}`);
      expect(working.source).toContain("生成演示内容");
      await api("POST", `/api/documents/${item.id}/publish`, {
        version: item.version,
      });
      documents++;
    }
    const chapters = manifest.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      description: chapter.description,
      documentIds: chapter.lessons.map((lesson) =>
        ids.get(`learning-${slug}/${lesson.file}`),
      ),
    }));
    const path = await api("POST", "/api/learning-paths", {
      title: manifest.title,
      description: manifest.description,
      accent: manifest.accent,
      chapters,
    });
    paths.push({
      slug,
      id: path.id,
      title: path.title,
      first: chapters[0].documentIds[0],
      second: chapters[0].documentIds[1],
    });
  }
  expect(documents).toBe(54);
  const graph = await api("GET", "/api/graph?limit=300&view=published");
  expect(graph.nodes).toHaveLength(54);
  expect(graph.edges.length).toBeGreaterThanOrEqual(50);
  for (const path of paths) {
    const links = await api(
      "GET",
      `/api/documents/${path.first}/links?view=published`,
    );
    expect(links.unresolved).toHaveLength(0);
  }
  await mkdir(output, { recursive: true });
  const page = await context.newPage();
  const audits = [];
  for (const [device, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["tablet", { width: 834, height: 1112 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(viewport);
    for (const theme of ["dark", "light"]) {
      await page.goto(
        `/learn/?id=${paths.find((path) => path.slug === "ai-inference").id}`,
      );
      await page.evaluate((theme) => {
        localStorage.setItem("asher-theme", theme);
        document.documentElement.dataset.theme = theme;
      }, theme);
      await expect(page.locator(".learn-path-card")).toHaveCount(8);
      await expect(page.locator("#learn-detail h2")).toHaveText(
        paths.at(-1).title,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const audit = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();
      audits.push({
        device,
        theme,
        violations: audit.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => n.target),
        })),
      });
      await page.screenshot({
        path: `${output}/${device}-${theme}.png`,
        fullPage: true,
      });
      if (audit.violations.length)
        throw new Error(
          `Catalog accessibility failed: ${JSON.stringify(audits.at(-1))}`,
        );
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const linux = paths.find((path) => path.slug === "linux-network");
  await page.getByLabel("我的技术方向", { exact: false }).fill("Linux");
  await expect(page.locator(".learn-path-card")).toHaveCount(1);
  await page.locator(".learn-path-card").click();
  await expect(page.locator("#learn-detail h2")).toHaveText(linux.title);
  await page.screenshot({
    path: `${output}/desktop-linux.png`,
    fullPage: true,
  });
  await page.goto(`/articles/${linux.first}/?path=${linux.id}`);
  const navigation = page.getByRole("region", { name: "技术路线章节导航" });
  await expect(navigation).toContainText("第 1 / 6 篇可读文章");
  await navigation
    .getByRole("button", { name: "完成本节，继续学习 →" })
    .click();
  await expect(page).toHaveURL(
    new URL(`/articles/${linux.second}/?path=${linux.id}`, service.origin).href,
  );
  await expect(navigation).toContainText("第 2 / 6 篇可读文章");
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      {
        generatedOnly: true,
        directions: 8,
        documents,
        chapters: 27,
        uploadedThroughRealImport: true,
        filterAndContinue: "passed",
        graphNodes: graph.nodes.length,
        graphEdges: graph.edges.length,
        audits,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "PASS: 8 directions / 27 chapters / 54 published examples / 6 Axe states / real import and continue",
  );
} finally {
  await browser?.close();
  await service.stop();
}
