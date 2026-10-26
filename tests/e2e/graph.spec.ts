import { test as authenticatedTest, expect } from "./fixtures";
import { ContentHarness, sampleContent } from "./content-helpers";

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

test.describe("knowledge graph", () => {
  test.skip(
    !process.env.BLOG_TEST_SSH_TARGET &&
      process.env.BLOG_TEST_LOCAL_AUTH !== "1",
    "Requires the private document API.",
  );

  test("renders the published graph with search, keyboard navigation and bounded canvas", async ({
    page,
    content,
  }) => {
    const target = await content.create({
      ...sampleContent("图谱目标"),
      tags: ["systems"],
    });
    let source = await content.create(
      sampleContent("图谱来源", `[[${target.id}|${target.title}]]`),
    );
    await content.action(target, "publish");
    source = await content.action(source, "publish");

    const requests: string[] = [];
    page.on("request", (request) => requests.push(request.url()));
    await page.goto("/graph/");
    await expect(page.getByRole("heading", { name: "知识星图" })).toBeVisible();
    await expect(page.locator("#knowledge-graph-canvas")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
    const canvas = page.locator("#knowledge-graph-canvas");
    const bounds = await canvas.boundingBox();
    if (bounds) {
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width / 2 + 28, bounds.y + bounds.height / 2 + 18);
      await page.mouse.up();
      await expect(page).toHaveURL(/\/graph\/$/);
    }
    await expect(
      page.locator("#graph-node-list").getByRole("link", { name: target.title }),
    ).toBeVisible();
    await expect(
      page.locator("#graph-node-list").getByRole("link", { name: source.title }),
    ).toBeVisible();
    await page.getByRole("searchbox", { name: "搜索知识节点" }).fill(source.title);
    const result = page.locator("#graph-node-list").getByRole("link", {
      name: source.title,
    });
    await expect(result).toBeVisible();
    await result.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`/articles/${source.id}/`);
    expect(requests.some((url) => /gsap|lenis/i.test(url))).toBe(false);
  });

  test("uses one static reduced-motion layout without a continuous force loop", async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/api/graph?**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            nodes: [
              { id: "1".repeat(32), title: "Static one", tags: [], kind: "article" },
              { id: "2".repeat(32), title: "Static two", tags: ["calm"], kind: "article" },
            ],
            edges: [
              { source: "1".repeat(32), target: "2".repeat(32), kind: "wiki" },
            ],
            totalNodes: 2,
            totalEdges: 1,
            truncated: false,
          },
        }),
      }),
    );
    await page.goto("/graph/");
    await expect(page.locator("#graph-stage")).toHaveAttribute(
      "data-load-state",
      "ready",
    );
    await expect(page.locator("#graph-stage")).toHaveAttribute(
      "data-layout-mode",
      "static",
    );
    await expect(page.locator("#graph-stage")).toHaveAttribute(
      "data-layout-ready",
      "true",
    );
    await expect(page.locator("#graph-stage")).toHaveAttribute(
      "data-worker-state",
      "converged",
    );
  });

  test("shows honest empty and retryable failure states", async ({ page }) => {
    let failed = false;
    await page.route("**/api/graph?**", (route) =>
      failed
        ? route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ ok: false, message: "temporary" }),
          })
        : route.fulfill({
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              data: {
                nodes: [], edges: [], totalNodes: 0, totalEdges: 0, truncated: false,
              },
            }),
          }),
    );
    await page.goto("/graph/");
    await expect(page.locator("#graph-state")).toContainText("还没有已发布的知识节点");
    failed = true;
    await page.reload();
    await expect(page.locator("#graph-state")).toContainText("暂时无法读取");
    await expect(page.locator("#graph-retry")).toBeVisible();
    failed = false;
    await page.locator("#graph-retry").click();
    await expect(page.locator("#graph-state")).toContainText("还没有已发布的知识节点");
  });

  test("keeps the full 300-node budget usable without page overflow", async ({ page }) => {
    const nodes = Array.from({ length: 300 }, (_, index) => ({
      id: index.toString(16).padStart(32, "0"),
      title: `Budget node ${String(index).padStart(3, "0")}`,
      tags: [`tag-${index % 8}`],
      kind: "article",
    }));
    const edges = Array.from({ length: 2_400 }, (_, index) => ({
      source: nodes[index % 300].id,
      target: nodes[(index * 17 + 1) % 300].id,
      kind: index % 3 === 0 ? "related" : "wiki",
    }));
    await page.route("**/api/graph?**", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            nodes,
            edges,
            totalNodes: 300,
            totalEdges: 2_400,
            truncated: false,
          },
        }),
      }),
    );
    await page.goto("/graph/");
    await expect(page.locator("#graph-stage")).toHaveAttribute(
      "data-load-state",
      "ready",
    );
    await expect(page.locator("#graph-stage")).toHaveAttribute(
      "data-layout-ready",
      "true",
    );
    await expect(page.locator("#graph-stage")).toHaveAttribute(
      "data-worker-ready",
      "true",
    );
    await expect(page.locator("#graph-node-list").getByRole("link")).toHaveCount(300);
    const targets = await page.locator('#graph-node-list a').evaluateAll(links =>
      links.map(link => link.getBoundingClientRect().height),
    );
    expect(Math.min(...targets)).toBeGreaterThanOrEqual(32);
    await page.getByRole("button", { name: "放大图谱" }).click();
    const search = page.getByRole("searchbox", { name: "搜索知识节点" });
    await search.fill("Budget node 299");
    const result = page.getByRole("link", { name: "Budget node 299" });
    await expect(result).toBeVisible();
    await result.focus();
    const workerState = await page.locator("#graph-stage").getAttribute("data-worker-state");
    if (workerState === "running") {
      await page.evaluate(() => {
        const spacer = document.createElement("div");
        spacer.style.height = "1200px";
        document.body.append(spacer);
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      await expect(page.locator("#graph-stage")).toHaveAttribute(
        "data-worker-state",
        /paused|converged/,
      );
    } else expect(workerState).toMatch(/paused|converged/);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBeLessThanOrEqual(1);
  });
});
