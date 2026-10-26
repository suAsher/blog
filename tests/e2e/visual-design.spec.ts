import { test, expect, establishSession } from "./fixtures";

test.describe("visual system regressions", () => {
  test("the public login uses the same semantic theme tokens as the application", async ({
    page, context, baseURL,
  }) => {
    for (const theme of ["dark", "light"]) {
      await context.clearCookies();
      await page.goto("/login/");
      await expect(page.locator("#login-title")).toBeVisible();
      await page.evaluate((value) => {
        localStorage.setItem("asher-theme", value);
        document.documentElement.dataset.theme = value;
      }, theme);
      const login = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return ["--bg", "--text", "--accent", "--violet", "--radius-lg"].map(
          (token) => style.getPropertyValue(token).trim(),
        );
      });
      await establishSession(context, baseURL);
      await page.goto("/about/");
      const application = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        return ["--bg", "--text", "--accent", "--violet", "--radius-lg"].map(
          (token) => style.getPropertyValue(token).trim(),
        );
      });
      expect(login).toEqual(application);
      expect(login.every(Boolean)).toBe(true);
    }
  });

  test("the image viewer occupies the complete viewport without inherited dialog offset", async ({
    page,
  }) => {
    await page.goto("/articles/build-a-learning-system/");
    await page
      .getByRole("button", { name: /^放大图片：/ })
      .first()
      .click();
    const viewer = page.getByRole("dialog", { name: "文章图片预览" });
    await expect(viewer).toBeVisible();
    const bounds = await viewer.boundingBox();
    expect(bounds).not.toBeNull();
    expect(Math.abs(bounds!.y)).toBeLessThan(1);
    expect(Math.abs(bounds!.height - page.viewportSize()!.height)).toBeLessThan(
      2,
    );
  });

  test("intermediate tablet widths keep one accessible table of contents", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 860, height: 1024 });
    await page.goto("/articles/build-a-learning-system/");
    await expect(page.locator(".toc-sidebar")).not.toBeVisible();
    await expect(page.locator(".mobile-toc")).toBeVisible();
  });

  test("the primary exploration action is visible before the mobile hero illustration", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const action = page.locator(".hero-actions .button-primary");
    const bounds = await action.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y + bounds!.height).toBeLessThan(500);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
  });
});
