export function reloadGuardPassed(results: readonly unknown[]): boolean {
  return results.every(result => result !== false);
}

export function controllerChangeAction(updateRequested: boolean): "reload" | "offer" {
  return updateRequested ? "reload" : "offer";
}
