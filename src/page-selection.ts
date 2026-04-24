import type { CharBox, PageData } from "./viewer-controller";
import type { AnnotColor, Annotation } from "./annotation-store";
import { charsToText, findWordBoundaries } from "./text-utils";

/** Map annotation hex color to a semi-transparent highlight RGBA. */
function annotBg(color: AnnotColor): string {
  switch (color) {
    case "#FFFF00": return "rgba(255, 220, 70, 0.45)";
    case "#0000FF": return "rgba(80, 140, 255, 0.40)";
    case "#FF0000": return "rgba(255, 90, 90, 0.40)";
    case "#00FF00": return "rgba(80, 200, 120, 0.45)";
    default:        return "rgba(255, 220, 70, 0.45)";
  }
}

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
  /** Called when the user finishes dragging / double-clicking and has a non-empty selection. */
  onSelectionReady: (pageNumber: number, lo: number, hi: number, text: string) => void;
  /** Called when the selection is cleared (pointer-down on empty area, or after annotation applied). */
  onSelectionCleared: () => void;
  /** Called when the user clicks on an existing annotation highlight. */
  onAnnotationClicked: (annotation: Annotation) => void;
}

export class PageSelection {
  private pageEl: HTMLElement;
  private overlay!: HTMLDivElement;
  private annotLayer!: HTMLDivElement;
  private selectionLayer!: HTMLDivElement;
  private searchLayer!: HTMLDivElement;
  private dragging = false;
  private startPoint?: Point;
  private endPoint?: Point;
  private resizeObserver?: ResizeObserver;
  private lastWidth = 0;
  private annotations: Annotation[] = [];
  private searchHits: SearchHit[] = [];
  private readonly suppressNativeSelection = (e: Event) => {
    e.preventDefault();
  };

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
    this.bindNativeSelectionSuppression();

    this.resizeObserver = new ResizeObserver(() => this.onPageResize());
    this.resizeObserver.observe(this.pageEl);
    this.lastWidth = this.pageEl.clientWidth;

    this.renderAnnotations();
    this.renderSearch();
  }

  ensureAttached(el: HTMLElement) {
    if (this.pageEl !== el) {
      this.resizeObserver?.disconnect();
      this.unbindNativeSelectionSuppression();
      this.pageEl = el;
      this.resizeObserver = new ResizeObserver(() => this.onPageResize());
      this.resizeObserver.observe(this.pageEl);
      this.lastWidth = this.pageEl.clientWidth;
      this.bindNativeSelectionSuppression();
    }
    const layersDetached =
      this.annotLayer.parentElement !== this.pageEl ||
      this.searchLayer.parentElement !== this.pageEl ||
      this.selectionLayer.parentElement !== this.pageEl ||
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
    this.unbindNativeSelectionSuppression();
    this.overlay.remove();
    this.annotLayer.remove();
    this.searchLayer.remove();
    this.selectionLayer.remove();
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
    this.notifySelectionReady();
  }

  clearSelection() {
    this.startPoint = undefined;
    this.endPoint = undefined;
    this.renderSelection();
    this.callbacks.onSelectionCleared();
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
    // Mount directly into the .page element. PDF.js' .annotationLayer uses its
    // own CSS-scaled coordinate space (transform: scale(...)), so attaching our
    // overlays there would misalign them with the rendered canvas. The .page
    // element's box matches the visible canvas 1:1 in CSS pixels.
    pageEl.appendChild(this.annotLayer);
    pageEl.appendChild(this.searchLayer);
    pageEl.appendChild(this.selectionLayer);
    pageEl.appendChild(this.overlay);
  }

  private bindNativeSelectionSuppression() {
    this.unbindNativeSelectionSuppression();
    this.pageEl.addEventListener("selectstart", this.suppressNativeSelection);
    this.pageEl.addEventListener("dragstart", this.suppressNativeSelection);
  }

  private unbindNativeSelectionSuppression() {
    this.pageEl.removeEventListener("selectstart", this.suppressNativeSelection);
    this.pageEl.removeEventListener("dragstart", this.suppressNativeSelection);
  }

  private onPageResize() {
    const width =
      this.overlay?.getBoundingClientRect().width ?? this.pageEl.clientWidth;
    if (width === 0 || Math.abs(width - this.lastWidth) < 0.5) return;
    this.lastWidth = width;
    this.renderAnnotations();
    this.renderSearch();
    this.renderSelection();
  }

  private scale(): number {
    const overlayWidth = this.overlay?.getBoundingClientRect().width ?? 0;
    const base = overlayWidth > 0 ? overlayWidth : this.pageEl.clientWidth;
    if (base <= 0 || this.data.pdfWidth <= 0) return 1;
    return base / this.data.pdfWidth;
  }

  private toPdfCoords(e: PointerEvent | MouseEvent): Point {
    const rect = this.overlay.getBoundingClientRect();
    const s =
      (rect.width > 0 ? rect.width : this.pageEl.clientWidth) /
        (this.data.pdfWidth || 1) || 1;
    return { x: (e.clientX - rect.left) / s, y: (e.clientY - rect.top) / s };
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    window.getSelection()?.removeAllRanges();
    const p = this.toPdfCoords(e);
    const hitAnnot = this.hitTestAnnotation(p);
    if (hitAnnot) {
      this.callbacks.onAnnotationClicked(hitAnnot);
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    // Click on empty area: clear any active selection/annotation state
    this.callbacks.onSelectionCleared();
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
      this.callbacks.onSelectionCleared();
      return;
    }
    this.notifySelectionReady();
  };

  private onDoubleClick = (e: MouseEvent) => {
    const point = this.toPdfCoords(e);
    const idx = findCharIndex(this.data.chars, point);
    if (idx < 0) return;
    const range = findWordBoundaries(this.data.chars, idx);
    if (!range) return;
    const [lo, hi] = range;
    this.startPoint = centerOf(this.data.chars[lo]);
    this.endPoint = centerOf(this.data.chars[hi]);
    this.renderSelection();
    this.notifySelectionReady();
  };

  private notifySelectionReady() {
    const range = this.selectedIndices();
    if (!range) return;
    const [lo, hi] = range;
    const text = charsToText(this.data.chars.slice(lo, hi + 1));
    if (navigator.clipboard)
      void navigator.clipboard.writeText(text).catch(() => {});
    this.callbacks.onSelectionReady(this.data.pageNumber, lo, hi, text);
  }

  private hitTestAnnotation(p: Point): Annotation | null {
    for (const a of this.annotations) {
      for (let i = a.startIdx; i <= a.endIdx; i += 1) {
        const c = this.data.chars[i];
        if (!c) continue;
        if (p.x >= c.x0 && p.x <= c.x1 && p.y >= c.top && p.y <= c.bottom)
          return a;
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
        div.className = "bpv-annot";
        div.style.backgroundColor = annotBg(a.color);
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
