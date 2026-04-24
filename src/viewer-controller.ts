import { App, TFile } from "obsidian";
import * as pdfjsModule from "pdfjs-dist/legacy/build/pdf.mjs";
import { PPDF } from "../ppdf/src";
import { PageSelection, SearchHit } from "./page-selection";
import { AnnotationStore, AnnotColor, Annotation } from "./annotation-store";
import { FindBar, FindMatch } from "./find-bar";
import { buildPageText, charsToText, textOffsetToCharIndex } from "./text-utils";

const ANNOT_COLORS: AnnotColor[] = ["#FFFF00", "#0000FF", "#FF0000", "#00FF00"];

const COLOR_LABEL: Record<AnnotColor, string> = {
  "#FFFF00": "yellow",
  "#0000FF": "blue",
  "#FF0000": "red",
  "#00FF00": "green",
};

export interface CharBox {
  text: string;
  x0: number;
  top: number;
  x1: number;
  bottom: number;
}

export interface PageData {
  pageNumber: number;
  pdfWidth: number;
  pdfHeight: number;
  chars: CharBox[];
}

function wrapObsidianProxy(documentProxy: any): PPDF {
  const pdf = Object.create(PPDF.prototype) as PPDF;
  (pdf as any).pdfjs = pdfjsModule;
  (pdf as any).documentProxy = documentProxy;
  (pdf as any).metadata = {};
  (pdf as any).path = undefined;
  return pdf;
}

export class ViewerController {
  private readonly pageData = new Map<number, PageData>();
  private readonly pendingPages = new Map<number, Promise<PageData | null>>();
  private readonly handlers = new Map<number, PageSelection>();
  private observer?: MutationObserver;
  private destroyed = false;
  private loadError?: unknown;
  private pdf?: PPDF;
  private scanScheduled = false;
  private viewerRoot?: HTMLElement;
  private findBar?: FindBar;
  private activeSearchMatches: FindMatch[] = [];
  private activeMatchIdx = -1;
  private unsubscribe?: () => void;
  private keydownHandler?: (e: KeyboardEvent) => void;

  // Leaf toolbar (mounted in Obsidian's .view-actions area)
  private leafToolbar?: HTMLElement;
  private activeSelection?: { page: number; lo: number; hi: number; text: string };
  private activeAnnotation?: Annotation;

  constructor(
    private readonly app: App,
    private readonly view: any,
    public readonly file: TFile,
    private readonly store: AnnotationStore,
  ) {}

  async start() {
    try {
      const proxy = await this.obtainDocumentProxy();
      if (this.destroyed || !proxy) return;
      this.pdf = wrapObsidianProxy(proxy);
    } catch (err) {
      this.loadError = err;
      console.error("[beautiful-pdf-viewer] failed to obtain PDF document", this.file.path, err);
      return;
    }
    if (this.destroyed) return;
    this.viewerRoot = this.findViewerRoot() ?? this.view.containerEl;
    this.buildLeafToolbar();
    this.attachObserver();
    this.attachKeydown();
    this.unsubscribe = this.store.subscribe(this.file.path, () => this.refreshAnnotations());
    this.scan();
  }

  destroy() {
    this.destroyed = true;
    this.observer?.disconnect();
    if (this.keydownHandler && this.view?.containerEl) {
      this.view.containerEl.removeEventListener("keydown", this.keydownHandler, true);
    }
    this.unsubscribe?.();
    for (const handler of this.handlers.values()) {
      handler.detach();
    }
    this.handlers.clear();
    this.findBar?.destroy();
    this.findBar = undefined;
    this.leafToolbar?.remove();
    this.leafToolbar = undefined;
    this.pdf = undefined;
  }

  private async obtainDocumentProxy(): Promise<any> {
    // First, try to reuse Obsidian's already-loaded document for a few seconds.
    // Its internal layout varies across versions so we probe a bunch of paths
    // and also walk object values looking for a .numPages getter.
    const proxy = await this.waitForObsidianDocument(5000);
    if (proxy) return proxy;
    if (this.destroyed) return null;

    // Fallback: read the file directly from the vault and parse with pdf.js
    // ourselves. This works even when the Obsidian PDF view never exposes its
    // document proxy to us (timing, internal refactors, protected fields, ...).
    console.info("[beautiful-pdf-viewer] Obsidian PDF proxy unavailable, loading file directly", this.file.path);
    const buffer = await this.app.vault.readBinary(this.file);
    if (this.destroyed) return null;
    const task = (pdfjsModule as any).getDocument({
      data: new Uint8Array(buffer),
      disableFontFace: true,
      useSystemFonts: false,
    });
    return task.promise;
  }

  private async waitForObsidianDocument(timeoutMs: number): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.destroyed) return null;
      const proxy = this.findDocumentProxy(this.view);
      if (proxy) return proxy;
      await new Promise((r) => setTimeout(r, 100));
    }
    return null;
  }

  private findDocumentProxy(root: any): any {
    if (!root || typeof root !== "object") return null;
    const seen = new Set<any>();
    const queue: any[] = [root];
    let steps = 0;
    while (queue.length > 0 && steps < 200) {
      steps += 1;
      const node = queue.shift();
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      if (this.looksLikeDocumentProxy(node)) return node;
      for (const key of ["pdfDocument", "pdf", "pdfViewer", "viewer", "child", "children", "_child"]) {
        const value = node[key];
        if (value && typeof value === "object" && !seen.has(value)) queue.push(value);
      }
    }
    return null;
  }

  private looksLikeDocumentProxy(value: any): boolean {
    if (!value || typeof value !== "object") return false;
    const hasNumPages = typeof value.numPages === "number" && value.numPages > 0;
    const hasGetPage = typeof value.getPage === "function";
    return hasNumPages && hasGetPage;
  }

  private findViewerRoot(): HTMLElement | null {
    const root = this.view?.containerEl as HTMLElement | undefined;
    if (!root) return null;
    return (
      root.querySelector<HTMLElement>(".pdf-viewer") ??
      root.querySelector<HTMLElement>(".pdfViewer") ??
      root
    );
  }

  private attachObserver() {
    const target = this.viewerRoot;
    if (!target) return;
    this.observer = new MutationObserver(() => this.scheduleScan());
    this.observer.observe(target, { childList: true, subtree: true });
  }

  private attachKeydown() {
    const container = this.view?.containerEl as HTMLElement | undefined;
    if (!container) return;
    this.keydownHandler = (e) => this.onKeyDown(e);
    container.addEventListener("keydown", this.keydownHandler, true);
    if (!container.hasAttribute("tabindex")) container.setAttribute("tabindex", "-1");
  }

  private onKeyDown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === "f" || e.key === "F") {
      e.preventDefault();
      e.stopPropagation();
      this.openFind();
    } else if (e.key === "a" || e.key === "A") {
      if ((e.target as HTMLElement)?.tagName === "INPUT" || (e.target as HTMLElement)?.tagName === "TEXTAREA") return;
      e.preventDefault();
      e.stopPropagation();
      this.selectAllOnCurrentPage();
    }
  }

  private openFind() {
    if (!this.findBar) {
      const host = this.view?.containerEl as HTMLElement | undefined;
      if (!host) return;
      this.findBar = new FindBar(host, {
        runSearch: (q, cs) => this.runSearch(q, cs),
        onMatchesChanged: (matches, activeIdx) => this.applySearchMatches(matches, activeIdx),
        onJumpTo: (m) => this.jumpToMatch(m),
      });
    }
    this.findBar.open();
  }

  private async runSearch(query: string, caseSensitive: boolean): Promise<FindMatch[]> {
    if (!this.pdf) return [];
    const pageCount = (this.pdf as any).documentProxy?.numPages ?? 0;
    const results: FindMatch[] = [];
    const needle = caseSensitive ? query : query.toLowerCase();
    for (let p = 1; p <= pageCount; p += 1) {
      if (this.destroyed) return [];
      const data = await this.loadPageData(p);
      if (!data) continue;
      const pageText = buildPageText(data.chars);
      const source = caseSensitive ? pageText.text : pageText.text.toLowerCase();
      let pos = 0;
      while (pos <= source.length - needle.length) {
        const idx = source.indexOf(needle, pos);
        if (idx < 0) break;
        const startIdx = textOffsetToCharIndex(pageText.charMap, idx, "start");
        const endIdx = textOffsetToCharIndex(pageText.charMap, idx + needle.length, "end");
        if (startIdx < 0 || endIdx < startIdx) {
          pos = idx + Math.max(1, needle.length);
          continue;
        }
        results.push({
          page: p,
          startIdx,
          endIdx,
          text: charsToText(data.chars.slice(startIdx, endIdx + 1)),
        });
        pos = idx + Math.max(1, needle.length);
      }
    }
    return results;
  }

  private applySearchMatches(matches: FindMatch[], activeIdx: number) {
    this.activeSearchMatches = matches;
    this.activeMatchIdx = activeIdx;
    const byPage = new Map<number, SearchHit[]>();
    matches.forEach((m, i) => {
      const list = byPage.get(m.page) ?? [];
      list.push({ startIdx: m.startIdx, endIdx: m.endIdx, active: i === activeIdx });
      byPage.set(m.page, list);
    });
    for (const [pageNum, handler] of this.handlers) {
      handler.setSearchHits(byPage.get(pageNum) ?? []);
    }
  }

  private jumpToMatch(m: FindMatch) {
    const handler = this.handlers.get(m.page);
    if (handler) {
      handler.scrollToCharRange(m.startIdx, m.endIdx);
    } else {
      const pageEl = this.viewerRoot?.querySelector<HTMLElement>(`.page[data-page-number="${m.page}"]`);
      pageEl?.scrollIntoView({ block: "center" });
    }
    // Re-apply active styling
    this.applySearchMatches(this.activeSearchMatches, this.activeMatchIdx);
  }

  private selectAllOnCurrentPage() {
    if (!this.viewerRoot) return;
    const rect = this.viewerRoot.getBoundingClientRect();
    const centerY = rect.top + rect.height / 2;
    let bestEl: HTMLElement | null = null;
    let bestDist = Infinity;
    this.viewerRoot.querySelectorAll<HTMLElement>(".page[data-page-number]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const dist = Math.abs(r.top + r.height / 2 - centerY);
      if (dist < bestDist) { bestDist = dist; bestEl = el; }
    });
    if (!bestEl) return;
    const pageNumber = Number((bestEl as HTMLElement).getAttribute("data-page-number"));
    const handler = this.handlers.get(pageNumber);
    handler?.selectAll();
  }

  private scheduleScan() {
    if (this.scanScheduled) return;
    this.scanScheduled = true;
    requestAnimationFrame(() => {
      this.scanScheduled = false;
      this.scan();
    });
  }

  private scan() {
    if (this.loadError || this.destroyed || !this.viewerRoot) return;
    const pages = this.viewerRoot.querySelectorAll<HTMLElement>(".page[data-page-number]");
    pages.forEach((el) => this.attachPage(el));
  }

  private refreshAnnotations() {
    for (const [pageNum, handler] of this.handlers) {
      handler.setAnnotations(this.store.listForPage(this.file.path, pageNum));
    }
  }

  private buildLeafToolbar() {
    const containerEl = this.view?.containerEl as HTMLElement | undefined;
    if (!containerEl) return;
    // Try the standard Obsidian view-actions bar; fall back to the view header.
    const actionsEl =
      containerEl.querySelector<HTMLElement>(".view-actions") ??
      containerEl.querySelector<HTMLElement>(".view-header") ??
      containerEl;

    const toolbar = document.createElement("div");
    toolbar.className = "bpv-leaf-toolbar";
    toolbar.style.display = "none";

    for (const color of ANNOT_COLORS) {
      const label = COLOR_LABEL[color];
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `bpv-leaf-color bpv-leaf-color-${label}`;
      btn.setAttribute("aria-label", `Highlight ${label}`);
      btn.setAttribute("title", `Highlight ${label}`);
      btn.dataset.color = color;
      btn.addEventListener("click", () => this.applyLeafColor(color));
      toolbar.appendChild(btn);
    }

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "bpv-leaf-delete";
    delBtn.setAttribute("aria-label", "Delete highlight");
    delBtn.setAttribute("title", "Delete highlight");
    delBtn.textContent = "✕";
    delBtn.style.display = "none";
    delBtn.addEventListener("click", () => this.deleteActiveAnnotation());
    toolbar.appendChild(delBtn);

    // Insert before the first existing child so it appears on the left side
    actionsEl.prepend(toolbar);
    this.leafToolbar = toolbar;
  }

  private showLeafToolbar(mode: "selection" | "annotation", activeColor?: AnnotColor) {
    if (!this.leafToolbar) return;
    this.leafToolbar.querySelectorAll<HTMLElement>(".bpv-leaf-color").forEach((btn) => {
      const isActive = mode === "annotation" && btn.dataset.color === activeColor;
      btn.classList.toggle("is-active", isActive);
    });
    const delBtn = this.leafToolbar.querySelector<HTMLElement>(".bpv-leaf-delete");
    if (delBtn) delBtn.style.display = mode === "annotation" ? "" : "none";
    this.leafToolbar.style.display = "flex";
  }

  private hideLeafToolbar() {
    if (this.leafToolbar) this.leafToolbar.style.display = "none";
  }

  private applyLeafColor(color: AnnotColor) {
    if (this.activeSelection) {
      const { page, lo, hi, text } = this.activeSelection;
      this.store.add(this.file.path, { page, startIdx: lo, endIdx: hi, color, text });
      this.handlers.get(page)?.clearSelection();
      this.activeSelection = undefined;
      this.hideLeafToolbar();
    } else if (this.activeAnnotation) {
      this.store.update(this.file.path, this.activeAnnotation.id, { color });
      this.activeAnnotation = { ...this.activeAnnotation, color };
      this.showLeafToolbar("annotation", color);
    }
  }

  private deleteActiveAnnotation() {
    if (!this.activeAnnotation) return;
    this.store.remove(this.file.path, this.activeAnnotation.id);
    this.activeAnnotation = undefined;
    this.hideLeafToolbar();
  }

  private attachPage(el: HTMLElement) {
    const pageNumber = Number(el.getAttribute("data-page-number"));
    if (!Number.isFinite(pageNumber) || pageNumber <= 0) return;

    const data = this.pageData.get(pageNumber);
    if (!data) {
      void this.loadPageData(pageNumber);
      return;
    }

    el.classList.add("bpv-enabled");
    const existing = this.handlers.get(pageNumber);
    if (existing) {
      existing.ensureAttached(el);
      return;
    }
    const handler = new PageSelection(el, data, {
      onSelectionReady: (page, lo, hi, text) => {
        this.activeAnnotation = undefined;
        this.activeSelection = { page, lo, hi, text };
        this.showLeafToolbar("selection");
      },
      onSelectionCleared: () => {
        this.activeSelection = undefined;
        this.hideLeafToolbar();
      },
      onAnnotationClicked: (ann) => {
        this.activeSelection = undefined;
        this.activeAnnotation = ann;
        this.showLeafToolbar("annotation", ann.color);
      },
    });
    handler.attach();
    handler.setAnnotations(this.store.listForPage(this.file.path, pageNumber));
    const hits = this.activeSearchMatches
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.page === pageNumber)
      .map(({ m, i }): SearchHit => ({ startIdx: m.startIdx, endIdx: m.endIdx, active: i === this.activeMatchIdx }));
    handler.setSearchHits(hits);
    this.handlers.set(pageNumber, handler);
  }

  private loadPageData(pageNumber: number): Promise<PageData | null> {
    const cached = this.pendingPages.get(pageNumber);
    if (cached) return cached;
    const promise = (async (): Promise<PageData | null> => {
      if (!this.pdf || this.destroyed) return null;
      try {
        const page = await this.pdf.getPage(pageNumber);
        if (this.destroyed) return null;
        const chars = await page.getChars();
        if (this.destroyed) return null;
        const data: PageData = {
          pageNumber,
          pdfWidth: page.width,
          pdfHeight: page.height,
          chars: chars.map((c) => ({
            text: c.text,
            x0: c.x0,
            top: c.top,
            x1: c.x1,
            bottom: c.bottom,
          })),
        };
        this.pageData.set(pageNumber, data);
        this.scheduleScan();
        return data;
      } catch (err) {
        console.error("[beautiful-pdf-viewer] failed to parse page", pageNumber, err);
        return null;
      }
    })();
    this.pendingPages.set(pageNumber, promise);
    return promise;
  }
}
