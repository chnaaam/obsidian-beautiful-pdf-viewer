import type { Plugin } from "obsidian";

export type AnnotColor = "yellow" | "blue" | "red" | "green";

export interface Annotation {
  id: string;
  page: number;
  color: AnnotColor;
  startIdx: number;
  endIdx: number;
  text: string;
  created: number;
}

interface PersistFormat {
  version: 1;
  files: Record<string, Annotation[]>;
}

function makeId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export class AnnotationStore {
  private data: PersistFormat = { version: 1, files: {} };
  private saveTimer?: number;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor(private readonly plugin: Plugin) {}

  async load() {
    const raw = (await this.plugin.loadData()) as PersistFormat | null;
    if (raw && raw.version === 1 && raw.files) {
      this.data = raw;
    }
  }

  list(path: string): Annotation[] {
    return this.data.files[path] ?? [];
  }

  listForPage(path: string, page: number): Annotation[] {
    return this.list(path).filter((a) => a.page === page);
  }

  add(path: string, entry: Omit<Annotation, "id" | "created">): Annotation {
    const ann: Annotation = { ...entry, id: makeId(), created: Date.now() };
    const list = this.data.files[path] ?? [];
    list.push(ann);
    this.data.files[path] = list;
    this.scheduleSave();
    this.emit(path);
    return ann;
  }

  update(path: string, id: string, patch: Partial<Annotation>) {
    const list = this.data.files[path];
    if (!list) return;
    const idx = list.findIndex((a) => a.id === id);
    if (idx < 0) return;
    list[idx] = { ...list[idx], ...patch };
    this.scheduleSave();
    this.emit(path);
  }

  remove(path: string, id: string) {
    const list = this.data.files[path];
    if (!list) return;
    this.data.files[path] = list.filter((a) => a.id !== id);
    this.scheduleSave();
    this.emit(path);
  }

  subscribe(path: string, listener: () => void): () => void {
    let set = this.listeners.get(path);
    if (!set) {
      set = new Set();
      this.listeners.set(path, set);
    }
    set.add(listener);
    return () => set!.delete(listener);
  }

  private emit(path: string) {
    const set = this.listeners.get(path);
    if (!set) return;
    for (const l of set) l();
  }

  private scheduleSave() {
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      void this.plugin.saveData(this.data);
    }, 400);
  }
}
