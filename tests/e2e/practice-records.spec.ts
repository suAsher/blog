import { test, expect } from "./fixtures";
import {
  ContentHarness,
  sampleContent,
  uniqueName,
  unwrap,
} from "./content-helpers";
import type { LearningPath } from "../../src/lib/learning-paths";
import type { DocumentDetail } from "../../src/lib/documents";

async function createRoute(content: ContentHarness) {
  return unwrap<LearningPath>(
    await content.request.post("/api/learning-paths", {
      headers: { Origin: content.origin },
      data: {
        title: uniqueName("实践成果"),
        description: "把理解变成可复现的证据",
        accent: "blue",
        chapters: [
          {
            id: "first",
            title: "动手验证",
            description: "",
            documentIds: [],
            exercise: "记录一次实验",
          },
        ],
      },
    }),
  );
}
async function removeRoute(content: ContentHarness, id: string) {
  if (!id) return;
  const current = await unwrap<LearningPath>(
    await content.request.get(`/api/learning-paths/${id}`),
  );
  await content.request.delete(`/api/learning-paths/${id}`, {
    headers: { Origin: content.origin },
    data: { version: current.version },
  });
}

test("chapter evidence can be created, reopened and unlinked without changing practice completion", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  let id = "";
  try {
    const route = await createRoute(content);
    id = route.id;
    await page.goto(`/learn/?id=${id}`);
    await page
      .getByRole("button", { name: "新建实践记录", exact: true })
      .click();
    const title = uniqueName("亲手验证");
    const dialog = page.getByRole("dialog", { name: "记录这次实践" });
    await dialog.getByLabel("记录标题", { exact: true }).fill(title);
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/documents") &&
        response.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "创建草稿并关联", exact: true })
      .click();
    const document = await unwrap<DocumentDetail>(await createdResponse);
    content.track(document);
    expect(document.status).toBe("draft");
    expect(document.source).toContain("## 失败原因");
    await expect(dialog.getByRole("status")).toContainText("已关联");
    await expect(
      dialog.getByRole("link", { name: "继续写作", exact: true }),
    ).toHaveAttribute("href", `/manage/?id=${document.id}`);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(page.locator(".learn-record-list")).toContainText(title);
    await expect(
      page.locator(".learn-record-list").getByRole("link", {
        name: `继续写作 ↗：${title}`,
        exact: true,
      }),
    ).toHaveAttribute("href", `/manage/?id=${document.id}`);
    await expect(page.locator(".learn-practice-toggle")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.locator(".learn-completion")).toHaveText("0%");
    await page.reload();
    await expect(page.locator(".learn-record-list")).toContainText(title);
    await page
      .getByRole("button", { name: `移除关联：${title}`, exact: true })
      .click();
    await expect(page.locator(".learn-record-list")).not.toContainText(title);
    expect((await content.get(document.id)).status).toBe("draft");
  } finally {
    await removeRoute(content, id);
    await content.cleanup();
  }
});

test("a created practice draft survives route conflict and recovery preserves remote changes", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  let id = "";
  try {
    const route = await createRoute(content);
    id = route.id;
    await page.goto(`/learn/?id=${id}`);
    await page
      .getByRole("button", { name: "新建实践记录", exact: true })
      .click();
    await unwrap<LearningPath>(
      await context.request.put(`/api/learning-paths/${id}`, {
        headers: { Origin: content.origin },
        data: {
          title: route.title,
          description: "另一台设备的补充",
          accent: route.accent,
          chapters: route.chapters,
          version: route.version,
        },
      }),
    );
    const dialog = page.getByRole("dialog", { name: "记录这次实践" });
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/documents") &&
        response.request().method() === "POST",
    );
    await dialog
      .getByRole("button", { name: "创建草稿并关联", exact: true })
      .click();
    const document = await unwrap<DocumentDetail>(await createdResponse);
    content.track(document);
    await expect(dialog.getByRole("status")).toContainText("草稿已保存");
    await expect(dialog.getByRole("status")).toContainText("尚未关联");
    await expect(
      dialog.getByRole("link", { name: "继续写作", exact: true }),
    ).toHaveAttribute("href", `/manage/?id=${document.id}`);
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "恢复关联", exact: true }).click();
    await dialog
      .getByRole("button", { name: "读取最新路线", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toContainText("已读取最新路线");
    await dialog
      .getByRole("button", { name: "确认关联到最新路线", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toContainText("已关联");
    const saved = await unwrap<LearningPath>(
      await context.request.get(`/api/learning-paths/${id}`),
    );
    expect(saved.description).toBe("另一台设备的补充");
    expect(saved.chapters[0].practiceDocumentIds).toEqual([document.id]);
    expect(saved.chapters[0].practiced).not.toBe(true);
  } finally {
    await removeRoute(content, id);
    await content.cleanup();
  }
});

test("existing published evidence is readable and unavailable evidence remains removable", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  let id = "";
  try {
    const document = await content.action(
      await content.create(sampleContent("已有成果")),
      "publish",
    );
    const route = await createRoute(content);
    id = route.id;
    await page.goto(`/learn/?id=${id}`);
    await page
      .getByRole("button", { name: "关联已有文档", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "记录这次实践" });
    // The wrapping label contains option text; use the computed accessible name.
    await dialog
      .getByRole("combobox", { name: "选择已有文档", exact: true })
      .selectOption(document.id);
    await dialog
      .getByRole("button", { name: "关联所选文档", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toContainText("已关联");
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(
      page
        .locator(".learn-record-list")
        .getByRole("link", { name: document.title, exact: true }),
    ).toHaveAttribute("href", `/articles/${document.id}/?path=${id}`);
    await content.action(document, "trash");
    await page.reload();
    await expect(page.locator(".learn-record-list")).toContainText(
      "实践记录暂不可用",
    );
    await page
      .getByRole("button", {
        name: "移除关联：暂不可用的记录",
        exact: true,
      })
      .click();
    await expect(page.locator(".learn-record-list")).not.toContainText(
      "实践记录暂不可用",
    );
  } finally {
    await removeRoute(content, id);
    await content.cleanup();
  }
});

test("lost draft-creation response never automatically creates a duplicate", async ({
  page,
  context,
  baseURL,
}) => {
  const content = new ContentHarness(context.request, baseURL!);
  let id = "",
    creates = 0;
  try {
    const route = await createRoute(content);
    id = route.id;
    await page.goto(`/learn/?id=${id}`);
    await page
      .getByRole("button", { name: "新建实践记录", exact: true })
      .click();
    await page.route("**/api/documents", async (intercept) => {
      if (intercept.request().method() !== "POST") return intercept.continue();
      creates++;
      const response = await intercept.fetch();
      content.track(await unwrap<DocumentDetail>(response));
      await intercept.abort("connectionreset");
    });
    const dialog = page.getByRole("dialog", { name: "记录这次实践" });
    await dialog
      .getByRole("button", { name: "创建草稿并关联", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toContainText("可能已创建");
    await expect(
      dialog.getByRole("button", { name: "创建草稿并关联", exact: true }),
    ).toBeDisabled();
    await expect(
      dialog.getByRole("link", { name: "到写作空间检查草稿", exact: true }),
    ).toHaveAttribute("href", "/manage/");
    expect(creates).toBe(1);
  } finally {
    await page.unroute("**/api/documents");
    await removeRoute(content, id);
    await content.cleanup();
  }
});
