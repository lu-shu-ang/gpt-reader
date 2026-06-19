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
const MESSAGE_SELECTOR =
  "[data-message-author-role='user'],[data-message-author-role='assistant']";
const TURN_SELECTOR = "[data-testid^='conversation-turn-'],article";
const HIDDEN_ROUND_ATTR = "data-gpt-reader-hidden-round";
const ROUND_LIMIT_BANNER_ID = "gpt-reader-round-limit-banner";
const WIDTH_STORAGE_KEY = "gptReaderPanelWidth";
const POSITION_STORAGE_KEY = "gptReaderPanelPosition";
const HEIGHT_STORAGE_KEY = "gptReaderPanelHeight";
const UI_STORAGE_KEY = "gptReaderUiState";
const DEFAULT_PANEL_WIDTH = 296;
const MIN_PANEL_WIDTH = 260;
const MAX_PANEL_WIDTH = 440;
const DEFAULT_PANEL_HEIGHT = 680;
const MIN_PANEL_HEIGHT = 320;
const SCAN_DEBOUNCE_MS = 120;
const ACTIVE_ANCHOR_RATIO = 0.48;
const CLICK_SCROLL_SYNC_PAUSE_MS = 650;
const TOC_FOLLOW_MARGIN_RATIO = 0.22;
const TOC_FOLLOW_TARGET_RATIO = 0.44;

type PanelPosition = {
  left: number;
  top: number;
};

type PanelUiState = {
  width?: number;
  height?: number;
  position?: PanelPosition | null;
};

type ConversationRound = {
  containers: HTMLElement[];
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
  private hiddenRoundContainers = new Set<HTMLElement>();
  private pageScrollContainers = new Set<HTMLElement>();
  private expandedAnswerIds = new Set<string>();
  private collapsedAnswerIds = new Set<string>();
  private currentHeadingId: string | null = null;
  private currentAnswerId: string | null = null;
  private mutationObserver: MutationObserver | null = null;
  private scanTimer: number | null = null;
  private activeFrame: number | null = null;
  private panelWidth = DEFAULT_PANEL_WIDTH;
  private panelHeight = DEFAULT_PANEL_HEIGHT;
  private panelPosition: PanelPosition | null = null;
  private resizeStartX = 0;
  private resizeStartWidth = DEFAULT_PANEL_WIDTH;
  private resizeStartY = 0;
  private resizeStartHeight = DEFAULT_PANEL_HEIGHT;
  private dragStartX = 0;
  private dragStartY = 0;
  private dragStartLeft = 0;
  private dragStartTop = 0;
  private isResizing = false;
  private isResizingHeight = false;
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
      this.applyPanelHeight();
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
          <label class="gpt-reader-field">
            <span>保留最近问答轮数</span>
            <input type="number" min="0" max="50" step="1" data-gpt-reader-max-rounds />
            <p>0 表示不限制；长会话建议 3-5 轮。</p>
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
        <div class="gpt-reader-resize-height-handle" data-gpt-reader-resize-height title="拖拽调整目录高度" aria-hidden="true"></div>
      </section>
      <button type="button" class="gpt-reader-float" data-gpt-reader-float>目录</button>
    `;

    document.body.append(root);
    this.root = root;
    this.list = root.querySelector<HTMLElement>("[data-gpt-reader-list]");
    this.activeDot = root.querySelector<HTMLElement>("[data-gpt-reader-active-dot]");
    this.applyPanelWidth();
    this.applyPanelHeight();
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

      if (target.closest("[data-gpt-reader-resize-height]")) {
        this.startHeightResize(event);
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
        this.scrollToHeading(
          headingButton.dataset.gptReaderHeading,
          headingButton.dataset.gptReaderAnswerId
        );
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

      if (target.matches("[data-gpt-reader-max-rounds]")) {
        void this.updateSettings({ maxVisibleRounds: this.parseRoundLimit(target.value) });
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
      this.scan();
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
    this.applyRoundLimit();
    const answerElements = Array.from(document.querySelectorAll<HTMLElement>(ASSISTANT_SELECTOR)).filter(
      (element) => !element.closest(`[${HIDDEN_ROUND_ATTR}="true"]`)
    );
    this.refreshPageScrollListeners(answerElements);
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

  private refreshPageScrollListeners(answerElements: HTMLElement[]): void {
    const nextContainers = new Set<HTMLElement>();

    for (const answerElement of answerElements) {
      let current = answerElement.parentElement;
      while (current && current !== document.body) {
        if (this.isPageScrollContainer(current)) {
          nextContainers.add(current);
        }

        current = current.parentElement;
      }
    }

    for (const container of this.pageScrollContainers) {
      if (!nextContainers.has(container)) {
        container.removeEventListener("scroll", this.queueActiveUpdate);
      }
    }

    for (const container of nextContainers) {
      if (!this.pageScrollContainers.has(container)) {
        container.addEventListener("scroll", this.queueActiveUpdate, { passive: true });
      }
    }

    this.pageScrollContainers = nextContainers;
  }

  private isPageScrollContainer(element: HTMLElement): boolean {
    if (this.root?.contains(element)) {
      return false;
    }

    const style = getComputedStyle(element);
    if (!/(auto|scroll|overlay)/.test(style.overflowY)) {
      return false;
    }

    return element.scrollHeight > element.clientHeight + 20;
  }

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

    this.keepActiveHeadingInView();
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

    const maxRoundsInput = this.root.querySelector<HTMLInputElement>(
      "[data-gpt-reader-max-rounds]"
    );
    if (maxRoundsInput) {
      maxRoundsInput.value = String(this.settings.maxVisibleRounds);
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
        button.dataset.gptReaderAnswerId = heading.answerId;
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
    this.keepActiveHeadingInView();
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

    this.keepActiveHeadingInView();
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
    const top = Math.min(
      Math.max(6, this.list.clientHeight - 6),
      Math.max(6, activeRect.top - listRect.top + activeRect.height / 2)
    );
    this.activeDot.style.opacity = "1";
    this.activeDot.style.transform = `translateY(${top}px)`;
  }

  private keepActiveHeadingInView(): void {
    if (!this.list) {
      return;
    }

    const activeItem = this.getActiveListItem();
    if (!activeItem) {
      return;
    }

    const listRect = this.list.getBoundingClientRect();
    const activeRect = activeItem.getBoundingClientRect();
    const activeCenter = activeRect.top - listRect.top + activeRect.height / 2;
    const topGuard = this.list.clientHeight * TOC_FOLLOW_MARGIN_RATIO;
    const bottomGuard = this.list.clientHeight * (1 - TOC_FOLLOW_MARGIN_RATIO);

    if (activeCenter >= topGuard && activeCenter <= bottomGuard) {
      window.requestAnimationFrame(() => this.positionActiveDot());
      return;
    }

    const maxScrollTop = Math.max(0, this.list.scrollHeight - this.list.clientHeight);
    const targetOffset = this.list.clientHeight * TOC_FOLLOW_TARGET_RATIO;
    const nextScrollTop = Math.min(
      maxScrollTop,
      Math.max(0, this.list.scrollTop + activeCenter - targetOffset)
    );

    if (Math.abs(nextScrollTop - this.list.scrollTop) > 0.5) {
      this.list.scrollTop = nextScrollTop;
    }

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

  private scrollToHeading(headingId: string | undefined, answerId: string | undefined): void {
    if (!headingId) {
      return;
    }

    const heading = this.allHeadings.find(
      (item) => item.id === headingId && (!answerId || item.answerId === answerId)
    );
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
    this.scan();
    await saveSettings(this.settings);
  }

  private parseRoundLimit(value: string): number {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      return 0;
    }

    return Math.min(50, Math.max(0, Math.trunc(parsed)));
  }

  private applyRoundLimit(): void {
    this.restoreHiddenRounds();

    if (!this.settings.enabled || this.settings.maxVisibleRounds <= 0) {
      this.removeRoundLimitBanner();
      return;
    }

    const rounds = this.getConversationRounds();
    if (rounds.length <= this.settings.maxVisibleRounds) {
      this.removeRoundLimitBanner();
      return;
    }

    const hiddenRounds = rounds.slice(0, -this.settings.maxVisibleRounds);
    const visibleRounds = rounds.slice(-this.settings.maxVisibleRounds);
    const firstVisibleContainer = visibleRounds[0]?.containers[0];

    for (const round of hiddenRounds) {
      for (const container of round.containers) {
        this.hideRoundContainer(container);
      }
    }

    this.hidePreviousSiblingsBefore(firstVisibleContainer);
    this.insertRoundLimitBanner(firstVisibleContainer);
  }

  private hidePreviousSiblingsBefore(anchor: HTMLElement | undefined): void {
    if (!anchor?.parentElement) {
      return;
    }

    let sibling = anchor.previousElementSibling as HTMLElement | null;
    while (sibling) {
      const previousSibling = sibling.previousElementSibling as HTMLElement | null;
      this.hideRoundContainer(sibling);
      sibling = previousSibling;
    }
  }

  private hideRoundContainer(container: HTMLElement): void {
    if (
      container.id === ROOT_ID ||
      container.id === ROUND_LIMIT_BANNER_ID ||
      this.root?.contains(container) ||
      this.hiddenRoundContainers.has(container)
    ) {
      return;
    }

    container.dataset.gptReaderPreviousDisplay = container.style.getPropertyValue("display");
    container.dataset.gptReaderPreviousDisplayPriority =
      container.style.getPropertyPriority("display");
    container.setAttribute(HIDDEN_ROUND_ATTR, "true");
    container.style.setProperty("display", "none", "important");
    this.hiddenRoundContainers.add(container);
  }

  private restoreHiddenRounds(): void {
    for (const container of this.hiddenRoundContainers) {
      const previousDisplay = container.dataset.gptReaderPreviousDisplay ?? "";
      const previousPriority = container.dataset.gptReaderPreviousDisplayPriority ?? "";
      container.style.setProperty("display", previousDisplay, previousPriority);
      delete container.dataset.gptReaderPreviousDisplay;
      delete container.dataset.gptReaderPreviousDisplayPriority;
      container.removeAttribute(HIDDEN_ROUND_ATTR);
    }

    this.hiddenRoundContainers.clear();
  }

  private getConversationRounds(): ConversationRound[] {
    const rounds: ConversationRound[] = [];
    let currentRound: ConversationRound | null = null;

    const messages = Array.from(document.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR));
    for (const message of messages) {
      if (this.root?.contains(message)) {
        continue;
      }

      const role = message.dataset.messageAuthorRole;
      const container = this.getMessageContainer(message);
      if (!container || container.id === ROUND_LIMIT_BANNER_ID) {
        continue;
      }

      if (role === "user" || !currentRound) {
        currentRound = { containers: [] };
        rounds.push(currentRound);
      }

      if (!currentRound.containers.includes(container)) {
        currentRound.containers.push(container);
      }
    }

    return rounds.filter((round) => round.containers.length > 0);
  }

  private getMessageContainer(message: HTMLElement): HTMLElement {
    return message.closest<HTMLElement>(TURN_SELECTOR) ?? message;
  }

  private insertRoundLimitBanner(anchor: HTMLElement | undefined): void {
    if (!anchor?.parentElement) {
      this.removeRoundLimitBanner();
      return;
    }

    const banner = this.getOrCreateRoundLimitBanner();
    if (banner.parentElement !== anchor.parentElement || banner.nextElementSibling !== anchor) {
      anchor.parentElement.insertBefore(banner, anchor);
    }
  }

  private getOrCreateRoundLimitBanner(): HTMLElement {
    const existing = document.getElementById(ROUND_LIMIT_BANNER_ID);
    if (existing) {
      return existing;
    }

    const banner = document.createElement("div");
    banner.id = ROUND_LIMIT_BANNER_ID;
    banner.textContent = "旧消息已从当前视图隐藏，调为 0 可恢复显示";
    return banner;
  }

  private removeRoundLimitBanner(): void {
    document.getElementById(ROUND_LIMIT_BANNER_ID)?.remove();
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
    const visibleHeadings = this.focusHeadings.filter((heading) =>
      this.isHeadingRenderable(heading.element)
    );
    if (visibleHeadings.length === 0) {
      return null;
    }

    const anchorY = Math.round(window.innerHeight * ACTIVE_ANCHOR_RATIO);
    let activeHeading = visibleHeadings[0];

    for (const heading of visibleHeadings) {
      if (heading.element.getBoundingClientRect().top <= anchorY) {
        activeHeading = heading;
      } else {
        break;
      }
    }

    return activeHeading;
  }

  private isHeadingRenderable(element: HTMLElement): boolean {
    if (!element.isConnected || element.closest(`[${HIDDEN_ROUND_ATTR}="true"]`)) {
      return false;
    }

    const rects = element.getClientRects();
    if (rects.length === 0) {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  private async loadPanelUiState(): Promise<void> {
    const storedState = await this.readStoredPanelUiState();
    const legacyWidth = this.readStoredNumber(window.localStorage.getItem(WIDTH_STORAGE_KEY));
    const legacyHeight = this.readStoredNumber(window.localStorage.getItem(HEIGHT_STORAGE_KEY));
    const legacyPosition = this.readLegacyPanelPosition();
    const width = this.readStoredNumber(storedState.width) ?? legacyWidth;
    const height = this.readStoredNumber(storedState.height) ?? legacyHeight;

    if (width !== undefined) {
      this.panelWidth = this.constrainPanelWidth(width);
    }

    this.panelPosition = storedState.position ?? legacyPosition;

    if (height !== undefined) {
      this.panelHeight = this.constrainPanelHeight(height);
    }
  }

  private readStoredNumber(value: unknown): number | undefined {
    if (value === null || value === undefined || value === "") {
      return undefined;
    }

    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : undefined;
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
      height: Math.round(this.panelHeight),
      position: this.panelPosition
    };

    window.localStorage.setItem(WIDTH_STORAGE_KEY, String(state.width));
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(state.height));
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

  private constrainPanelHeight(height: number): number {
    const top = this.panelPosition?.top ?? this.root?.getBoundingClientRect().top ?? 82;
    const maxHeight = Math.max(MIN_PANEL_HEIGHT, window.innerHeight - top - 8);
    return Math.min(maxHeight, Math.max(MIN_PANEL_HEIGHT, height));
  }

  private applyPanelHeight(): void {
    this.root?.style.setProperty("--gpt-reader-height", `${this.panelHeight}px`);
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
    this.panelHeight = this.constrainPanelHeight(this.panelHeight);
    this.applyPanelHeight();
  }

  private constrainPanelPosition(left: number, top: number): PanelPosition {
    const width = this.panelWidth;
    const panelHeight = this.panelHeight;
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

  private startHeightResize(event: PointerEvent): void {
    event.preventDefault();
    this.isResizingHeight = true;
    this.resizeStartY = event.clientY;
    this.resizeStartHeight = this.panelHeight;
    this.root?.classList.add("is-resizing-height");
    window.addEventListener("pointermove", this.resizePanelHeight);
    window.addEventListener("pointerup", this.stopHeightResize, { once: true });
  }

  private resizePanelHeight = (event: PointerEvent): void => {
    if (!this.isResizingHeight) {
      return;
    }

    const nextHeight = this.resizeStartHeight + event.clientY - this.resizeStartY;
    this.panelHeight = this.constrainPanelHeight(nextHeight);
    this.applyPanelHeight();
    this.positionActiveDot();
  };

  private stopHeightResize = (): void => {
    this.isResizingHeight = false;
    this.root?.classList.remove("is-resizing-height");
    window.removeEventListener("pointermove", this.resizePanelHeight);
    void this.savePanelUiState();
  };
}

void new ChatGptReader().init();
