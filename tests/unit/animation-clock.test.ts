import { describe, expect, it, vi } from "vitest";
import {
  createAnimationClock,
  createTickerClock,
  type AnimationFrameScheduler,
} from "../../src/lib/animation-clock";

function fakeScheduler() {
  let nextHandle = 0;
  const pending = new Map<number, (time: number) => void>();
  const scheduler: AnimationFrameScheduler<number> = {
    request(callback) {
      const handle = ++nextHandle;
      pending.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      pending.delete(handle);
    },
  };
  return {
    scheduler,
    pending,
    run(handle: number, milliseconds: number) {
      const callback = pending.get(handle);
      pending.delete(handle);
      callback?.(milliseconds);
    },
  };
}

describe("animation clock", () => {
  it("owns only one native animation-frame loop and reports seconds", () => {
    const frames = fakeScheduler();
    const onFrame = vi.fn();
    const clock = createAnimationClock(onFrame, frames.scheduler);

    clock.start();
    clock.start();
    expect(frames.pending.size).toBe(1);

    const firstHandle = [...frames.pending.keys()][0]!;
    frames.run(firstHandle, 1250);
    expect(onFrame).toHaveBeenCalledWith(1.25);
    expect(frames.pending.size).toBe(1);
  });

  it("cancels on stop and a stale callback cannot reschedule the loop", () => {
    const frames = fakeScheduler();
    const onFrame = vi.fn();
    const clock = createAnimationClock(onFrame, frames.scheduler);

    clock.start();
    const staleCallback = frames.pending.values().next().value!;
    clock.stop();
    expect(frames.pending.size).toBe(0);

    staleCallback(2000);
    expect(onFrame).not.toHaveBeenCalled();
    expect(frames.pending.size).toBe(0);

    clock.start();
    expect(frames.pending.size).toBe(1);
    frames.run([...frames.pending.keys()][0]!, 2500);
    expect(onFrame).toHaveBeenCalledWith(2.5);
    expect(frames.pending.size).toBe(1);
  });

  it("starts and stops a ticker idempotently without creating a second owner", () => {
    const listeners = new Set<(time: number) => void>();
    const ticker = {
      add: vi.fn((listener: (time: number) => void) => listeners.add(listener)),
      remove: vi.fn((listener: (time: number) => void) =>
        listeners.delete(listener),
      ),
      wake: vi.fn(),
      sleep: vi.fn(),
    };
    const onFrame = vi.fn();
    const clock = createTickerClock(onFrame, ticker);

    clock.start();
    clock.start();
    expect(ticker.add).toHaveBeenCalledTimes(1);
    expect(ticker.wake).toHaveBeenCalledTimes(1);
    listeners.forEach((listener) => listener(3.5));
    expect(onFrame).toHaveBeenCalledWith(3.5);

    clock.stop();
    clock.stop();
    expect(ticker.remove).toHaveBeenCalledTimes(1);
    expect(ticker.sleep).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });
});
