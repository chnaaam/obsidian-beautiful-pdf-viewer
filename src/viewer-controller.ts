import { App, TFile } from "obsidian";
import * as pdfjsModule from "pdfjs-dist/legacy/build/pdf.mjs";
import { PPDF } from "../ppdf/src";
import { PageSelection } from "./page-selection";

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

  constructor(private readonly app: App, private readonly view: any, public readonly file: TFile) {}

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
    this.scan();
  }

  destroy() {
    this.destroyed = true;
    this.observer?.disconnect();
    for (const handler of this.handlers.values()) {
      handler.detach();
    }
    this.handlers.clear();
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
    const handler = new PageSelection(el, data);
    handler.attach();
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
