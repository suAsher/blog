/** Isolated local QA: generated Go lessons, a real private API, Chrome and Axe. */
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  startPrivateServer,
  readLocalCredentials,
} from "./local-private-server.mjs";

const output = "docs/qa/learning";
const service = await startPrivateServer({ port: 4466 });
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
  if (login.status() !== 200) throw new Error("Local fixture login failed");
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
  const manifest = JSON.parse(
    await readFile("examples/learning/go/index.json", "utf8"),
  );
  const chapters = [];
  for (const chapter of manifest.chapters) {
    const documentIds = [];
    for (const lesson of chapter.lessons) {
      const raw = await readFile(`examples/learning/go/${lesson.file}`, "utf8");
      const source = raw.replace(/^---\n[\s\S]*?\n---\n/, "");
      let document = await api("POST", "/api/documents", {
        title: lesson.title,
        description: lesson.description,
        source,
        tags: ["生成演示", "Go"],
        date: "2026-10-29",
        category: "",
        cover: "",
      });
      document = await api("POST", `/api/documents/${document.id}/publish`, {
        version: document.version,
      });
      documentIds.push(document.id);
    }
    chapters.push({
      id: chapter.id,
      title: chapter.title,
      description: chapter.description,
      documentIds,
    });
  }
  const path = await api("POST", "/api/learning-paths", {
    title: manifest.title,
    description: manifest.description,
    accent: manifest.accent,
    chapters,
  });
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
      await page.goto(`/learn/?id=${path.id}`);
      await page.evaluate((value) => {
        localStorage.setItem("asher-theme", value);
        document.documentElement.dataset.theme = value;
      }, theme);
      await expect(
        page.getByRole("heading", { name: manifest.title, exact: true }),
      ).toBeVisible();
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
        throw new Error(`Accessibility: ${JSON.stringify(audits.at(-1))}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "整理章节", exact: true }).click();
  await expect(page.locator("#learn-dialog")).toBeVisible();
  const editorAudit = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  audits.push({
    view: "editor",
    violations: editorAudit.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
  });
  await page.screenshot({
    path: `${output}/desktop-editor.png`,
    fullPage: true,
  });
  if (editorAudit.violations.length)
    throw new Error(`Editor accessibility failed: ${JSON.stringify(audits.at(-1))}`);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.goto(`/articles/${chapters[0].documentIds[0]}/?path=${path.id}`);
  await expect(
    page.getByRole("region", { name: "技术路线章节导航" }),
  ).toContainText("第 1 / 12 篇可读文章");
  await page.screenshot({
    path: `${output}/desktop-reader.png`,
    fullPage: true,
  });
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      {
        generatedOnly: true,
        chapters: 6,
        documents: 12,
        viewports: 3,
        themes: 2,
        audits,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    "PASS: 6 chapters / 12 generated lessons / 7 Axe views / responsive screenshots",
  );
} finally {
  await browser?.close();
  await service.stop();
}
