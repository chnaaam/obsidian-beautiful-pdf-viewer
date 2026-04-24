import type { CharBox, PageData } from "./viewer-controller";

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

export class PageSelection {
  private pageEl: HTMLElement;
  private overlay!: HTMLDivElement;
  private highlightLayer!: HTMLDivElement;
  private dragging = false;
  private startPoint?: Point;
  private endPoint?: Point;
  private resizeObserver?: ResizeObserver;
  private lastWidth = 0;

  constructor(pageEl: HTMLElement, private readonly data: PageData) {
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

    this.highlightLayer = document.createElement("div");
    this.highlightLayer.className = "bpv-highlight-layer";

    this.mountInto(this.pageEl);

    this.resizeObserver = new ResizeObserver(() => this.onPageResize());
    this.resizeObserver.observe(this.pageEl);
    this.lastWidth = this.pageEl.clientWidth;
  }

  ensureAttached(el: HTMLElement) {
    if (this.pageEl !== el) {
      this.resizeObserver?.disconnect();
      this.pageEl = el;
      this.resizeObserver = new ResizeObserver(() => this.onPageResize());
      this.resizeObserver.observe(this.pageEl);
      this.lastWidth = this.pageEl.clientWidth;
    }
    const needsOverlay = this.overlay.parentElement !== this.pageEl;
    const annotationLayer = this.pageEl.querySelector<HTMLElement>(".annotationLayer");
    const highlightHost = annotationLayer ?? this.pageEl;
    const needsHighlight = this.highlightLayer.parentElement !== highlightHost;
    if (needsOverlay || needsHighlight) {
      this.mountInto(this.pageEl);
      if (this.startPoint && this.endPoint) this.render();
    }
  }

  private mountInto(pageEl: HTMLElement) {
    const annotationLayer = pageEl.querySelector<HTMLElement>(".annotationLayer");
    (annotationLayer ?? pageEl).appendChild(this.highlightLayer);
    pageEl.appendChild(this.overlay);
  }

  detach() {
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.overlay.remove();
    this.highlightLayer.remove();
  }

  private onPageResize() {
    const width = this.pageEl.clientWidth;
    if (width === 0 || width === this.lastWidth) return;
    this.lastWidth = width;
    if (this.startPoint && this.endPoint) {
      this.render();
    }
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
    this.dragging = true;
    try {
      this.overlay.setPointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    this.startPoint = this.toPdfCoords(e);
    this.endPoint = this.startPoint;
    this.render();
    e.preventDefault();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.endPoint = this.toPdfCoords(e);
    this.render();
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
    this.render();
    const text = this.selectedText();
    if (text) {
      void navigator.clipboard?.writeText(text).catch(() => {});
    }
  };

  private onDoubleClick = (e: MouseEvent) => {
    const point = this.toPdfCoords(e);
    const idx = findCharIndex(this.data.chars, point);
    if (idx < 0) return;
    const [lo, hi] = wordRange(this.data.chars, idx);
    if (lo < 0) return;
    this.startPoint = centerOf(this.data.chars[lo]);
    this.endPoint = centerOf(this.data.chars[hi]);
    this.render();
  };

  private render() {
    this.highlightLayer.innerHTML = "";
    if (!this.startPoint || !this.endPoint) return;

    const chars = this.selectedChars();
    if (chars.length === 0) return;

    const lines = groupIntoLines(chars);
    const s = this.scale();
    for (const line of lines) {
      const div = document.createElement("div");
      div.className = "bpv-highlight";
      div.style.left = `${line.x0 * s}px`;
      div.style.top = `${line.top * s}px`;
      div.style.width = `${Math.max(1, (line.x1 - line.x0) * s)}px`;
      div.style.height = `${Math.max(1, (line.bottom - line.top) * s)}px`;
      this.highlightLayer.appendChild(div);
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

  private selectedText(): string {
    return this.selectedChars()
      .map((c) => c.text)
      .join("");
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
