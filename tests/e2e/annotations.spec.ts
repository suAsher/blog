import { test as authenticatedTest, expect } from "./fixtures";
import { ContentHarness, sampleContent, unwrap } from "./content-helpers";
import type { Annotation } from "../../src/lib/annotations";
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
async function selectExcerpt(
  page: import("@playwright/test").Page,
  excerpt: string,
) {
  await page.locator("#article-body").evaluate((article, text) => {
    const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const start = node.textContent?.indexOf(text) ?? -1;
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + text.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return;
    }
    throw new Error("QA excerpt missing");
  }, excerpt);
}
test.describe("persisted paragraph annotations", () => {
  test("selects, reloads, edits and turns an excerpt into a new draft note", async ({
    page,
    context,
    content,
  }) => {
    let document = await content.create(
      sampleContent(
        "段落批注",
        "## 阅读\n\n这句值得留下，阅读会长出新的问题。\n\n```js\nconst safe = true;\n```",
      ),
    );
    document = await content.action(document, "publish");
    await page.goto(`/articles/${document.id}/`);
    await expect(page.locator("#annotation-status")).toContainText("选中正文");
    await selectExcerpt(page, "阅读会长出新的问题");
    await page
      .getByRole("button", { name: "批注选中文字", exact: true })
      .click();
    await page
      .getByLabel("我的批注", { exact: true })
      .fill("留给未来的自己 <script>alert(1)</script>");
    await page.getByRole("button", { name: "保存批注", exact: true }).click();
    await expect(page.locator("#annotation-list")).toContainText(
      "留给未来的自己",
    );
    await expect(page.locator("#article-body pre code")).toContainText(
      "const safe = true",
    );
    const { annotations } = await unwrap<{ annotations: Annotation[] }>(
      await context.request.get(`/api/annotations?documentId=${document.id}`),
    );
    expect(annotations).toHaveLength(1);
    await page.reload();
    await expect(page.locator("#annotation-list")).toContainText(
      "<script>alert(1)</script>",
    );
    await expect(page.locator("#annotation-list script")).toHaveCount(0);
    await page.getByRole("button", { name: "编辑批注", exact: true }).click();
    await page.getByLabel("我的批注", { exact: true }).fill("第二次读到这里");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.locator("#annotation-list")).toContainText(
      "第二次读到这里",
    );
    const converted = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/documents") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "摘录为新笔记", exact: true })
      .click();
    const note = await unwrap<DocumentDetail>(await converted);
    content.track(note);
    expect(note.kind).toBe("note");
    expect(note.status).toBe("draft");
    expect(note.source).toContain(
      `/articles/${document.id}/#annotation-${annotations[0].id}`,
    );
    expect(note.source).toContain("阅读会长出新的问题");
    await expect(
      page.getByRole("link", { name: "打开笔记草稿", exact: true }),
    ).toHaveAttribute("href", `/manage/?id=${note.id}`);
    await page.getByRole("button", { name: "删除批注", exact: true }).click();
    await page
      .getByRole("button", { name: "确认删除批注", exact: true })
      .click();
    await expect(page.locator("#annotation-list li")).toHaveCount(0);
  });

  test("keeps unsaved text through a CAS conflict and service failure", async ({
    page,
    context,
    baseURL,
    content,
  }) => {
    let document = await content.create(
      sampleContent("批注冲突", "## 阅读\n\n同一段文字，不同设备上的思考。"),
    );
    document = await content.action(document, "publish");
    const annotation = await unwrap<Annotation>(
      await context.request.post("/api/annotations", {
        headers: { Origin: new URL(baseURL || "").origin },
        data: {
          documentId: document.id,
          quote: {
            exact: "同一段文字",
            prefix: "阅读",
            suffix: "，不同设备上的思考。",
          },
          body: "初稿",
        },
      }),
    );
    await page.goto(`/articles/${document.id}/`);
    await page.getByRole("button", { name: "编辑批注", exact: true }).click();
    await page.getByLabel("我的批注", { exact: true }).fill("我的修改必须保留");
    await unwrap(
      await context.request.put(`/api/annotations/${annotation.id}`, {
        headers: { Origin: new URL(baseURL || "").origin },
        data: { version: annotation.version, body: "另一台设备的修改" },
      }),
    );
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.locator("#annotation-status")).toContainText("冲突");
    await expect(page.getByLabel("我的批注", { exact: true })).toHaveValue(
      "我的修改必须保留",
    );
    await page
      .getByRole("button", { name: "重新读取批注", exact: true })
      .click();
    await expect(page.locator("#annotation-list")).toContainText(
      "另一台设备的修改",
    );
    await page.route(`**/api/annotations/${annotation.id}`, (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, message: "暂时无法保存" }),
      }),
    );
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await expect(page.getByLabel("我的批注", { exact: true })).toHaveValue(
      "我的修改必须保留",
    );
    await expect(page.locator("#annotation-status")).toContainText(
      "暂时无法保存",
    );
  });

  test("reports changed anchors without attaching them to an arbitrary paragraph", async ({
    page,
    context,
    baseURL,
    content,
  }) => {
    let document = await content.create(
      sampleContent(
        "批注锚点变更",
        "## 阅读\n\n原始上下文。摘录句子。原始后文。",
      ),
    );
    document = await content.action(document, "publish");
    await unwrap(
      await context.request.post("/api/annotations", {
        headers: { Origin: new URL(baseURL || "").origin },
        data: {
          documentId: document.id,
          quote: {
            exact: "摘录句子",
            prefix: "原始上下文。",
            suffix: "。原始后文。",
          },
          body: "应该保留来源",
        },
      }),
    );
    document = await content.save(document, {
      source: "## 阅读\n\n全新上下文。摘录句子。全新后文。",
    });
    await content.action(document, "publish");
    await page.goto(`/articles/${document.id}/`);
    await expect(page.locator("#annotation-list")).toContainText(
      "上下文已变化",
    );
    await expect(
      page.getByRole("button", { name: "定位原文", exact: true }),
    ).toBeDisabled();
  });
});

test("can save a new annotation after cancelling an edit deleted on another device", async ({
  page,
  context,
  baseURL,
  content,
}) => {
  let document = await content.create(
    sampleContent(
      "删除后新批注",
      "## 阅读\n\n先前批注的段落，还有一个新的想法。",
    ),
  );
  document = await content.action(document, "publish");
  const annotation = await unwrap<Annotation>(
    await context.request.post("/api/annotations", {
      headers: { Origin: new URL(baseURL || "").origin },
      data: {
        documentId: document.id,
        quote: { exact: "先前批注的段落", prefix: "", suffix: "" },
        body: "原批注",
      },
    }),
  );
  await page.goto(`/articles/${document.id}/`);
  await page.getByRole("button", { name: "编辑批注", exact: true }).click();
  await page.getByLabel("我的批注", { exact: true }).fill("尚未保存的输入");
  await unwrap(
    await context.request.delete(`/api/annotations/${annotation.id}`, {
      headers: { Origin: new URL(baseURL || "").origin },
      data: { version: annotation.version },
    }),
  );
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await page.getByRole("button", { name: "重新读取批注", exact: true }).click();
  await expect(page.locator("#annotation-status")).toContainText("已被删除");
  await expect(page.getByLabel("我的批注", { exact: true })).toHaveValue(
    "尚未保存的输入",
  );
  await page.locator("#annotation-cancel").click();
  await selectExcerpt(page, "还有一个新的想法");
  await page.getByRole("button", { name: "批注选中文字", exact: true }).click();
  await page.getByLabel("我的批注", { exact: true }).fill("新的批注可以保存");
  await expect(
    page.getByRole("button", { name: "保存批注", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "保存批注", exact: true }).click();
  await expect(page.locator("#annotation-list")).toContainText(
    "新的批注可以保存",
  );
});

test("a delayed initial list cannot erase a successfully created annotation", async ({
  page,
  content,
}) => {
  let document = await content.create(
    sampleContent("迟到列表", "## 阅读\n\n新批注应保留在当前列表里。"),
  );
  document = await content.action(document, "publish");
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let first = true;
  let heldRequest: import("@playwright/test").Request | undefined;
  await page.route(
    `**/api/annotations?documentId=${document.id}`,
    async (route) => {
      if (!first) {
        await route.continue();
        return;
      }
      first = false;
      heldRequest = route.request();
      const response = await route.fetch();
      const payload = await response.body();
      started();
      await gate;
      await route.fulfill({ response, body: payload });
    },
  );
  try {
    await page.goto(`/articles/${document.id}/`);
    await waiting;
    await selectExcerpt(page, "新批注应保留");
    await page
      .getByRole("button", { name: "批注选中文字", exact: true })
      .click();
    await page
      .getByLabel("我的批注", { exact: true })
      .fill("保存成功后不能消失");
    await page.getByRole("button", { name: "保存批注", exact: true }).click();
    await expect(page.locator("#annotation-list")).toContainText(
      "保存成功后不能消失",
    );
    const staleFinished = page.waitForResponse(
      (response) => response.request() === heldRequest,
    );
    release();
    await staleFinished;
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect(page.locator("#annotation-list")).toContainText(
      "保存成功后不能消失",
    );
  } finally {
    release();
  }
});
