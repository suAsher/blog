import { test, expect } from "./fixtures";

async function capableDevice(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      configurable: true,
      get: () => 8,
    });
    Object.defineProperty(navigator, "deviceMemory", {
      configurable: true,
      get: () => 8,
    });
  });
}

test("home preserves its accessible heading and pause switches the whole enhancement back to native scrolling", async ({
  page,
  isMobile,
}) => {
  await capableDevice(page);
  await page.goto("/?examples=1");
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toBeVisible();
  await expect(title).toHaveAccessibleName(/让知识生长，\s*让思考发光。/);
  await expect(page.locator("html")).toHaveAttribute(
    "data-visual-runtime",
    "active",
  );
  if (!isMobile)
    await expect(page.locator("html")).toHaveAttribute(
      "data-smooth-scroll",
      "active",
    );
  const toggle = page.getByRole("button", { name: "暂停动效", exact: true });
  await toggle.scrollIntoViewIfNeeded();
  await toggle.click();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "paused");
  await expect(page.locator("html")).toHaveAttribute(
    "data-visual-runtime",
    "paused",
  );
  await expect(page.locator("html")).not.toHaveAttribute("data-smooth-scroll");
  await expect(page.locator("[data-motion-toggle]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "继续动效", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-visual-runtime",
    "active",
  );
  await expect(title).toHaveAccessibleName(/让知识生长，\s*让思考发光。/);
});

test("live reduced-motion changes retain visible content and the CSS constellation", async ({
  page,
}) => {
  await capableDevice(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const engines: string[] = [];
  page.on("request", (request) => {
    if (/\/(runtime|nebula)[^/]*\.js(?:\?|$)/.test(request.url()))
      engines.push(request.url());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-motion", "paused");
  await expect(page.locator("[data-motion-toggle]")).toBeHidden();
  await expect(page.locator("[data-hero-scene] canvas")).toHaveCount(0);
  expect(engines).toEqual([]);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-visual-runtime",
    "active",
  );
  // Commit the preceding media change before requesting its inverse in Chromium.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("[data-hero-scene] canvas")).toHaveCount(0);
  await expect(page.locator(".planet")).toBeVisible();
});

test("a missing WebGL context uses the static artwork without a broken heading or runtime error", async ({
  page,
  isMobile,
}) => {
  await capableDevice(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      kind: string,
      ...args: unknown[]
    ) {
      if (kind.startsWith("webgl") || kind === "experimental-webgl")
        return null;
      return Reflect.apply(original, this, [kind, ...args]);
    } as typeof original;
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute(
    "data-visual-runtime",
    isMobile ? "paused" : "active",
  );
  await expect(page.locator("[data-hero-scene]")).toHaveAttribute(
    "data-scene-state",
    "fallback",
  );
  await expect(page.locator("[data-hero-scene] canvas")).toHaveCount(0);
  await expect(page.locator(".planet")).toBeVisible();
  await expect(page.getByRole("link", { name: "开始探索" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("hidden documents and a BFCache restore pause and remount exactly one scene", async ({
  page,
}) => {
  await capableDevice(page);
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute(
    "data-visual-runtime",
    "active",
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-visual-runtime",
    "paused",
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-visual-runtime",
    "active",
  );
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pagehide", { persisted: true }),
    ),
  );
  await expect(page.locator("[data-hero-scene] canvas")).toHaveCount(0);
  await page.evaluate(() =>
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    ),
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-visual-runtime",
    "active",
  );
  expect(
    await page.locator("[data-hero-scene] canvas").count(),
  ).toBeLessThanOrEqual(1);
  expect(await page.locator(".knowledge-cursor").count()).toBeLessThanOrEqual(
    1,
  );
});

test("dynamically rendered discovery cards gain real pointer effects and readers load no motion engines", async ({
  page,
  isMobile,
}) => {
  await capableDevice(page);
  await page.goto("/articles/?examples=1");
  const card = page.locator(".article-card").first();
  await expect(card).toBeVisible();
  if (!isMobile) {
    await expect(card).toHaveClass(/spotlight-card/);
    await card.hover();
    await expect(card).toHaveClass(/spotlight-active/);
    await expect(card).toHaveAttribute("style", /--spot-x:/);
  }
  const engines: string[] = [];
  page.on("request", (request) => {
    if (/\/(runtime|nebula)[^/]*\.js(?:\?|$)/.test(request.url()))
      engines.push(request.url());
  });
  await page.goto("/articles/build-a-learning-system/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator("[data-hero-scene] canvas")).toHaveCount(0);
  await expect(page.locator("html")).not.toHaveAttribute("data-smooth-scroll");
  expect(engines).toEqual([]);
});

test("an initially hidden document starts no effects and repeated pause/resume stops scheduled animation frames", async ({
  page,
}) => {
  await capableDevice(page);
  await page.addInitScript(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    const animationWindow = window as Window & { __motionFrames?: number };
    animationWindow.__motionFrames = 0;
    const original = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) =>
      original((time) => {
        animationWindow.__motionFrames!++;
        callback(time);
      });
  });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute(
    "data-visual-runtime",
    "paused",
  );
  await expect(page.locator(".hero-letter")).toHaveCount(0);
  await expect(page.locator(".knowledge-cursor")).toHaveCount(0);
  const frameCount = () =>
    page.evaluate(
      () =>
        (window as Window & { __motionFrames?: number }).__motionFrames ?? 0,
    );
  const expectSleeping = async () => {
    await expect
      .poll(async () => {
        const before = await frameCount();
        await page.waitForTimeout(120);
        return (await frameCount()) - before;
      })
      .toBe(0);
  };
  await expectSleeping();
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.locator("html")).toHaveAttribute(
    "data-visual-runtime",
    "active",
  );
  for (let cycle = 0; cycle < 2; cycle++) {
    const before = await frameCount();
    await expect.poll(frameCount).toBeGreaterThan(before);
    await page.locator("[data-motion-toggle]").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-visual-runtime",
      "paused",
    );
    await expectSleeping();
    await page.locator("[data-motion-toggle]").click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-visual-runtime",
      "active",
    );
  }
});

test("the offscreen hero stops GPU draws and WebGL context loss cleanly returns to the CSS artwork", async ({
  page,
  isMobile,
}) => {
  await capableDevice(page);
  await page.addInitScript(() => {
    const animationWindow = window as Window & { __sceneDraws?: number };
    animationWindow.__sceneDraws = 0;
    for (const context of [WebGLRenderingContext, WebGL2RenderingContext]) {
      const original = context.prototype.drawArrays;
      context.prototype.drawArrays = function (
        mode: number,
        first: number,
        count: number,
      ) {
        animationWindow.__sceneDraws!++;
        return original.call(this, mode, first, count);
      };
    }
  });
  await page.goto("/?examples=1");
  const scene = page.locator("[data-hero-scene]");
  await expect(scene).toHaveAttribute("data-scene-state", "active");
  await expect(scene.locator("canvas")).toHaveCount(1);
  const draws = () =>
    page.evaluate(
      () => (window as Window & { __sceneDraws?: number }).__sceneDraws ?? 0,
    );
  await expect.poll(draws).toBeGreaterThan(0);
  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight),
  );
  await expect(scene).toHaveAttribute("data-scene-state", "paused");
  const before = await draws();
  await page.waitForTimeout(120);
  expect(await draws()).toBe(before);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(scene).toHaveAttribute("data-scene-state", "active");
  await scene.locator("canvas").evaluate((canvas) => {
    const gl =
      (canvas as HTMLCanvasElement).getContext("webgl2") ||
      (canvas as HTMLCanvasElement).getContext("webgl");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
  });
  await expect(scene).toHaveAttribute("data-scene-state", "fallback");
  await expect(scene.locator("canvas")).toHaveCount(0);
  await expect(page.locator(".planet")).toBeVisible();
  if (isMobile)
    await expect(page.locator("html")).toHaveAttribute(
      "data-visual-runtime",
      "paused",
    );
});

test("aborting while the optional effects chunk loads immediately releases the scene", async ({
  page,
}) => {
  await capableDevice(page);
  await page.addInitScript(() => {
    const original = window.matchMedia.bind(window);
    window.matchMedia = (query) =>
      new Proxy(original(query), {
        get(target, key) {
          if (key === "matches" && query.includes("pointer: fine")) return true;
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
  });
  let requested!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/effects.*.js", async (route) => {
    requested();
    await released;
    await route.continue();
  });
  try {
    await page.goto("/?examples=1", { waitUntil: "domcontentloaded" });
    await started;
    await expect(page.locator("[data-hero-scene] canvas")).toHaveCount(1);
    await page.evaluate(() =>
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true }),
      ),
    );
    await expect(page.locator("[data-hero-scene] canvas")).toHaveCount(0, {
      timeout: 700,
    });
  } finally {
    release();
  }
});
