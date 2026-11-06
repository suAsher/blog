import { afterEach, describe, expect, it, vi } from "vitest";
import { optionalEnhancement } from "../../src/lib/optional-enhancement";

describe("optional enhancement deadline", () => {
  afterEach(() => vi.useRealTimers());
  it("applies a ready enhancement once", async () => {
    const apply = vi.fn();
    await optionalEnhancement(Promise.resolve("ready"), apply);
    expect(apply).toHaveBeenCalledExactlyOnceWith("ready");
  });
  it("settles a stalled enhancement and never mutates anchored text later", async () => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    const loaded = new Promise<string>((done) => { resolve = done; });
    const apply = vi.fn();
    const pending = optionalEnhancement(loaded, apply);
    await vi.advanceTimersByTimeAsync(1500);
    await pending;
    resolve("late");
    await Promise.resolve();
    expect(apply).not.toHaveBeenCalled();
  });
  it("keeps ordinary content available after a load or enhancement failure", async () => {
    const apply = vi.fn();
    await optionalEnhancement(Promise.reject(new Error("offline")), apply);
    expect(apply).not.toHaveBeenCalled();
    await expect(optionalEnhancement(Promise.resolve(1), () => {
      throw new Error("unsupported");
    })).resolves.toBeUndefined();
  });
});
