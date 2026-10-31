import type { ExplorerSpec } from "../../lib/explorers";
import { inference } from "./inference";
import { stages } from "./stages";
import "../../styles/explorers.css";

export function mountExplorer(
  figure: HTMLElement,
  target: HTMLElement,
  spec: ExplorerSpec,
) {
  if (figure.dataset.exploreMounted === "true" || !figure.isConnected) return;
  figure.dataset.exploreMounted = "true";
  target.replaceChildren();
  if (spec.kind === "inference") inference(figure, target);
  else stages(figure, target, spec.kind);
}
