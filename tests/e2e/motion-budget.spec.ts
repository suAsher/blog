import { test, expect } from "./fixtures";

test("motion engine downloads follow the pointer budget while the scene really renders", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      get: () => 8,
    });
    Object.defineProperty(navigator, "deviceMemory", {
      configurable: true,
      get: () => 8,
    });
    const state = window as Window & { __mobileSceneDraws?: number };
    state.__mobileSceneDraws = 0;
    for (const context of [WebGLRenderingContext, WebGL2RenderingContext]) {
      const drawArrays = context.prototype.drawArrays;
      context.prototype.drawArrays = function (
        mode: number,
        first: number,
        count: number,
      ) {
        state.__mobileSceneDraws!++;
        return drawArrays.call(this, mode, first, count);
      };
    }
  });
  const scripts: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "script") scripts.push(request.url());
  });

  await page.goto("/?examples=1");
  const finePointer = await page.evaluate(() =>
    matchMedia("(hover: hover) and (pointer: fine)").matches,
  );
  const scene = page.locator("[data-hero-scene]");
  await expect(scene).toHaveAttribute("data-scene-state", "active");
  await expect(scene.locator("canvas")).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as Window & { __mobileSceneDraws?: number })
            .__mobileSceneDraws ?? 0,
      ),
    )
    .toBeGreaterThan(0);
  await page.waitForLoadState("networkidle");

  expect(scripts.some((url) => /\/nebula[^/]*\.js(?:\?|$)/.test(url))).toBe(
    true,
  );
  const desktopEngines = scripts.filter((url) =>
    /\/(?:effects|smooth-scroll)[^/]*\.js(?:\?|$)/.test(url),
  );
  if (finePointer) {
    expect(desktopEngines.some((url) => /\/effects/.test(url))).toBe(true);
    expect(desktopEngines.some((url) => /\/smooth-scroll/.test(url))).toBe(
      true,
    );
  } else {
    expect(desktopEngines).toEqual([]);
  }
});
