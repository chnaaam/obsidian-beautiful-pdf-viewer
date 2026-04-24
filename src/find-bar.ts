export interface FindMatch {
  page: number;
  startIdx: number;
  endIdx: number;
  text: string;
}

export interface FindBarCallbacks {
  runSearch: (query: string, caseSensitive: boolean) => Promise<FindMatch[]>;
  onMatchesChanged: (matches: FindMatch[], activeIdx: number) => void;
  onJumpTo: (match: FindMatch) => void;
}

export class FindBar {
  private el?: HTMLElement;
  private input?: HTMLInputElement;
  private counter?: HTMLSpanElement;
  private caseToggle?: HTMLButtonElement;
  private caseSensitive = false;
  private matches: FindMatch[] = [];
  private activeIdx = -1;
  private searchToken = 0;
  private debounceTimer?: number;

  constructor(private readonly host: HTMLElement, private readonly callbacks: FindBarCallbacks) {}

  open() {
    if (!this.el) this.build();
    this.el!.classList.remove("is-hidden");
    this.input!.focus();
    this.input!.select();
  }

  close() {
    this.el?.classList.add("is-hidden");
    this.matches = [];
    this.activeIdx = -1;
    this.callbacks.onMatchesChanged([], -1);
  }

  isOpen(): boolean {
    return !!this.el && !this.el.classList.contains("is-hidden");
  }

  destroy() {
    this.el?.remove();
    this.el = undefined;
  }

  next() {
    if (this.matches.length === 0) return;
    this.activeIdx = (this.activeIdx + 1) % this.matches.length;
    this.emit();
    this.callbacks.onJumpTo(this.matches[this.activeIdx]);
  }

  prev() {
    if (this.matches.length === 0) return;
    this.activeIdx = (this.activeIdx - 1 + this.matches.length) % this.matches.length;
    this.emit();
    this.callbacks.onJumpTo(this.matches[this.activeIdx]);
  }

  private build() {
    this.el = document.createElement("div");
    this.el.className = "bpv-findbar is-hidden";
    this.el.addEventListener("pointerdown", (e) => e.stopPropagation());

    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.placeholder = "Find in PDF";
    this.input.className = "bpv-findbar-input";
    this.input.addEventListener("input", () => this.scheduleSearch());
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    this.el.appendChild(this.input);

    this.caseToggle = document.createElement("button");
    this.caseToggle.type = "button";
    this.caseToggle.className = "bpv-findbar-btn";
    this.caseToggle.textContent = "Aa";
    this.caseToggle.title = "Match case";
    this.caseToggle.addEventListener("click", () => {
      this.caseSensitive = !this.caseSensitive;
      this.caseToggle!.classList.toggle("is-active", this.caseSensitive);
      this.scheduleSearch();
    });
    this.el.appendChild(this.caseToggle);

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "bpv-findbar-btn";
    prevBtn.textContent = "▲";
    prevBtn.title = "Previous";
    prevBtn.addEventListener("click", () => this.prev());
    this.el.appendChild(prevBtn);

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "bpv-findbar-btn";
    nextBtn.textContent = "▼";
    nextBtn.title = "Next";
    nextBtn.addEventListener("click", () => this.next());
    this.el.appendChild(nextBtn);

    this.counter = document.createElement("span");
    this.counter.className = "bpv-findbar-counter";
    this.el.appendChild(this.counter);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "bpv-findbar-btn";
    closeBtn.textContent = "✕";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", () => this.close());
    this.el.appendChild(closeBtn);

    this.host.appendChild(this.el);
    this.updateCounter();
  }

  private onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) this.prev();
      else this.next();
    } else if (e.key === "Escape") {
      e.preventDefault();
      this.close();
    }
  }

  private scheduleSearch() {
    if (this.debounceTimer) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = undefined;
      void this.runSearch();
    }, 150);
  }

  private async runSearch() {
    const query = this.input?.value ?? "";
    const token = ++this.searchToken;
    if (!query) {
      this.matches = [];
      this.activeIdx = -1;
      this.emit();
      return;
    }
    const results = await this.callbacks.runSearch(query, this.caseSensitive);
    if (token !== this.searchToken) return;
    this.matches = results;
    this.activeIdx = results.length > 0 ? 0 : -1;
    this.emit();
    if (this.activeIdx >= 0) this.callbacks.onJumpTo(this.matches[this.activeIdx]);
  }

  private emit() {
    this.updateCounter();
    this.callbacks.onMatchesChanged(this.matches, this.activeIdx);
  }

  private updateCounter() {
    if (!this.counter) return;
    if (this.matches.length === 0) {
      this.counter.textContent = this.input?.value ? "No results" : "";
    } else {
      this.counter.textContent = `${this.activeIdx + 1} / ${this.matches.length}`;
    }
  }
}
