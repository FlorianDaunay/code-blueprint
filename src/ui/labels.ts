import { Vector3 } from "three";
import type { CityView } from "../scene/city";
import { h } from "./dom";

interface Label {
  el: HTMLElement;
  pos: Vector3;
  /** World-space width of the thing labelled: hidden when it is too small on screen. */
  width: number;
  minPx: number;
  kind: "dir" | "file";
}

/** HTML labels pinned to world positions (directory names, focused files). */
export class Labels {
  private dirLabels: Label[] = [];
  private focusLabels: Label[] = [];
  readonly root = h("div.labels");

  constructor(private city: CityView) {}

  setDirs(entries: { text: string; pos: Vector3; width: number; level: number }[]) {
    for (const l of this.dirLabels) l.el.remove();
    this.dirLabels = entries
      .sort((a, b) => b.width - a.width)
      .slice(0, 400)
      .map((e) => {
        const el = h("div.label.label-dir", { "data-level": e.level }, e.text);
        this.root.append(el);
        return { el, pos: e.pos, width: e.width, minPx: 70 + e.level * 10, kind: "dir" as const };
      });
  }

  setFocus(entries: { text: string; pos: Vector3; primary: boolean }[]) {
    for (const l of this.focusLabels) l.el.remove();
    this.focusLabels = entries.slice(0, 60).map((e) => {
      const el = h(e.primary ? "div.label.label-file.primary" : "div.label.label-file", e.text);
      this.root.append(el);
      return { el, pos: e.pos, width: 0, minPx: 0, kind: "file" as const };
    });
  }

  update() {
    let shownDirs = 0;
    // Greedy de-overlap: biggest platforms first (list is sorted by width), skip labels colliding with placed ones.
    const placed: { x: number; y: number; w: number }[] = [];
    for (const l of this.dirLabels) {
      const px = this.city.pixelScale(l.pos) * l.width;
      const p = px >= l.minPx && shownDirs < 80 ? this.city.project(l.pos) : null;
      const w = Math.max(60, Math.min(260, px * 0.9));
      const textW = Math.min(w, (l.el.textContent?.length ?? 8) * 7.5 + 8);
      if (!p || p.x > this.city.visibleRight - 40 || placed.some((o) => p.y > o.y - 16 && p.y < o.y + 16 && p.x < o.x + o.w && p.x + textW > o.x)) {
        if (l.el.style.display !== "none") l.el.style.display = "none";
        continue;
      }
      placed.push({ x: p.x, y: p.y, w: textW });
      shownDirs++;
      l.el.style.display = "";
      l.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
      l.el.style.maxWidth = `${w}px`;
    }
    for (const l of this.focusLabels) {
      const p = this.city.project(l.pos);
      if (!p || p.x > this.city.visibleRight - 20) {
        l.el.style.display = "none";
        continue;
      }
      l.el.style.display = "";
      l.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px)`;
    }
  }
}
