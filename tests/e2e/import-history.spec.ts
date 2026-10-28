import { test as authenticatedTest, expect } from "./fixtures";
import {
  ContentHarness,
  sampleContent,
  uniqueName,
  unwrap,
  importForm,
} from "./content-helpers";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { SavedImportReport } from "../../src/lib/import-inbox";
import type { DocumentDetail } from "../../src/lib/documents";

const test = authenticatedTest.extend<{ content: ContentHarness }>({
  content: async ({ context, baseURL }, use) => {
    const content = new ContentHarness(context.request, baseURL || "");
    try {
      await use(content);
    } finally {
      await content.cleanup();
    }
  },
});

test("republishing an image-only import explains that the rendered images changed", async ({
  page,
  context,
  baseURL,
  content,
}) => {
  const title = uniqueName("配图发布对照");
  const source = `---\ntitle: "${title}"\n---\n\n## 配图验收\n\n![演示配图](picture.png)`;
  const first = await readFile(
    new URL(
      "../../examples/research/import-bundle/images/latency-budget.png",
      import.meta.url,
    ),
  );
  const second = await readFile(
    new URL(
      "../../examples/research/import-bundle/images/evidence-loop.png",
      import.meta.url,
    ),
  );
  const imported = await content.import([
    { path: "image-note.md", buffer: Buffer.from(source) },
    { path: "picture.png", buffer: first, mimeType: "image/png" },
  ]);
  const document = await content.action(
    await content.get(imported.imported[0].id),
    "publish",
  );
  const form = importForm([
    { path: "image-note.md", buffer: Buffer.from(source) },
    { path: "picture.png", buffer: second, mimeType: "image/png" },
  ]);
  form.append(
    "decisions",
    JSON.stringify({
      requestId: randomUUID().replaceAll("-", ""),
      paths: [
        {
          path: "image-note.md",
          action: "update",
          existingId: document.id,
          version: document.version,
        },
      ],
    }),
  );
  await unwrap(
    await context.request.post("/api/import", {
      headers: { Origin: baseURL! },
      multipart: form,
    }),
  );
  const working = await content.get(document.id);
  const published = await content.get(document.id, true);
  expect(working.source).toBe(published.source);
  expect(working.html).not.toBe(published.html);
  await page.goto(`/manage/?id=${document.id}`);
  await expect(page.locator("#publish-document")).toContainText("发布");
  await page.locator("#publish-document").click();
  await expect(page.locator("#publish-comparison")).toContainText("渲染内容");
  await expect(page.locator("#publish-comparison")).not.toContainText(
    "均无变化",
  );
  await page.locator("#cancel-publish-review").click();
});

test("import previews actual content and lets the owner update an existing path and reopen its report", async ({
  page,
  content,
}) => {
  const path = `qa-${uniqueName("import").replaceAll(" ", "-")}.md`;
  const title = uniqueName("导入检查");
  await page.goto("/manage/?import=1");
  await page.locator("#import-files").setInputFiles({
    name: path,
    mimeType: "text/markdown",
    buffer: Buffer.from(
      `---\ntitle: "${title}"\n---\n\nfirst body\n\n![missing](missing.png)`,
    ),
  });
  await expect(page.locator("#import-preview")).toContainText(title);
  await expect(page.locator("#import-preview")).toContainText("新文档");
  await expect(page.locator("#import-preview")).toContainText("missing.png");
  const imported = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/import" &&
      response.request().method() === "POST",
  );
  await page.locator("#confirm-import").click();
  const report = await unwrap<SavedImportReport>(await imported);
  report.imported.forEach((item) => content.track(item));
  await expect(page.locator("#import-report")).toContainText(
    "1 篇文档已导入为草稿",
  );
  await page.locator("#import-files").setInputFiles({
    name: path,
    mimeType: "text/markdown",
    buffer: Buffer.from(`---\ntitle: "${title}"\n---\n\nupdated body`),
  });
  await expect(page.locator("#import-preview")).toContainText("内容有变化");
  await page.getByLabel(`导入操作：${path}`).selectOption("update");
  const updated = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/import" &&
      response.request().method() === "POST",
  );
  await page.locator("#confirm-import").click();
  const updatedReport = await unwrap<SavedImportReport>(await updated);
  expect(updatedReport.updated[0].id).toBe(report.imported[0].id);
  expect((await content.get(report.imported[0].id)).source).toContain(
    "updated body",
  );
  await page.reload();
  await page.locator("#open-import").click();
  await page.locator("#open-import-reports").click();
  await expect(page.locator("#import-report-history")).toContainText(
    "更新 1 篇",
  );
  await page.locator("#import-report-history button").first().click();
  await expect(page.locator("#import-report")).toContainText("更新 1 篇");
});

test("revision restore changes only the working copy and republish requires reviewing the live diff", async ({
  page,
  content,
}) => {
  let doc = await content.create(
    sampleContent("历史比较", "published original"),
  );
  doc = await content.action(doc, "publish");
  const originalTitle = doc.title;
  doc = await content.save(doc, {
    title: originalTitle + " updated",
    source: "working revision two",
  });
  await page.goto(`/manage/?id=${doc.id}`);
  await page.locator("#document-source").fill("working revision three");
  await page.locator("#open-document-history").click();
  await expect(page.locator("#history-dialog")).toBeVisible();
  await expect(page.locator("#revision-list button")).not.toHaveCount(0);
  await page.locator("#revision-list button").last().click();
  await expect(page.locator("#revision-comparison")).toContainText(
    "published original",
  );
  await page.locator("#restore-revision").click();
  await expect(page.locator("#history-dialog")).not.toBeVisible();
  await expect(page.locator("#document-source")).toHaveValue(
    "published original",
  );
  expect((await content.get(doc.id, true)).source).toBe("published original");
  await page.locator("#document-source").fill("explicitly republished");
  await page.locator("#publish-document").click();
  await expect(page.locator("#publish-review-dialog")).toBeVisible();
  await expect(page.locator("#publish-comparison")).toContainText(
    "explicitly republished",
  );
  expect((await content.get(doc.id, true)).source).toBe("published original");
  const published = page.waitForResponse(
    (response) =>
      response.url().includes(`/${doc.id}/publish`) &&
      response.request().method() === "POST",
  );
  await page.locator("#confirm-publish").click();
  const result = await unwrap<DocumentDetail>(await published);
  expect(result.hasUnpublishedChanges).toBe(false);
  expect((await content.get(doc.id, true)).source).toBe(
    "explicitly republished",
  );
});
