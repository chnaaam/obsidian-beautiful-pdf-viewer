import { App, TFile } from "obsidian";
import * as pdfjsModule from "pdfjs-dist/legacy/build/pdf.mjs";
import { PPDF } from "../ppdf/src";
import { PageSelection, SearchHit } from "./page-selection";
import { AnnotationStore, AnnotColor } from "./annotation-store";
import { FindBar, FindMatch } from "./find-bar";

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

  constructor(
    private readonly app: App,
    private readonly view: any,
    public readonly file: TFile,
    private readonly store: AnnotationStore,
  ) {}

  async start() {
    try {
      const proxy = await this.waitForObsidianDocument();
      if (this.destroyed || !proxy) return;
      this.pdf = wrapObsidianProxy(proxy);
    } catch (err) {
      this.loadError = err;
      console.error("[beautiful-pdf-viewer] could not reuse Obsidian PDF proxy", this.file.path, err);
      return;
    }
    if (this.destroyed) return;
    this.viewerRoot = this.findViewerRoot() ?? this.view.containerEl;
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
    this.pdf = undefined;
  }

  private async waitForObsidianDocument(): Promise<any> {
    for (let i = 0; i < 100; i += 1) {
      if (this.destroyed) return null;
      const proxy =
        this.view?.viewer?.pdfViewer?.pdfDocument ??
        this.view?.viewer?.pdfDocument ??
        this.view?.pdfViewer?.pdfDocument;
      if (proxy) return proxy;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("timed out waiting for Obsidian PDF document");
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
      const source = caseSensitive
        ? data.chars.map((c) => c.text).join("")
        : data.chars.map((c) => c.text.toLowerCase()).join("");
      let pos = 0;
      while (pos <= source.length - needle.length) {
        const idx = source.indexOf(needle, pos);
        if (idx < 0) break;
        results.push({
          page: p,
          startIdx: idx,
          endIdx: idx + needle.length - 1,
          text: data.chars.slice(idx, idx + needle.length).map((c) => c.text).join(""),
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
    let best: { el: HTMLElement; dist: number } | null = null;
    this.viewerRoot.querySelectorAll<HTMLElement>(".page[data-page-number]").forEach((el) => {
      const r = el.getBoundingClientRect();
      const pageCenter = r.top + r.height / 2;
      const dist = Math.abs(pageCenter - centerY);
      if (!best || dist < best.dist) best = { el, dist };
    });
    if (!best) return;
    const pageNumber = Number(best.el.getAttribute("data-page-number"));
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
      onCreateAnnotation: (page, startIdx, endIdx, color, text) => {
        this.store.add(this.file.path, { page, startIdx, endIdx, color, text });
      },
      onUpdateAnnotation: (id, color) => {
        this.store.update(this.file.path, id, { color });
      },
      onDeleteAnnotation: (id) => {
        this.store.remove(this.file.path, id);
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
