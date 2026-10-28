export const get = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
export function button(text: string, action: () => void, label = text) {
  const node = element("button", "", text);
  node.type = "button";
  node.setAttribute("aria-label", label);
  node.addEventListener("click", action);
  return node;
}
