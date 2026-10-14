import { ICONS, type IconName } from "./icons";

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | undefined | null | EventListener | Partial<CSSStyleDeclaration>>;

/** Minimal hyperscript: `h("div.card.active", { onclick }, child...)`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K | `${K}.${string}` | `${K}#${string}`, attrs?: Attrs | Child, ...children: Child[]): HTMLElementTagNameMap[K] {
  const [name, ...rest] = tag.split(/(?=[.#])/);
  const el = document.createElement(name as K);
  for (const part of rest) {
    if (part.startsWith(".")) el.classList.add(part.slice(1));
    else el.id = part.slice(1);
  }
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node)) {
    children.unshift(attrs as Child);
  } else if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value as EventListener);
      else if (key === "style" && typeof value === "object") Object.assign(el.style, value);
      else if (key === "class") el.className = String(value);
      else if (value === true) el.setAttribute(key, "");
      else el.setAttribute(key, String(value));
    }
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function icon(name: IconName, size = 18, cls = ""): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  if (cls) svg.setAttribute("class", cls);
  svg.innerHTML = ICONS[name];
  return svg;
}

/** Icon button with an accessible label and a hover tooltip. */
export function iconButton(name: IconName, label: string, onclick: (e: MouseEvent) => void, extra = ""): HTMLButtonElement {
  const b = h("button.icon-btn", { type: "button", "aria-label": label, "data-tip": label, onclick: onclick as EventListener }, icon(name));
  if (extra) b.classList.add(...extra.split(" "));
  return b;
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export const fmt = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
