import "./styles.css";
import {
  type AnswerOutline,
  type HeadingInfo,
  extractAnswerOutlines,
  flattenHeadings,
  getVisibleHeadingsForAnswer
} from "../shared/headings";
import {
  DEFAULT_SETTINGS,
  type HeadingDepth,
  type TocSettings,
  headingDepths,
  getSettings,
  mergeSettings,
  saveSettings,
  subscribeSettings
} from "../shared/settings";

const ROOT_ID = "gpt-reader-root";
const ASSISTANT_SELECTOR = "[data-message-author-role='assistant']";
const WIDTH_STORAGE_KEY = "gptReaderPanelWidth";
const POSITION_STORAGE_KEY = "gptReaderPanelPosition";
const UI_STORAGE_KEY = "gptReaderUiState";
const DEFAULT_PANEL_WIDTH = 296;
const MIN_PANEL_WIDTH = 260;
const MAX_PANEL_WIDTH = 440;
const SCAN_DEBOUNCE_MS = 120;
const ACTIVE_ANCHOR_RATIO = 0.48;
const CLICK_SCROLL_SYNC_PAUSE_MS = 350;

type PanelPosition = {
  left: number;
  top: number;
};

type PanelUiState = {
  width?: number;
  position?: PanelPosition | null;
};

const escapeText = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[char];
  });

class ChatGptReader {
  private root: HTMLElement | null = null;
  private list: HTMLElement | null = null;
  private activeDot: HTMLElement | null = null;
  private settings: TocSettings = DEFAULT_SETTINGS;
  private outlines: AnswerOutline[] = [];
  private allHeadings: HeadingInfo[] = [];
  private focusHeadings: HeadingInfo[] = [];
  private expandedAnswerIds = new Set<string>();
  private collapsedAnswerIds = new Set<string>();
  private currentHeadingId: string | null = null;
  private currentAnswerId: string | null = null;
  private mutationObserver: MutationObserver | null = null;
  private scanTimer: number | null = null;
  private activeFrame: number | null = null;
  private panelWidth = DEFAULT_PANEL_WIDTH;
  private panelPosition: PanelPosition | null = null;
  private resizeStartX = 0;
  private resizeStartWidth = DEFAULT_PANEL_WIDTH;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartLeft = 0;
  private dragStartTop = 0;
  private isResizing = false;
  private isDragging = false;
  private suppressActiveSyncUntil = 0;
  private collapsed = false;
  private unsubscribeSettings: (() => void) | null = null;

  async init(): Promise<void> {
    this.settings = await getSettings();
    await this.loadPanelUiState();
    this.ensureShell();
    this.bindEvents();
    this.render();
    this.scan();
    this.observePage();
    this.observeSettings();
    window.addEventListener("scroll", this.queueActiveUpdate, { passive: true });
    window.addEventListener("resize", this.queueActiveUpdate, { passive: true });
    document.addEventListener("scroll", this.handleDocumentScroll, {
      passive: true,
      capture: true
    });
  }

  private ensureShell(): void {
    const existing = document.getElementById(ROOT_ID);
    if (existing) {
      this.root = existing;
      this.list = existing.querySelector<HTMLElement>("[data-gpt-reader-list]");
      this.activeDot = existing.querySelector<HTMLElement>("[data-gpt-reader-active-dot]");
      this.applyPanelWidth();
      this.applyPanelPosition();
      return;
    }

    const root = document.createElement("aside");
    root.id = ROOT_ID;
    root.innerHTML = `
      <section class="gpt-reader-panel" aria-label="ChatGPT 回答目录">
        <header class="gpt-reader-header">
          <div>
            <strong>回答目录</strong>
            <span data-gpt-reader-count>等待标题</span>
          </div>
          <div class="gpt-reader-header-actions">
            <button type="button" class="gpt-reader-icon-button" data-gpt-reader-collapse title="收起目录">收起</button>
            <button type="button" class="gpt-reader-icon-button" data-gpt-reader-settings-toggle aria-expanded="false">设置</button>
          </div>
        </header>
        <form class="gpt-reader-settings" data-gpt-reader-settings hidden>
          <label class="gpt-reader-switch">
            <input type="checkbox" data-gpt-reader-enabled />
            <span>启用目录</span>
          </label>
          <div class="gpt-reader-field">
            <span>目录最大层级</span>
            <div class="gpt-reader-depths" data-gpt-reader-depths></div>
          </div>
          <label class="gpt-reader-switch">
            <input type="checkbox" data-gpt-reader-expand-current />
            <span>只展开当前回答</span>
          </label>
          <p>其他回答默认折叠，可点击回答标题展开</p>
        </form>
        <div class="gpt-reader-body">
          <div class="gpt-reader-rail" aria-hidden="true">
            <span data-gpt-reader-active-dot></span>
          </div>
          <nav data-gpt-reader-list></nav>
        </div>
        <div class="gpt-reader-resize-handle" data-gpt-reader-resize title="拖拽调整目录宽度" aria-hidden="true"></div>
      </section>
      <button type="button" class="gpt-reader-float" data-gpt-reader-float>目录</button>
    `;

    document.body.append(root);
    this.root = root;
    this.list = root.querySelector<HTMLElement>("[data-gpt-reader-list]");
    this.activeDot = root.querySelector<HTMLElement>("[data-gpt-reader-active-dot]");
    this.applyPanelWidth();
    this.applyPanelPosition();
  }

  private bindEvents(): void {
    this.list?.addEventListener("scroll", () => this.positionActiveDot(), { passive: true });

    this.root?.addEventListener("pointerdown", (event) => {
      const target = event.target as HTMLElement;
      if (target.closest("[data-gpt-reader-resize]")) {
        this.startResize(event);
        return;
      }

      if (
        target.closest(".gpt-reader-header") &&
        !target.closest("button, input, label, [data-gpt-reader-settings-toggle]")
      ) {
        this.startDrag(event);
      }
    });

    this.root?.addEventListener("click", (event) => {
      const target = event.target as HTMLElement;
      const headingButton = target.closest<HTMLButtonElement>("[data-gpt-reader-heading]");
      const depthButton = target.closest<HTMLButtonElement>("[data-gpt-reader-depth]");
      const answerToggle = target.closest<HTMLButtonElement>("[data-gpt-reader-answer-toggle]");

      if (headingButton) {
        this.scrollToHeading(headingButton.dataset.gptReaderHeading);
        return;
      }

      if (answerToggle) {
        this.toggleAnswer(answerToggle.dataset.gptReaderAnswerId);
        return;
      }

      if (depthButton) {
        const depth = Number(depthButton.dataset.gptReaderDepth) as HeadingDepth;
        void this.updateSettings({ maxDepth: depth });
        return;
      }

      if (target.closest("[data-gpt-reader-settings-toggle]")) {
        this.toggleSettings();
        return;
      }

      if (target.closest("[data-gpt-reader-collapse]")) {
        this.collapsed = true;
        this.render();
        return;
      }

      if (target.closest("[data-gpt-reader-float]")) {
        this.collapsed = false;
        this.render();
      }
    });

    this.root?.addEventListener("change", (event) => {
      const target = event.target as HTMLInputElement;
      if (target.matches("[data-gpt-reader-enabled]")) {
        void this.updateSettings({ enabled: target.checked });
      }

      if (target.matches("[data-gpt-reader-expand-current]")) {
        void this.updateSettings({ expandCurrentOnly: target.checked });
      }
    });
  }

  private observePage(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = new MutationObserver((mutations) => {
      if (this.root && mutations.every((mutation) => this.root?.contains(mutation.target))) {
        return;
      }

      this.queueScan();
    });
    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  private observeSettings(): void {
    this.unsubscribeSettings?.();
    this.unsubscribeSettings = subscribeSettings((settings) => {
      this.settings = settings;
      this.refreshHeadingCaches();
      const activeHeading = this.findActiveHeadingFromScroll();
      if (activeHeading) {
        this.currentHeadingId = activeHeading.id;
        this.currentAnswerId = activeHeading.answerId;
      }
      this.render();
      this.queueActiveUpdate();
    });
  }

  private queueScan = (): void => {
    if (this.scanTimer) {
      window.clearTimeout(this.scanTimer);
    }

    this.scanTimer = window.setTimeout(() => {
      this.scanTimer = null;
      this.scan();
    }, SCAN_DEBOUNCE_MS);
  };

  private scan(): void {
    const answerElements = Array.from(document.querySelectorAll<HTMLElement>(ASSISTANT_SELECTOR));
    this.outlines = extractAnswerOutlines(answerElements);
    this.expandedAnswerIds = new Set(
      [...this.expandedAnswerIds].filter((answerId) =>
        this.outlines.some((outline) => outline.id === answerId)
      )
    );
    this.collapsedAnswerIds = new Set(
      [...this.collapsedAnswerIds].filter((answerId) =>
        this.outlines.some((outline) => outline.id === answerId)
      )
    );
    this.refreshHeadingCaches();

    const activeHeading = this.findActiveHeadingFromScroll();
    if (activeHeading) {
      this.currentAnswerId = activeHeading.answerId;
      this.currentHeadingId = activeHeading.id;
    } else if (!this.outlines.some((outline) => outline.id === this.currentAnswerId)) {
      this.currentAnswerId = this.focusHeadings.at(-1)?.answerId ?? null;
      this.currentHeadingId = this.focusHeadings.at(-1)?.id ?? null;
    }

    this.render();
    this.queueActiveUpdate();
  }

  private queueActiveUpdate = (): void => {
    if (this.activeFrame) {
      return;
    }

    this.activeFrame = window.requestAnimationFrame(() => {
      this.activeFrame = null;
      this.updateActiveFromScroll();
    });
  };

  private handleDocumentScroll = (event: Event): void => {
    if (this.root && event.target instanceof Node && this.root.contains(event.target)) {
      return;
    }

    this.queueActiveUpdate();
  };

  private updateActiveFromScroll(): void {
    if (performance.now() < this.suppressActiveSyncUntil) {
      this.positionActiveDot();
      return;
    }

    if (this.focusHeadings.length === 0) {
      this.currentHeadingId = null;
      this.currentAnswerId = null;
      this.render();
      return;
    }

    const activeHeading = this.findActiveHeadingFromScroll() ?? this.focusHeadings[0];
    const previousAnswerId = this.currentAnswerId;
    const previousHeadingId = this.currentHeadingId;

    if (
      activeHeading.id !== this.currentHeadingId ||
      activeHeading.answerId !== this.currentAnswerId
    ) {
      this.currentHeadingId = activeHeading.id;
      this.currentAnswerId = activeHeading.answerId;

      if (previousAnswerId !== activeHeading.answerId) {
        this.renderList();
      } else {
        this.syncActiveHeading(previousHeadingId);
      }
    }

    this.positionActiveDot();
  }

  private render(): void {
    if (!this.root) {
      return;
    }

    this.root.classList.toggle("is-disabled", !this.settings.enabled);
    this.root.classList.toggle("is-collapsed", this.collapsed);
    this.root
      .querySelector<HTMLInputElement>("[data-gpt-reader-enabled]")
      ?.toggleAttribute("checked", this.settings.enabled);
    this.root
      .querySelector<HTMLInputElement>("[data-gpt-reader-expand-current]")
      ?.toggleAttribute("checked", this.settings.expandCurrentOnly);

    const enabledInput = this.root.querySelector<HTMLInputElement>("[data-gpt-reader-enabled]");
    if (enabledInput) {
      enabledInput.checked = this.settings.enabled;
    }

    const expandInput = this.root.querySelector<HTMLInputElement>("[data-gpt-reader-expand-current]");
    if (expandInput) {
      expandInput.checked = this.settings.expandCurrentOnly;
    }

    const count = this.root.querySelector<HTMLElement>("[data-gpt-reader-count]");
    if (count) {
      const headingCount = this.allHeadings.length;
      count.textContent = headingCount > 0 ? `${headingCount} 个标题` : "未检测到标题";
    }

    this.renderDepthButtons();
    this.renderList();
  }

  private renderDepthButtons(): void {
    const container = this.root?.querySelector<HTMLElement>("[data-gpt-reader-depths]");
    if (!container) {
      return;
    }

    container.replaceChildren(
      ...headingDepths.map((depth) => {
        const button = document.createElement("button");
        button.type = "button";
        button.dataset.gptReaderDepth = String(depth);
        button.className = depth === this.settings.maxDepth ? "is-active" : "";
        button.textContent = String(depth);
        return button;
      })
    );
  }

  private renderList(): void {
    if (!this.list) {
      return;
    }

    if (!this.settings.enabled) {
      this.list.replaceChildren();
      return;
    }

    if (this.outlines.length === 0) {
      const empty = document.createElement("p");
      empty.className = "gpt-reader-empty";
      empty.textContent = "当前回答还没有 Markdown 标题";
      this.list.replaceChildren(empty);
      this.positionActiveDot();
      return;
    }

    const fragment = document.createDocumentFragment();

    this.outlines.forEach((outline, outlineIndex) => {
      const isCurrentAnswer = outline.id === this.currentAnswerId;
      const group = document.createElement("section");
      group.className = "gpt-reader-answer";
      group.classList.toggle("is-current", isCurrentAnswer);
      const isManuallyCollapsed = this.collapsedAnswerIds.has(outline.id);
      const isPinnedOpen = !this.settings.expandCurrentOnly || isCurrentAnswer;
      const isExpanded =
        !isManuallyCollapsed && (isPinnedOpen || this.expandedAnswerIds.has(outline.id));

      const header = document.createElement("div");
      header.className = "gpt-reader-answer-title";
      header.classList.toggle("is-collapsed", !isExpanded);
      header.innerHTML = `
        <button type="button" data-gpt-reader-answer-toggle data-gpt-reader-answer-id="${escapeText(outline.id)}" aria-expanded="${isExpanded}">
          <span class="gpt-reader-answer-caret" aria-hidden="true">${isExpanded ? "v" : ">"}</span>
          <span>${escapeText(`回答 ${outlineIndex + 1}`)}</span>
        </button>
        ${isCurrentAnswer ? "<em>当前</em>" : ""}
      `;
      group.append(header);

      const headings = isExpanded
        ? getVisibleHeadingsForAnswer(
            outline,
            this.settings,
            isPinnedOpen ? this.currentAnswerId : outline.id
          )
        : [];

      headings.forEach((heading) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "gpt-reader-heading";
        button.dataset.gptReaderHeading = heading.id;
        button.classList.toggle("is-active", heading.id === this.currentHeadingId);
        button.style.setProperty(
          "--toc-indent",
          `${Math.max(0, heading.relativeDepth - 1) * 14}px`
        );
        button.title = heading.text;
        button.innerHTML = `
          <span class="gpt-reader-heading-depth">H${heading.relativeDepth}</span>
          <span>${escapeText(heading.text)}</span>
        `;
        group.append(button);
      });

      fragment.append(group);
    });

    this.list.replaceChildren(fragment);
    this.positionActiveDot();
    this.centerActiveHeading();
  }

  private syncActiveHeading(previousHeadingId: string | null): void {
    if (!this.list) {
      return;
    }

    if (previousHeadingId && previousHeadingId !== this.currentHeadingId) {
      const previousButton = this.list.querySelector<HTMLElement>(
        `[data-gpt-reader-heading="${CSS.escape(previousHeadingId)}"]`
      );
      previousButton?.classList.remove("is-active");
    }

    if (this.currentHeadingId) {
      const currentButton = this.list.querySelector<HTMLElement>(
        `[data-gpt-reader-heading="${CSS.escape(this.currentHeadingId)}"]`
      );
      currentButton?.classList.add("is-active");
    }

    this.centerActiveHeading();
  }

  private positionActiveDot(): void {
    if (!this.list || !this.activeDot) {
      return;
    }

    const activeItem = this.getActiveListItem();
    if (!activeItem) {
      this.activeDot.style.opacity = "0";
      return;
    }

    const listRect = this.list.getBoundingClientRect();
    const activeRect = activeItem.getBoundingClientRect();
    const top = Math.max(6, activeRect.top - listRect.top + activeRect.height / 2);
    this.activeDot.style.opacity = "1";
    this.activeDot.style.transform = `translateY(${top}px)`;
  }

  private centerActiveHeading(): void {
    if (!this.list) {
      return;
    }

    const activeItem = this.getActiveListItem();
    if (!activeItem) {
      return;
    }

    const nextScrollTop =
      activeItem.offsetTop - this.list.clientHeight / 2 + activeItem.offsetHeight / 2;
    this.list.scrollTop = Math.max(0, nextScrollTop);
    window.requestAnimationFrame(() => this.positionActiveDot());
  }

  private getActiveListItem(): HTMLElement | null {
    if (!this.list) {
      return null;
    }

    return (
      this.list.querySelector<HTMLElement>(".gpt-reader-heading.is-active") ??
      this.list.querySelector<HTMLElement>(".gpt-reader-answer.is-current .gpt-reader-answer-title")
    );
  }

  private scrollToHeading(headingId: string | undefined): void {
    if (!headingId) {
      return;
    }

    const heading = this.allHeadings.find((item) => item.id === headingId);
    if (!heading) {
      return;
    }

    this.currentHeadingId = heading.id;
    this.currentAnswerId = heading.answerId;
    this.suppressActiveSyncUntil = performance.now() + CLICK_SCROLL_SYNC_PAUSE_MS;
    heading.element.scrollIntoView({ behavior: "auto", block: "start" });
    this.renderList();
  }

  private toggleSettings(): void {
    const settings = this.root?.querySelector<HTMLElement>("[data-gpt-reader-settings]");
    const toggle = this.root?.querySelector<HTMLButtonElement>("[data-gpt-reader-settings-toggle]");
    if (!settings || !toggle) {
      return;
    }

    const nextOpen = settings.hidden;
    settings.hidden = !nextOpen;
    toggle.setAttribute("aria-expanded", String(nextOpen));
  }

  private async updateSettings(patch: Partial<TocSettings>): Promise<void> {
    this.settings = mergeSettings(this.settings, patch);
    this.refreshHeadingCaches();
    const activeHeading = this.findActiveHeadingFromScroll();
    if (activeHeading) {
      this.currentHeadingId = activeHeading.id;
      this.currentAnswerId = activeHeading.answerId;
    }
    this.render();
    await saveSettings(this.settings);
  }

  private toggleAnswer(answerId: string | undefined): void {
    if (!answerId) {
      return;
    }

    const outline = this.outlines.find((item) => item.id === answerId);
    if (!outline) {
      return;
    }

    const isCurrentAnswer = answerId === this.currentAnswerId;
    const isPinnedOpen = !this.settings.expandCurrentOnly || isCurrentAnswer;
    const isExpanded =
      !this.collapsedAnswerIds.has(answerId) && (isPinnedOpen || this.expandedAnswerIds.has(answerId));

    if (isExpanded) {
      this.collapsedAnswerIds.add(answerId);
      this.expandedAnswerIds.delete(answerId);
    } else {
      this.collapsedAnswerIds.delete(answerId);
      this.expandedAnswerIds.add(answerId);
    }

    this.suppressActiveSyncUntil = performance.now() + CLICK_SCROLL_SYNC_PAUSE_MS;
    this.renderList();
  }

  private refreshHeadingCaches(): void {
    this.allHeadings = flattenHeadings(this.outlines);
    this.focusHeadings = this.allHeadings.filter(
      (heading) => heading.relativeDepth <= this.settings.maxDepth
    );

    if (this.focusHeadings.length === 0) {
      this.focusHeadings = this.allHeadings;
    }
  }

  private findActiveHeadingFromScroll(): HeadingInfo | null {
    if (this.focusHeadings.length === 0) {
      return null;
    }

    const anchorY = Math.round(window.innerHeight * ACTIVE_ANCHOR_RATIO);
    let activeHeading = this.focusHeadings[0];

    for (const heading of this.focusHeadings) {
      if (heading.element.getBoundingClientRect().top <= anchorY) {
        activeHeading = heading;
      } else {
        break;
      }
    }

    return activeHeading;
  }

  private async loadPanelUiState(): Promise<void> {
    const storedState = await this.readStoredPanelUiState();
    const legacyWidth = Number(window.localStorage.getItem(WIDTH_STORAGE_KEY));
    const legacyPosition = this.readLegacyPanelPosition();
    const width = Number(storedState.width ?? legacyWidth);

    if (Number.isFinite(width)) {
      this.panelWidth = this.constrainPanelWidth(width);
    }

    this.panelPosition = storedState.position ?? legacyPosition;
  }

  private async readStoredPanelUiState(): Promise<PanelUiState> {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return {};
    }

    try {
      const result = await chrome.storage.local.get(UI_STORAGE_KEY);
      const storedState = result[UI_STORAGE_KEY] as PanelUiState | undefined;
      return storedState && typeof storedState === "object" ? storedState : {};
    } catch {
      return {};
    }
  }

  private async savePanelUiState(): Promise<void> {
    const state: PanelUiState = {
      width: Math.round(this.panelWidth),
      position: this.panelPosition
    };

    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(state.width));
    if (state.position) {
      window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(state.position));
    }

    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      return;
    }

    try {
      await chrome.storage.local.set({ [UI_STORAGE_KEY]: state });
    } catch {
      // Local storage fallback above still keeps the UI usable.
    }
  }

  private constrainPanelWidth(width: number): number {
    return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));
  }

  private applyPanelWidth(): void {
    this.root?.style.setProperty("--gpt-reader-width", `${this.panelWidth}px`);
  }

  private readLegacyPanelPosition(): PanelPosition | null {
    const rawPosition = window.localStorage.getItem(POSITION_STORAGE_KEY);
    if (!rawPosition) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawPosition) as { left?: unknown; top?: unknown };
      const left = Number(parsed.left);
      const top = Number(parsed.top);
      if (!Number.isFinite(left) || !Number.isFinite(top)) {
        return null;
      }

      return this.constrainPanelPosition(left, top);
    } catch {
      return null;
    }
  }

  private applyPanelPosition(): void {
    if (!this.root || !this.panelPosition) {
      return;
    }

    this.root.style.setProperty("--gpt-reader-left", `${this.panelPosition.left}px`);
    this.root.style.setProperty("--gpt-reader-top", `${this.panelPosition.top}px`);
  }

  private constrainPanelPosition(left: number, top: number): PanelPosition {
    const width = this.panelWidth;
    const panelHeight = this.root?.querySelector<HTMLElement>(".gpt-reader-panel")?.offsetHeight ?? 420;
    const maxLeft = Math.max(0, window.innerWidth - Math.min(width, window.innerWidth) - 8);
    const maxTop = Math.max(0, window.innerHeight - Math.min(panelHeight, window.innerHeight) - 8);

    return {
      left: Math.min(maxLeft, Math.max(8, left)),
      top: Math.min(maxTop, Math.max(8, top))
    };
  }

  private startDrag(event: PointerEvent): void {
    if (!this.root) {
      return;
    }

    event.preventDefault();
    const rect = this.root.getBoundingClientRect();
    this.isDragging = true;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.dragStartLeft = rect.left;
    this.dragStartTop = rect.top;
    this.root.classList.add("is-dragging");
    window.addEventListener("pointermove", this.dragPanel);
    window.addEventListener("pointerup", this.stopDrag, { once: true });
  }

  private dragPanel = (event: PointerEvent): void => {
    if (!this.isDragging) {
      return;
    }

    this.panelPosition = this.constrainPanelPosition(
      this.dragStartLeft + event.clientX - this.dragStartX,
      this.dragStartTop + event.clientY - this.dragStartY
    );
    this.applyPanelPosition();
    this.positionActiveDot();
  };

  private stopDrag = (): void => {
    this.isDragging = false;
    this.root?.classList.remove("is-dragging");
    window.removeEventListener("pointermove", this.dragPanel);
    void this.savePanelUiState();
  };

  private startResize(event: PointerEvent): void {
    event.preventDefault();
    this.isResizing = true;
    this.resizeStartX = event.clientX;
    this.resizeStartWidth = this.panelWidth;
    this.root?.classList.add("is-resizing");
    window.addEventListener("pointermove", this.resizePanel);
    window.addEventListener("pointerup", this.stopResize, { once: true });
  }

  private resizePanel = (event: PointerEvent): void => {
    if (!this.isResizing) {
      return;
    }

    const nextWidth = this.resizeStartWidth + event.clientX - this.resizeStartX;
    this.panelWidth = this.constrainPanelWidth(nextWidth);
    if (this.panelPosition) {
      this.panelPosition = this.constrainPanelPosition(this.panelPosition.left, this.panelPosition.top);
      this.applyPanelPosition();
    }
    this.applyPanelWidth();
    this.positionActiveDot();
  };

  private stopResize = (): void => {
    this.isResizing = false;
    this.root?.classList.remove("is-resizing");
    window.removeEventListener("pointermove", this.resizePanel);
    void this.savePanelUiState();
  };
}

void new ChatGptReader().init();
