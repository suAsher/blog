export interface AnimationClock {
  start(): void;
  stop(): void;
}

export interface AnimationFrameScheduler<Handle = number> {
  request(callback: (milliseconds: number) => void): Handle;
  cancel(handle: Handle): void;
}

export interface AnimationTicker {
  add(callback: (seconds: number) => void): unknown;
  remove(callback: (seconds: number) => void): unknown;
  wake(): unknown;
  sleep(): unknown;
}

function browserAnimationFrames(): AnimationFrameScheduler<number> {
  return {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (handle) => cancelAnimationFrame(handle),
  };
}

/** Owns one RAF chain and exposes the same seconds unit used by GSAP's ticker. */
export function createAnimationClock<Handle = number>(
  onFrame: (seconds: number) => void,
  scheduler: AnimationFrameScheduler<Handle> =
    browserAnimationFrames() as AnimationFrameScheduler<Handle>,
): AnimationClock {
  let running = false;
  let handle: Handle | undefined;
  let generation = 0;

  const schedule = (version: number) => {
    handle = scheduler.request((milliseconds) => {
      if (!running || version !== generation) return;
      handle = undefined;
      onFrame(milliseconds / 1000);
      if (running && version === generation) schedule(version);
    });
  };

  return {
    start() {
      if (running) return;
      running = true;
      const version = ++generation;
      schedule(version);
    },
    stop() {
      if (!running) return;
      running = false;
      generation++;
      if (handle !== undefined) scheduler.cancel(handle);
      handle = undefined;
    },
  };
}

/** Adapts an already-loaded animation engine without importing that engine here. */
export function createTickerClock(
  onFrame: (seconds: number) => void,
  ticker: AnimationTicker,
): AnimationClock {
  let running = false;
  const tick = (seconds: number) => {
    if (running) onFrame(seconds);
  };
  return {
    start() {
      if (running) return;
      running = true;
      ticker.add(tick);
      ticker.wake();
    },
    stop() {
      if (!running) return;
      running = false;
      ticker.remove(tick);
      ticker.sleep();
    },
  };
}
