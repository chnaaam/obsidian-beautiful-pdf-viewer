import type { CharBox, PageData } from "./viewer-controller";
import type { AnnotColor, Annotation } from "./annotation-store";

interface Point {
  x: number;
  y: number;
}

interface LineRect {
  x0: number;
  x1: number;
  top: number;
  bottom: number;
}

export interface SearchHit {
  startIdx: number;
  endIdx: number;
  active: boolean;
}

export interface PageSelectionCallbacks {
  onCreateAnnotation: (pageNumber: number, startIdx: number, endIdx: number, color: AnnotColor, text: string) => void;
  onUpdateAnnotation: (id: string, color: AnnotColor) => void;
  onDeleteAnnotation: (id: string) => void;
}

const COLORS: AnnotColor[] = ["yellow", "blue", "red", "green"];

export class PageSelection {
  private pageEl: HTMLElement;
  private overlay!: HTMLDivElement;
  private annotLayer!: HTMLDivElement;
  private selectionLayer!: HTMLDivElement;
  private searchLayer!: HTMLDivElement;
  private toolbar?: HTMLDivElement;
  private dragging = false;
  private startPoint?: Point;
  private endPoint?: Point;
  private resizeObserver?: ResizeObserver;
  private lastWidth = 0;
  private annotations: Annotation[] = [];
  private searchHits: SearchHit[] = [];

  constructor(
    pageEl: HTMLElement,
    private readonly data: PageData,
    private readonly callbacks: PageSelectionCallbacks,
  ) {
    this.pageEl = pageEl;
  }

  attach() {
    this.overlay = document.createElement("div");
    this.overlay.className = "bpv-selection-overlay";
    this.overlay.addEventListener("pointerdown", this.onPointerDown);
    this.overlay.addEventListener("pointermove", this.onPointerMove);
    this.overlay.addEventListener("pointerup", this.onPointerUp);
    this.overlay.addEventListener("pointercancel", this.onPointerUp);
    this.overlay.addEventListener("dblclick", this.onDoubleClick);

    this.annotLayer = document.createElement("div");
    this.annotLayer.className = "bpv-layer bpv-annot-layer";

    this.searchLayer = document.createElement("div");
    this.searchLayer.className = "bpv-layer bpv-search-layer";

    this.selectionLayer = document.createElement("div");
    this.selectionLayer.className = "bpv-layer bpv-selection-layer";

    this.mountInto(this.pageEl);

    this.resizeObserver = new ResizeObserver(() => this.onPageResize());
    this.resizeObserver.observe(this.pageEl);
    this.lastWidth = this.pageEl.clientWidth;

    this.renderAnnotations();
    this.renderSearch();
  }

  ensureAttached(el: HTMLElement) {
    if (this.pageEl !== el) {
      this.resizeObserver?.disconnect();
      this.pageEl = el;
      this.resizeObserver = new ResizeObserver(() => this.onPageResize());
      this.resizeObserver.observe(this.pageEl);
      this.lastWidth = this.pageEl.clientWidth;
    }
    const annotationHostEl = this.pageEl.querySelector<HTMLElement>(".annotationLayer");
    const host = annotationHostEl ?? this.pageEl;
    const layersDetached =
      this.annotLayer.parentElement !== host ||
      this.searchLayer.parentElement !== host ||
      this.selectionLayer.parentElement !== host ||
      this.overlay.parentElement !== this.pageEl;
    if (layersDetached) {
      this.mountInto(this.pageEl);
      this.renderAnnotations();
      this.renderSearch();
      this.renderSelection();
    }
  }

  detach() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.overlay.remove();
    this.annotLayer.remove();
    this.searchLayer.remove();
    this.selectionLayer.remove();
    this.toolbar?.remove();
    this.toolbar = undefined;
  }

  setAnnotations(anns: Annotation[]) {
    this.annotations = anns;
    this.renderAnnotations();
  }

  setSearchHits(hits: SearchHit[]) {
    this.searchHits = hits;
    this.renderSearch();
  }

  selectAll() {
    if (this.data.chars.length === 0) return;
    this.startPoint = centerOf(this.data.chars[0]);
    this.endPoint = centerOf(this.data.chars[this.data.chars.length - 1]);
    this.renderSelection();
    this.showColorPickerForSelection();
  }

  clearSelection() {
    this.startPoint = undefined;
    this.endPoint = undefined;
    this.renderSelection();
    this.hideToolbar();
  }

  scrollToCharRange(startIdx: number, endIdx: number) {
    const c = this.data.chars[startIdx];
    const end = this.data.chars[endIdx];
    if (!c || !end) return;
    const s = this.scale() || 1;
    const top = c.top * s;
    const pageRect = this.pageEl.getBoundingClientRect();
    const viewportY = pageRect.top + top;
    const offset = viewportY - window.innerHeight / 3;
    if (Math.abs(offset) > 20) {
      this.pageEl.scrollIntoView({ block: "nearest" });
    }
    window.scrollBy({ top: offset, behavior: "smooth" });
  }

  private mountInto(pageEl: HTMLElement) {
    const annotationLayer = pageEl.querySelector<HTMLElement>(".annotationLayer");
    const host = annotationLayer ?? pageEl;
    host.appendChild(this.annotLayer);
    host.appendChild(this.searchLayer);
    host.appendChild(this.selectionLayer);
    pageEl.appendChild(this.overlay);
  }

  private onPageResize() {
    const width = this.pageEl.clientWidth;
    if (width === 0 || width === this.lastWidth) return;
    this.lastWidth = width;
    this.renderAnnotations();
    this.renderSearch();
    this.renderSelection();
    this.repositionToolbar();
  }

  private scale(): number {
    return this.pageEl.clientWidth / this.data.pdfWidth;
  }

  private toPdfCoords(e: PointerEvent | MouseEvent): Point {
    const rect = this.pageEl.getBoundingClientRect();
    const s = this.scale() || 1;
    return { x: (e.clientX - rect.left) / s, y: (e.clientY - rect.top) / s };
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const p = this.toPdfCoords(e);
    const hitAnnot = this.hitTestAnnotation(p);
    if (hitAnnot) {
      this.showAnnotationToolbar(hitAnnot);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    this.hideToolbar();
    this.dragging = true;
    try {
      this.overlay.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    this.startPoint = p;
    this.endPoint = p;
    this.renderSelection();
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.endPoint = this.toPdfCoords(e);
    this.renderSelection();
  };

  private onPointerUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    try {
      this.overlay.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    this.endPoint = this.toPdfCoords(e);
    this.renderSelection();
    const chars = this.selectedChars();
    if (chars.length === 0) {
      this.hideToolbar();
      return;
    }
    this.showColorPickerForSelection();
  };

  private onDoubleClick = (e: MouseEvent) => {
    const point = this.toPdfCoords(e);
    const idx = findCharIndex(this.data.chars, point);
    if (idx < 0) return;
    const [lo, hi] = wordRange(this.data.chars, idx);
    if (lo < 0) return;
    this.startPoint = centerOf(this.data.chars[lo]);
    this.endPoint = centerOf(this.data.chars[hi]);
    this.renderSelection();
    this.showColorPickerForSelection();
  };

  private hitTestAnnotation(p: Point): Annotation | null {
    for (const a of this.annotations) {
      for (let i = a.startIdx; i <= a.endIdx; i += 1) {
        const c = this.data.chars[i];
        if (!c) continue;
        if (p.x >= c.x0 && p.x <= c.x1 && p.y >= c.top && p.y <= c.bottom) return a;
      }
    }
    return null;
  }

  private renderAnnotations() {
    this.annotLayer.innerHTML = "";
    const s = this.scale();
    for (const a of this.annotations) {
      const chars = this.data.chars.slice(a.startIdx, a.endIdx + 1);
      if (chars.length === 0) continue;
      for (const line of groupIntoLines(chars)) {
        const div = document.createElement("div");
        div.className = `bpv-annot bpv-annot-${a.color}`;
        div.dataset.annotId = a.id;
        applyRect(div, line, s);
        this.annotLayer.appendChild(div);
      }
    }
  }

  private renderSearch() {
    this.searchLayer.innerHTML = "";
    const s = this.scale();
    for (const hit of this.searchHits) {
      const chars = this.data.chars.slice(hit.startIdx, hit.endIdx + 1);
      if (chars.length === 0) continue;
      for (const line of groupIntoLines(chars)) {
        const div = document.createElement("div");
        div.className = hit.active ? "bpv-search bpv-search-active" : "bpv-search";
        applyRect(div, line, s);
        this.searchLayer.appendChild(div);
      }
    }
  }

  private renderSelection() {
    this.selectionLayer.innerHTML = "";
    if (!this.startPoint || !this.endPoint) return;
    const chars = this.selectedChars();
    if (chars.length === 0) return;
    const s = this.scale();
    for (const line of groupIntoLines(chars)) {
      const div = document.createElement("div");
      div.className = "bpv-selection";
      applyRect(div, line, s);
      this.selectionLayer.appendChild(div);
    }
  }

  private selectedChars(): CharBox[] {
    if (!this.startPoint || !this.endPoint) return [];
    const chars = this.data.chars;
    if (chars.length === 0) return [];
    const aIdx = findCharIndex(chars, this.startPoint);
    const bIdx = findCharIndex(chars, this.endPoint);
    if (aIdx < 0 || bIdx < 0) return [];
    const [lo, hi] = aIdx <= bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
    return chars.slice(lo, hi + 1);
  }

  private selectedIndices(): [number, number] | null {
    if (!this.startPoint || !this.endPoint) return null;
    const chars = this.data.chars;
    if (chars.length === 0) return null;
    const aIdx = findCharIndex(chars, this.startPoint);
    const bIdx = findCharIndex(chars, this.endPoint);
    if (aIdx < 0 || bIdx < 0) return null;
    return aIdx <= bIdx ? [aIdx, bIdx] : [bIdx, aIdx];
  }

  private showColorPickerForSelection() {
    const range = this.selectedIndices();
    if (!range) return;
    const [lo, hi] = range;
    const text = this.data.chars.slice(lo, hi + 1).map((c) => c.text).join("");
    if (navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => {});
    this.renderToolbar({
      anchor: this.data.chars.slice(lo, hi + 1),
      buttons: COLORS.map((color) => ({
        color,
        onClick: () => {
          this.callbacks.onCreateAnnotation(this.data.pageNumber, lo, hi, color, text);
          this.clearSelection();
        },
      })),
    });
  }

  private showAnnotationToolbar(a: Annotation) {
    const chars = this.data.chars.slice(a.startIdx, a.endIdx + 1);
    this.renderToolbar({
      anchor: chars,
      buttons: COLORS.map((color) => ({
        color,
        active: color === a.color,
        onClick: () => {
          this.callbacks.onUpdateAnnotation(a.id, color);
          this.hideToolbar();
        },
      })),
      onDelete: () => {
        this.callbacks.onDeleteAnnotation(a.id);
        this.hideToolbar();
      },
    });
  }

  private renderToolbar(opts: {
    anchor: CharBox[];
    buttons: Array<{ color: AnnotColor; active?: boolean; onClick: () => void }>;
    onDelete?: () => void;
  }) {
    this.hideToolbar();
    const toolbar = document.createElement("div");
    toolbar.className = "bpv-toolbar";
    toolbar.addEventListener("pointerdown", (e) => e.stopPropagation());

    for (const b of opts.buttons) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `bpv-toolbar-color bpv-toolbar-color-${b.color}${b.active ? " is-active" : ""}`;
      btn.setAttribute("aria-label", b.color);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        b.onClick();
      });
      toolbar.appendChild(btn);
    }

    if (opts.onDelete) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "bpv-toolbar-delete";
      del.setAttribute("aria-label", "delete");
      del.textContent = "✕";
      del.addEventListener("click", (e) => {
        e.preventDefault();
        opts.onDelete!();
      });
      toolbar.appendChild(del);
    }

    this.pageEl.appendChild(toolbar);
    this.toolbar = toolbar;
    this.positionToolbar(opts.anchor);
  }

  private repositionToolbar() {
    if (!this.toolbar) return;
    // We don't track anchor; remove for simplicity on resize.
    // Re-show is done on next interaction.
  }

  private positionToolbar(anchor: CharBox[]) {
    if (!this.toolbar || anchor.length === 0) return;
    const s = this.scale();
    let minX = Infinity;
    let minTop = Infinity;
    for (const c of anchor) {
      if (c.x0 < minX) minX = c.x0;
      if (c.top < minTop) minTop = c.top;
    }
    const left = Math.max(4, minX * s);
    const top = Math.max(4, minTop * s - 34);
    this.toolbar.style.left = `${left}px`;
    this.toolbar.style.top = `${top}px`;
  }

  private hideToolbar() {
    this.toolbar?.remove();
    this.toolbar = undefined;
  }
}

function centerOf(c: CharBox): Point {
  return { x: (c.x0 + c.x1) / 2, y: (c.top + c.bottom) / 2 };
}

function findCharIndex(chars: CharBox[], p: Point): number {
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (p.x >= c.x0 && p.x <= c.x1 && p.y >= c.top && p.y <= c.bottom) return i;
  }
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    const cx = (c.x0 + c.x1) / 2;
    const cy = (c.top + c.bottom) / 2;
    const d = (cx - p.x) ** 2 + (cy - p.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function wordRange(chars: CharBox[], index: number): [number, number] {
  const isWord = (ch: string) => /\S/.test(ch);
  if (!isWord(chars[index]?.text ?? "")) return [-1, -1];
  let lo = index;
  let hi = index;
  while (lo > 0 && isWord(chars[lo - 1].text) && sameLine(chars[lo - 1], chars[lo])) lo -= 1;
  while (hi < chars.length - 1 && isWord(chars[hi + 1].text) && sameLine(chars[hi], chars[hi + 1])) hi += 1;
  return [lo, hi];
}

function sameLine(a: CharBox, b: CharBox): boolean {
  const h = Math.min(a.bottom - a.top, b.bottom - b.top) || 1;
  return Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) < h * 0.6;
}

function groupIntoLines(chars: CharBox[]): LineRect[] {
  const lines: Array<LineRect & { cy: number; count: number }> = [];
  for (const c of chars) {
    const cy = (c.top + c.bottom) / 2;
    const h = c.bottom - c.top || 1;
    const match = lines.find((l) => Math.abs(l.cy - cy) < h * 0.6);
    if (match) {
      match.x0 = Math.min(match.x0, c.x0);
      match.x1 = Math.max(match.x1, c.x1);
      match.top = Math.min(match.top, c.top);
      match.bottom = Math.max(match.bottom, c.bottom);
      match.cy = (match.cy * match.count + cy) / (match.count + 1);
      match.count += 1;
    } else {
      lines.push({ x0: c.x0, x1: c.x1, top: c.top, bottom: c.bottom, cy, count: 1 });
    }
  }
  return lines.map(({ x0, x1, top, bottom }) => ({ x0, x1, top, bottom }));
}

function applyRect(div: HTMLElement, line: LineRect, s: number) {
  div.style.left = `${line.x0 * s}px`;
  div.style.top = `${line.top * s}px`;
  div.style.width = `${Math.max(1, (line.x1 - line.x0) * s)}px`;
  div.style.height = `${Math.max(1, (line.bottom - line.top) * s)}px`;
}
