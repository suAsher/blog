/** Real private-service reading QA with generated sources, never production access. */
import { chromium, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  startPrivateServer,
  readLocalCredentials,
} from "./local-private-server.mjs";

const service = await startPrivateServer({ port: 4486 });
const output = "docs/qa/field-guides";
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
    viewport: { width: 1440, height: 1000 },
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
  async function importDocuments(files) {
    const form = new FormData();
    form.append("paths", JSON.stringify(files.map((file) => file.path)));
    form.append(
      "decisions",
      JSON.stringify({
        requestId: crypto.randomUUID().replaceAll("-", ""),
        paths: files.map((file) => ({ path: file.path, action: "create" })),
      }),
    );
    for (const file of files)
      form.append(
        "files",
        new Blob([file.source], { type: "text/markdown" }),
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
    const map = new Map();
    for (const item of report.imported) {
      const published = await api("POST", `/api/documents/${item.id}/publish`, {
        version: item.version,
      });
      map.set(
        report.outcomes.find((value) => value.id === item.id).path,
        published,
      );
    }
    return map;
  }
  const paths = new Map();
  for (const direction of ["go", "linux-network", "ai-inference"]) {
    const meta = JSON.parse(
      await readFile(`examples/learning/${direction}/index.json`, "utf8"),
    );
    const files = [];
    for (const lesson of meta.chapters.flatMap((chapter) => chapter.lessons))
      files.push({
        path: `${direction}/${lesson.file}`,
        source: await readFile(`examples/learning/${direction}/${lesson.file}`),
      });
    const docs = await importDocuments(files);
    const chapters = meta.chapters.map((chapter) => ({
      id: chapter.id,
      title: chapter.title,
      description: chapter.description,
      documentIds: chapter.lessons.map(
        (lesson) => docs.get(`${direction}/${lesson.file}`).id,
      ),
    }));
    paths.set(
      direction,
      await api("POST", "/api/learning-paths", {
        title: meta.title,
        description: meta.description,
        accent: meta.accent,
        chapters,
      }),
    );
  }
  const slugs = [
    ["inference", "ai-inference"],
    ["go-request", "go"],
    ["linux-network", "linux-network"],
  ];
  const files = [];
  for (const [slug] of slugs)
    files.push({
      path: `field-guides/${slug}.md`,
      source: await readFile(`examples/field-guides/${slug}.md`),
    });
  for (const [slug] of slugs)
    files.push({
      path: `field-guides/images/${slug}.png`,
      source: await readFile(`examples/field-guides/images/${slug}.png`),
    });
  const documents = await importDocuments(files);
  const urls = new Map();
  for (const [slug, direction] of slugs) {
    const document = documents.get(`field-guides/${slug}.md`),
      path = paths.get(direction);
    const chapters = [
      {
        id: `guide-${slug}`,
        title: "深度导读",
        description: "图解与实验",
        documentIds: [document.id],
      },
      ...path.chapters,
    ];
    await api("PUT", `/api/learning-paths/${path.id}`, {
      title: path.title,
      description: path.description,
      accent: path.accent,
      version: path.version,
      chapters,
    });
    urls.set(slug, `/articles/${document.id}/?path=${path.id}`);
  }
  await mkdir(output, { recursive: true });
  const page = await context.newPage(),
    audits = [];
  for (const [device, viewport] of [
    ["desktop", { width: 1440, height: 1000 }],
    ["tablet", { width: 834, height: 1112 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    await page.setViewportSize(viewport);
    for (const theme of ["dark", "light"]) {
      for (const [slug] of device === "desktop" ? slugs : [slugs[0]]) {
        await page.goto(urls.get(slug));
        await page.evaluate((value) => {
          localStorage.setItem("asher-theme", value);
          document.documentElement.dataset.theme = value;
        }, theme);
        await expect(page.locator("#article-overview")).toBeVisible();
        await expect(page.locator("#reader-route-outline")).toBeAttached();
        await page.screenshot({
          path: `${output}/${device}-${theme}-${slug}-hero.png`,
        });
        const widget = page.locator(".explore-widget");
        await widget.scrollIntoViewIfNeeded();
        await expect(widget.locator("input,select").first()).toBeVisible();
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        const result = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        audits.push({
          device,
          theme,
          slug,
          violations: result.violations.map((item) => ({
            id: item.id,
            message: item.nodes.map((node) => node.failureSummary),
            nodes: item.nodes.map((node) => node.target),
          })),
        });
        await page.screenshot({
          path: `${output}/${device}-${theme}-${slug}-experiment.png`,
        });
        if (result.violations.length)
          throw new Error(JSON.stringify(audits.at(-1)));
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(urls.get("go-request"));
  await page.locator(".explore-widget").scrollIntoViewIfNeeded();
  const go = page.getByLabel("请求场景", { exact: true });
  await go.scrollIntoViewIfNeeded();
  await go.selectOption("timeout");
  for (let i = 0; i < 4; i++)
    await page
      .locator(".explore-widget")
      .getByRole("button", { name: "下一步", exact: true })
      .click();
  await expect(page.locator(".explore-result")).toContainText("503");
  await page.goto(urls.get("linux-network"));
  await page.locator(".explore-widget").scrollIntoViewIfNeeded();
  const network = page.getByLabel("诊断场景", { exact: true });
  await network.scrollIntoViewIfNeeded();
  await network.selectOption("http");
  for (let i = 0; i < 2; i++)
    await page
      .locator(".explore-widget")
      .getByRole("button", { name: "下一步", exact: true })
      .click();
  await expect(page.locator(".explore-result")).toContainText("500");
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      {
        generatedOnly: true,
        guides: 3,
        baseArticles: 24,
        audits,
        scenarios: "Go timeout 503 and HTTP failure 500 passed",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS: 3 long guides / 24 foundation articles / ${audits.length} Axe states / 3 viewports / 2 themes`,
  );
} finally {
  await browser?.close();
  await service.stop();
}
