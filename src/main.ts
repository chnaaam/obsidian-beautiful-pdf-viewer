import { Plugin, TFile, WorkspaceLeaf } from "obsidian";
import { ViewerController } from "./viewer-controller";
import { AnnotationStore } from "./annotation-store";

export default class BeautifulPdfViewerPlugin extends Plugin {
  private controllers = new Map<WorkspaceLeaf, ViewerController>();
  private store!: AnnotationStore;

  async onload() {
    this.store = new AnnotationStore(this);
    await this.store.load();

    this.registerEvent(this.app.workspace.on("file-open", () => this.sync()));
    this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.sync()));
    this.registerEvent(this.app.workspace.on("layout-change", () => this.sync()));
    this.app.workspace.onLayoutReady(() => this.sync());
  }

  onunload() {
    for (const controller of this.controllers.values()) {
      controller.destroy();
    }
    this.controllers.clear();
  }

  private sync() {
    const leaves = this.app.workspace.getLeavesOfType("pdf");
    const alive = new Set<WorkspaceLeaf>();

    for (const leaf of leaves) {
      const view = leaf.view as unknown as { file?: TFile; containerEl: HTMLElement };
      const file = view?.file;
      if (!file) continue;

      alive.add(leaf);
      const existing = this.controllers.get(leaf);
      if (existing && existing.file.path === file.path) continue;
      if (existing) existing.destroy();

      const controller = new ViewerController(this.app, view, file, this.store);
      this.controllers.set(leaf, controller);
      void controller.start();
    }

    for (const [leaf, controller] of this.controllers) {
      if (!alive.has(leaf)) {
        controller.destroy();
        this.controllers.delete(leaf);
      }
    }
  }
}
