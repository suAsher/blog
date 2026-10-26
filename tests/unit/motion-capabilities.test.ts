import { describe, expect, it } from "vitest";
import {
  motionPolicy,
  motionSurface,
  shouldAnimate,
} from "../../src/lib/motion-capabilities";

const capable = {
  pathname: "/",
  reduced: false,
  finePointer: true,
  saveData: false,
  cores: 8,
  memory: 8,
};
describe("progressive motion capabilities", () => {
  it("limits motion libraries to discovery surfaces, including routes without trailing slashes", () => {
    for (const route of ["/", "/articles/", "/articles", "/library/", "/lab/"])
      expect(motionSurface(route)).not.toBe("native");
    for (const route of [
      "/articles/a-note/",
      "/reader/",
      "/manage/",
      "/login/",
      "/about/",
    ])
      expect(motionSurface(route)).toBe("native");
  });
  it("enables a scene only on the home route and smooth scrolling only for a fine pointer", () => {
    expect(motionPolicy(capable)).toMatchObject({
      scene: true,
      smooth: true,
      effects: true,
    });
    expect(motionPolicy({ ...capable, pathname: "/lab/" })).toMatchObject({
      scene: false,
      smooth: true,
      effects: true,
    });
    expect(motionPolicy({ ...capable, finePointer: false })).toMatchObject({
      scene: true,
      smooth: false,
      effects: false,
    });
  });
  it("keeps reduced-motion and constrained devices on the static native experience", () => {
    for (const patch of [
      { reduced: true },
      { saveData: true },
      { cores: 2 },
      { memory: 2 },
    ]) {
      expect(motionPolicy({ ...capable, ...patch })).toMatchObject({
        scene: false,
        smooth: false,
        effects: false,
      });
    }
    expect(
      motionPolicy({ ...capable, cores: undefined, memory: undefined }).scene,
    ).toBe(true);
  });
  it("never enables decoration or scroll interception for focused reading, login or writing", () => {
    for (const pathname of [
      "/articles/example/",
      "/reader/",
      "/manage/",
      "/login/",
    ]) {
      expect(motionPolicy({ ...capable, pathname })).toMatchObject({
        scene: false,
        smooth: false,
        effects: false,
      });
    }
  });
  it("runs only while visible, onscreen, allowed by preference and not paused by the user", () => {
    const state = {
      allowed: true,
      hidden: false,
      onscreen: true,
      paused: false,
    };
    expect(shouldAnimate(state)).toBe(true);
    for (const patch of [
      { allowed: false },
      { hidden: true },
      { onscreen: false },
      { paused: true },
    ])
      expect(shouldAnimate({ ...state, ...patch })).toBe(false);
  });
});
