/** Decisions stay pure so device and preference fallbacks can be verified without a GPU. */
export type MotionCapabilities = {
  pathname: string;
  reduced: boolean;
  finePointer: boolean;
  saveData: boolean;
  cores?: number;
  memory?: number;
  viewportWidth?: number;
};

export function motionSurface(
  pathname: string,
): "home" | "discovery" | "native" {
  if (pathname === "/") return "home";
  return /^\/(articles|library|lab)\/?$/.test(pathname)
    ? "discovery"
    : "native";
}

export function motionPolicy(capabilities: MotionCapabilities) {
  const surface = motionSurface(capabilities.pathname);
  const constrained =
    capabilities.saveData ||
    (capabilities.cores ?? 8) <= 2 ||
    (capabilities.memory ?? 8) <= 2;
  const enabled = surface !== "native" && !capabilities.reduced && !constrained;
  return {
    scene:
      enabled &&
      surface === "home" &&
      (capabilities.viewportWidth ?? 1024) >= 768,
    css: enabled && surface === "home",
    smooth: enabled && capabilities.finePointer,
    effects: enabled && capabilities.finePointer,
  };
}

export function shouldAnimate(state: {
  allowed: boolean;
  hidden: boolean;
  onscreen: boolean;
  paused: boolean;
}): boolean {
  return state.allowed && !state.hidden && state.onscreen && !state.paused;
}
