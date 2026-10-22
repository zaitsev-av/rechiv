import { applySavedTheme, watchThemeChanges } from "@shared/theme";
import tokenStyles from "@shared/theme-tokens.css?inline";
import type { LiveTranscriptResult } from "@shared/types";
import { plural } from "@shared/utils";
import { capabilitiesForHost } from "./platforms/registry";

const STORAGE_KEY = "liveTranscriptOverlayBounds";
const POLL_INTERVAL_MS = 2000;
const SAVE_DELAY_MS = 250;
const DEFAULT_HEIGHT = 520;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 280;
const MAX_WIDTH = 760;
const MAX_HEIGHT = 900;
const VIEWPORT_GAP = 12;
const FINISH_LABEL = "Завершить запись";
const FINISH_CONFIRM_LABEL = "Нажмите ещё раз";
const FINISH_ARM_MS = 4000;

export const LIVE_OVERLAY_SELECTOR = "[data-rechiv-live]";

interface OverlayBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

let activeOverlay: LiveTranscriptOverlay | null = null;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function parseBounds(value: unknown): OverlayBounds | null {
  if (!value || typeof value !== "object") return null;
  const bounds = value as Partial<OverlayBounds>;
  if (
    !isFiniteNumber(bounds.left) ||
    !isFiniteNumber(bounds.top) ||
    !isFiniteNumber(bounds.width) ||
    !isFiniteNumber(bounds.height) ||
    bounds.width < MIN_WIDTH ||
    bounds.height < MIN_HEIGHT ||
    bounds.width > MAX_WIDTH ||
    bounds.height > MAX_HEIGHT
  ) {
    return null;
  }
  return bounds as OverlayBounds;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

const overlayStyles = `
  :host {
    all: initial;
    color-scheme: light;
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 2147483647;
    display: block;
    width: min(420px, calc(100vw - 24px));
    height: min(520px, calc(100vh - 24px));
    min-width: min(320px, calc(100vw - 24px));
    min-height: min(280px, calc(100vh - 24px));
    max-width: calc(100vw - 16px);
    max-height: calc(100vh - 16px);
    overflow: hidden;
    box-sizing: border-box;
    resize: both;
    contain: layout style;
    font-family: var(--font-sans);
  }

  :host(.is-collapsed) {
    height: 58px !important;
    min-height: 58px;
    resize: none;
  }

  :host(.attention) .panel {
    animation: overlay-attention 480ms ease-out;
  }

  button:focus-visible {
    outline: 3px solid var(--accent-glow);
    outline-offset: 2px;
  }

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  button {
    font: inherit;
  }

  .panel {
    position: relative;
    display: flex;
    width: 100%;
    height: 100%;
    min-height: 0;
    overflow: hidden;
    color: var(--ink);
    background: var(--canvas);
    border: 1px solid var(--border);
    border-radius: 20px;
    box-shadow: var(--shadow-md);
    flex-direction: column;
    isolation: isolate;
  }

  .drag-header {
    position: relative;
    z-index: 3;
    display: flex;
    min-height: 58px;
    padding: 10px 10px 10px 12px;
    align-items: center;
    gap: 10px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    box-shadow: var(--shadow-sm);
    cursor: grab;
    user-select: none;
    -webkit-user-select: none;
  }

  .drag-header:active {
    cursor: grabbing;
  }

  .grip {
    display: grid;
    width: 16px;
    height: 26px;
    flex: 0 0 auto;
    grid-template-columns: repeat(2, 3px);
    align-content: center;
    justify-content: center;
    gap: 3px;
    opacity: 0.46;
  }

  .grip i {
    width: 3px;
    height: 3px;
    background: var(--muted);
    border-radius: 50%;
  }

  .heading {
    min-width: 0;
    flex: 1;
  }

  .eyebrow {
    display: flex;
    margin-bottom: 3px;
    align-items: center;
    gap: 7px;
    color: var(--muted);
    font-size: 8px;
    font-weight: 820;
    letter-spacing: 0.11em;
    line-height: 1;
    text-transform: uppercase;
  }

  .live-dot {
    width: 7px;
    height: 7px;
    background: var(--danger);
    border-radius: 50%;
    animation: live-pulse 1.35s ease-in-out infinite;
  }

  .title {
    overflow: hidden;
    color: var(--ink);
    font-size: 12px;
    font-weight: 790;
    letter-spacing: -0.01em;
    line-height: 1.15;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .duration {
    flex: 0 0 auto;
    color: var(--ink-soft);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: -0.03em;
  }

  .window-actions {
    display: flex;
    flex: 0 0 auto;
    gap: 5px;
  }

  .icon-button {
    display: grid;
    width: 29px;
    height: 29px;
    padding: 0;
    color: var(--muted);
    background: var(--surface-soft);
    border: 1px solid transparent;
    border-radius: 9px;
    cursor: pointer;
    place-items: center;
    transition:
      color 140ms ease,
      background 140ms ease,
      border-color 140ms ease;
  }

  .icon-button:hover {
    color: var(--ink-soft);
    background: var(--surface-raised);
    border-color: var(--border);
  }

  .icon-button.close:hover {
    color: var(--ink);
    background: var(--surface-raised);
    border-color: var(--border);
  }

  .collapse-icon {
    position: relative;
    display: block;
    width: 11px;
    height: 8px;
    border-bottom: 1.7px solid currentColor;
  }

  :host(.is-collapsed) .collapse-icon {
    border: 1.5px solid currentColor;
    border-radius: 2px;
  }

  .close-icon {
    font-size: 19px;
    font-weight: 350;
    line-height: 1;
    transform: translateY(-1px);
  }

  .summary {
    display: flex;
    min-height: 43px;
    padding: 8px 14px;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }

  .notice {
    padding: 8px 14px;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.45;
    background: var(--surface-soft);
    border-bottom: 1px solid var(--border);
  }

  .notice[hidden] {
    display: none;
  }

  .status {
    display: inline-flex;
    min-height: 23px;
    padding: 0 8px;
    align-items: center;
    gap: 6px;
    color: var(--danger);
    font-size: 8px;
    font-weight: 840;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    background: var(--danger-soft);
    border: 1px solid var(--border);
    border-radius: 999px;
  }

  .status::before {
    width: 6px;
    height: 6px;
    background: currentColor;
    border-radius: 50%;
    content: "";
  }

  .status.processing {
    color: var(--chip-text);
    background: var(--chip-bg);
    border-color: var(--border);
  }

  .status.completed {
    color: var(--chip-text);
    background: var(--chip-bg);
    border-color: var(--border);
  }

  .status.reconnecting,
  .status.error {
    color: var(--warning);
    background: var(--warning-soft);
    border-color: var(--border);
  }

  .meta {
    overflow: hidden;
    color: var(--muted);
    font-size: 9px;
    font-weight: 560;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .feed-wrap {
    position: relative;
    display: flex;
    min-height: 0;
    flex: 1;
  }

  .feed {
    min-height: 0;
    padding: 12px 12px 16px;
    overflow-x: hidden;
    overflow-y: auto;
    flex: 1;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    scrollbar-color: var(--border-strong) transparent;
  }

  .feed::-webkit-scrollbar {
    width: 8px;
  }

  .feed::-webkit-scrollbar-thumb {
    background: var(--border-strong);
    border: 2px solid transparent;
    border-radius: 999px;
    background-clip: padding-box;
  }

  .entry {
    position: relative;
    margin-bottom: 6px;
    padding: 8px 10px 9px 12px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 13px;
    box-shadow: var(--shadow-sm);
  }

  .entry-head {
    display: flex;
    margin-bottom: 5px;
    align-items: center;
    justify-content: space-between;
    gap: 9px;
  }

  .speaker {
    overflow: hidden;
    color: var(--ink);
    font-size: 9px;
    font-weight: 800;
    text-overflow: ellipsis;
    white-space: nowrap;
    position: relative;
    padding-left: 20px;
    min-height: 16px;
  }

  .speaker::before {
    position: absolute;
    top: 0;
    left: 0;
    width: 16px;
    height: 16px;
    background: var(--speaker-bg);
    border: 4px solid var(--speaker-fg);
    border-radius: 50%;
    content: "";
  }

  .time {
    flex: 0 0 auto;
    color: var(--muted-light);
    font-family: var(--font-mono);
    font-size: 7px;
    white-space: nowrap;
  }

  .text {
    margin: 0;
    color: var(--ink-soft);
    font-size: 12px;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }

  .entry.error {
    opacity: 0.68;
  }

  .tone-0 { --speaker-bg: var(--speaker-0-bg); --speaker-fg: var(--speaker-0-fg); }
  .tone-1 { --speaker-bg: var(--speaker-1-bg); --speaker-fg: var(--speaker-1-fg); }
  .tone-2 { --speaker-bg: var(--speaker-2-bg); --speaker-fg: var(--speaker-2-fg); }
  .tone-3 { --speaker-bg: var(--speaker-3-bg); --speaker-fg: var(--speaker-3-fg); }
  .tone-4 { --speaker-bg: var(--speaker-4-bg); --speaker-fg: var(--speaker-4-fg); }

  .empty {
    display: flex;
    min-height: 100%;
    padding: 28px;
    align-items: center;
    justify-content: center;
    gap: 11px;
    color: var(--muted);
    text-align: center;
    flex-direction: column;
  }

  .empty strong {
    color: var(--ink);
    font-size: 13px;
  }

  .empty p {
    max-width: 260px;
    margin: -4px 0 0;
    font-size: 10px;
    line-height: 1.5;
  }

  .wave {
    display: flex;
    height: 34px;
    align-items: center;
    gap: 4px;
  }

  .wave i {
    width: 4px;
    height: 10px;
    background: var(--muted);
    border-radius: 999px;
    animation: live-wave 1.1s ease-in-out infinite;
  }

  .wave i:nth-child(2) { animation-delay: 100ms; }
  .wave i:nth-child(3) { animation-delay: 200ms; }
  .wave i:nth-child(4) { animation-delay: 300ms; }
  .wave i:nth-child(5) { animation-delay: 400ms; }

  .latest {
    position: absolute;
    right: 14px;
    bottom: 12px;
    z-index: 4;
    display: inline-flex;
    min-height: 29px;
    padding: 0 10px;
    align-items: center;
    gap: 6px;
    color: var(--ink-soft);
    font-size: 8px;
    font-weight: 760;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: 999px;
    box-shadow: var(--shadow-sm);
    cursor: pointer;
  }

  .latest.hidden {
    display: none;
  }

  .footer {
    position: relative;
    z-index: 3;
    padding: 10px 12px 12px;
    background: var(--surface);
    border-top: 1px solid var(--border);
    box-shadow: var(--shadow-sm);
  }

  .progress-copy {
    display: flex;
    margin-bottom: 6px;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--muted);
    font-size: 9.5px;
    font-weight: 650;
  }

  .local-note {
    flex: 0 0 auto;
    color: var(--muted);
  }

  .progress-track {
    height: 3px;
    margin-bottom: 9px;
    overflow: hidden;
    background: var(--track);
    border-radius: 99px;
  }

  .progress-track[hidden] {
    display: none;
  }

  .progress-value {
    display: block;
    width: 0;
    height: 100%;
    background: var(--progress);
    border-radius: inherit;
    transition: width 260ms ease;
  }

  .footer-actions {
    display: flex;
    gap: 6px;
  }

  .action {
    display: flex;
    min-height: 33px;
    padding: 0 12px;
    align-items: center;
    justify-content: center;
    gap: 7px;
    flex: 1;
    font-size: 9px;
    font-weight: 770;
    border-radius: 10px;
    cursor: pointer;
    transition:
      color 140ms ease,
      background 140ms ease,
      border-color 140ms ease,
      transform 140ms ease;
  }

  .action:hover {
    transform: translateY(-1px);
  }

  .action[hidden] {
    display: none;
  }

  .open-full {
    color: var(--ink-soft);
    background: var(--surface-raised);
    border: 1px solid var(--border);
  }

  .open-full:hover {
    background: var(--surface-soft);
  }

  .finish {
    color: #fff;
    background: var(--danger);
    border: 1px solid var(--danger);
  }

  .finish:hover {
    background: var(--danger-deep);
    border-color: var(--danger-deep);
  }

  /* Промах по кнопке оборвал бы запись: подтверждение вторым нажатием. */
  .finish.armed {
    background: var(--danger-deep);
    border-color: var(--danger-deep);
  }

  .finish.armed:hover {
    background: var(--danger-deep);
  }

  :host(.is-collapsed) .summary,
  :host(.is-collapsed) .feed-wrap,
  :host(.is-collapsed) .footer {
    display: none;
  }

  :host(.is-collapsed) .drag-header {
    border-bottom: 0;
  }

  @keyframes live-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.55; transform: scale(0.78); }
  }

  @keyframes live-wave {
    0%, 100% { height: 10px; opacity: 0.58; }
    50% { height: 27px; opacity: 1; }
  }

  @keyframes overlay-attention {
    0% { transform: scale(0.98); box-shadow: var(--shadow-md); }
    55% { transform: scale(1.012); }
    100% { transform: scale(1); }
  }

  @media (prefers-reduced-motion: reduce) {
    .live-dot,
    .wave i,
    :host(.attention) .panel {
      animation: none;
    }
  }
`;

const overlayMarkup = `
  <style>${tokenStyles}
${overlayStyles}</style>
  <section class="panel" role="complementary" aria-label="Live-транскрипт созвона">
    <header class="drag-header" data-role="drag-handle" title="Перетащите панель">
      <span class="grip" aria-hidden="true">
        <i></i><i></i><i></i><i></i><i></i><i></i>
      </span>
      <div class="heading">
        <span class="eyebrow"><i class="live-dot"></i> Live-транскрипт</span>
        <div class="title">Транскрипт созвона</div>
      </div>
      <time class="duration" data-role="duration">00:00:00</time>
      <div class="window-actions">
        <button class="icon-button" data-role="collapse" type="button"
          aria-label="Свернуть панель" title="Свернуть">
          <span class="collapse-icon" aria-hidden="true"></span>
        </button>
        <button class="icon-button close" data-role="close" type="button"
          aria-label="Закрыть панель" title="Закрыть">
          <span class="close-icon" aria-hidden="true">×</span>
        </button>
      </div>
    </header>

    <div class="summary">
      <span class="status recording" data-role="status">Live</span>
      <span class="meta" data-role="meta">Подключаюсь к транскрибации…</span>
    </div>

    <p class="notice" data-role="notice" hidden></p>

    <div class="feed-wrap">
      <main class="feed" data-role="feed" aria-live="polite"></main>
      <button class="latest hidden" data-role="latest" type="button">
        К последней реплике <span aria-hidden="true">↓</span>
      </button>
    </div>

    <footer class="footer">
      <div class="progress-copy">
        <span data-role="progress-label">Ожидаю первый аудиофрагмент</span>
        <span class="local-note">локально</span>
      </div>
      <div class="progress-track" data-role="progress-track" aria-hidden="true">
        <span class="progress-value" data-role="progress-value"></span>
      </div>
      <div class="footer-actions">
        <button class="action finish" data-role="finish" type="button">
          Завершить запись
        </button>
        <button class="action open-full" data-role="open-full" type="button">
          Транскрипт <span aria-hidden="true">↗</span>
        </button>
      </div>
    </footer>
  </section>
`;

export class LiveTranscriptOverlay {
  readonly host: HTMLDivElement;

  private readonly shadow: ShadowRoot;
  private readonly dragHandle: HTMLElement;
  private readonly duration: HTMLElement;
  private readonly status: HTMLElement;
  private readonly meta: HTMLElement;
  private readonly notice: HTMLElement;
  private readonly mixedAudioPlatform: boolean;
  private readonly feed: HTMLElement;
  private readonly latestButton: HTMLButtonElement;
  private readonly progressLabel: HTMLElement;
  private readonly progressValue: HTMLElement;
  private readonly progressTrack: HTMLElement;
  private readonly collapseButton: HTMLButtonElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly openFullButton: HTMLButtonElement;
  private readonly finishButton: HTMLButtonElement;
  private readonly speakerTones = new Map<string, number>();

  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private armTimer: ReturnType<typeof setTimeout> | null = null;
  private finishing = false;
  private resizeObserver: ResizeObserver | null = null;
  private stopThemeWatcher: (() => void) | null = null;
  private destroyed = false;
  private collapsed = false;
  private interacted = false;
  private movedBefore = false;
  private expandedHeight = DEFAULT_HEIGHT;
  private lastSegmentsFingerprint = "";
  private dragOffsetX = 0;
  private dragOffsetY = 0;

  constructor(
    readonly sessionId: string,
    private readonly onDestroy?: () => void,
  ) {
    this.host = document.createElement("div");
    this.host.dataset.rechivLive = "";
    this.host.setAttribute("aria-label", "Live-транскрипт созвона");
    this.shadow = this.host.attachShadow({ mode: "open" });
    this.shadow.innerHTML = overlayMarkup;

    this.dragHandle = this.getElement("[data-role='drag-handle']");
    this.duration = this.getElement("[data-role='duration']");
    this.status = this.getElement("[data-role='status']");
    this.meta = this.getElement("[data-role='meta']");
    this.notice = this.getElement("[data-role='notice']");
    this.mixedAudioPlatform = capabilitiesForHost(location.host).audio === "mixed";
    this.feed = this.getElement("[data-role='feed']");
    this.latestButton = this.getElement("[data-role='latest']");
    this.progressLabel = this.getElement("[data-role='progress-label']");
    this.progressValue = this.getElement("[data-role='progress-value']");
    this.progressTrack = this.getElement("[data-role='progress-track']");
    this.collapseButton = this.getElement("[data-role='collapse']");
    this.closeButton = this.getElement("[data-role='close']");
    this.openFullButton = this.getElement("[data-role='open-full']");
    this.finishButton = this.getElement("[data-role='finish']");
  }

  mount(): void {
    this.reparentForFullscreen();
    this.renderEmpty(false);
    void applySavedTheme(this.host);
    this.stopThemeWatcher = watchThemeChanges(this.host);

    this.dragHandle.addEventListener("pointerdown", this.handlePointerDown);
    this.collapseButton.addEventListener("click", this.toggleCollapsed);
    this.closeButton.addEventListener("click", this.destroy);
    this.openFullButton.addEventListener("click", this.openFullTranscript);
    this.finishButton.addEventListener("click", this.handleFinishClick);
    this.finishButton.addEventListener("blur", this.disarmFinish);
    this.latestButton.addEventListener("click", this.scrollToLatest);
    this.feed.addEventListener("scroll", this.handleFeedScroll);
    this.feed.addEventListener("wheel", this.handleFeedWheel, { passive: false });
    document.addEventListener("fullscreenchange", this.handleFullscreenChange);
    window.addEventListener("resize", this.handleViewportResize);

    void this.restoreBounds().finally(() => {
      if (!this.destroyed) this.startResizeObserver();
    });
    void this.poll();
  }

  reveal(): void {
    this.reparentForFullscreen();
    if (this.collapsed) this.toggleCollapsed();
    this.host.classList.remove("attention");
    requestAnimationFrame(() => {
      if (this.destroyed) return;
      this.host.classList.add("attention");
      window.setTimeout(() => this.host.classList.remove("attention"), 520);
    });
  }

  destroy = (): void => {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    if (this.armTimer !== null) clearTimeout(this.armTimer);
    this.resizeObserver?.disconnect();
    this.stopThemeWatcher?.();
    this.dragHandle.removeEventListener("pointerdown", this.handlePointerDown);
    this.collapseButton.removeEventListener("click", this.toggleCollapsed);
    this.closeButton.removeEventListener("click", this.destroy);
    this.openFullButton.removeEventListener("click", this.openFullTranscript);
    this.finishButton.removeEventListener("click", this.handleFinishClick);
    this.finishButton.removeEventListener("blur", this.disarmFinish);
    this.latestButton.removeEventListener("click", this.scrollToLatest);
    this.feed.removeEventListener("scroll", this.handleFeedScroll);
    this.feed.removeEventListener("wheel", this.handleFeedWheel);
    document.removeEventListener("fullscreenchange", this.handleFullscreenChange);
    window.removeEventListener("resize", this.handleViewportResize);
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    this.host.remove();
    this.onDestroy?.();
  };

  private getElement<T extends Element>(selector: string): T {
    const element = this.shadow.querySelector<T>(selector);
    if (!element) throw new Error(`Live overlay element is missing: ${selector}`);
    return element;
  }

  private reparentForFullscreen(): void {
    const parent = document.fullscreenElement ?? document.documentElement;
    if (this.host.parentElement !== parent) parent.appendChild(this.host);
  }

  private handleFullscreenChange = (): void => {
    this.reparentForFullscreen();
    requestAnimationFrame(() => this.clampToViewport());
  };

  private handleViewportResize = (): void => {
    this.clampToViewport();
    this.scheduleSave();
  };

  private handlePointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    if ((event.target as Element | null)?.closest("button")) return;
    const rect = this.host.getBoundingClientRect();
    this.interacted = true;
    this.dragOffsetX = event.clientX - rect.left;
    this.dragOffsetY = event.clientY - rect.top;
    this.host.style.left = `${rect.left}px`;
    this.host.style.top = `${rect.top}px`;
    this.host.style.right = "auto";
    this.host.style.bottom = "auto";
    this.dragHandle.setPointerCapture?.(event.pointerId);
    window.addEventListener("pointermove", this.handlePointerMove);
    window.addEventListener("pointerup", this.handlePointerUp);
    event.preventDefault();
  };

  private handlePointerMove = (event: PointerEvent): void => {
    const rect = this.host.getBoundingClientRect();
    const maxLeft = window.innerWidth - rect.width - VIEWPORT_GAP;
    const maxTop = window.innerHeight - rect.height - VIEWPORT_GAP;
    const left = clamp(event.clientX - this.dragOffsetX, VIEWPORT_GAP, maxLeft);
    const top = clamp(event.clientY - this.dragOffsetY, VIEWPORT_GAP, maxTop);
    this.host.style.left = `${Math.round(left)}px`;
    this.host.style.top = `${Math.round(top)}px`;
  };

  private handlePointerUp = (event: PointerEvent): void => {
    this.dragHandle.releasePointerCapture?.(event.pointerId);
    window.removeEventListener("pointermove", this.handlePointerMove);
    window.removeEventListener("pointerup", this.handlePointerUp);
    this.clampToViewport();
    this.scheduleSave();
  };

  private toggleCollapsed = (): void => {
    if (!this.collapsed) {
      const height = this.host.getBoundingClientRect().height;
      if (height >= MIN_HEIGHT) this.expandedHeight = height;
      this.collapsed = true;
      this.host.classList.add("is-collapsed");
      this.collapseButton.setAttribute("aria-label", "Развернуть панель");
      this.collapseButton.title = "Развернуть";
    } else {
      this.collapsed = false;
      this.host.classList.remove("is-collapsed");
      this.host.style.height = `${this.expandedHeight}px`;
      this.collapseButton.setAttribute("aria-label", "Свернуть панель");
      this.collapseButton.title = "Свернуть";
      this.clampToViewport();
    }
    this.scheduleSave();
  };

  private openFullTranscript = (): void => {
    void chrome.runtime.sendMessage({
      action: "openTranscript",
      sessionId: this.sessionId,
    });
  };

  private armFinish(): void {
    this.finishButton.classList.add("armed");
    this.finishButton.textContent = FINISH_CONFIRM_LABEL;
    if (this.armTimer !== null) clearTimeout(this.armTimer);
    this.armTimer = setTimeout(this.disarmFinish, FINISH_ARM_MS);
  }

  private disarmFinish = (): void => {
    if (this.armTimer !== null) {
      clearTimeout(this.armTimer);
      this.armTimer = null;
    }
    if (this.finishing) return;
    this.finishButton.classList.remove("armed");
    this.finishButton.textContent = FINISH_LABEL;
  };

  private handleFinishClick = async (): Promise<void> => {
    if (this.finishing) return;
    if (!this.finishButton.classList.contains("armed")) {
      this.armFinish();
      return;
    }

    this.finishing = true;
    this.disarmFinish();
    this.finishButton.classList.remove("armed");
    this.finishButton.disabled = true;
    this.finishButton.textContent = "Завершаю…";
    this.setStatus("processing", "Завершаю");

    try {
      const response = (await chrome.runtime.sendMessage({ action: "stopRecording" })) as
        | { ok?: boolean; error?: string }
        | undefined;
      if (response?.ok) return;
      throw new Error(response?.error ?? "фоновый процесс не ответил");
    } catch (error) {
      if (this.destroyed) return;
      this.finishing = false;
      this.finishButton.disabled = false;
      this.finishButton.textContent = FINISH_LABEL;
      this.setStatus("error", "Ошибка");
      this.meta.textContent = `Не удалось завершить запись: ${
        error instanceof Error ? error.message : "неизвестная ошибка"
      }`;
    }
  };

  private handleFeedScroll = (): void => {
    this.latestButton.classList.toggle("hidden", this.isNearBottom());
  };

  private isNearBottom(): boolean {
    return this.feed.scrollHeight - this.feed.scrollTop - this.feed.clientHeight < 80;
  }

  /** Страница созвона может отменять колёсико у всего документа — прокручиваем ленту сами. */
  private handleFeedWheel = (event: WheelEvent): void => {
    const lineHeight = 16;
    const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? lineHeight : 1;
    this.feed.scrollTop += event.deltaY * scale;
    event.preventDefault();
    event.stopPropagation();
  };

  private scrollToLatest = (): void => {
    this.feed.scrollTop = this.feed.scrollHeight;
    this.latestButton.classList.add("hidden");
  };

  private getSpeakerTone(speakerId: string): number {
    const current = this.speakerTones.get(speakerId);
    if (current !== undefined) return current;
    const tone = this.speakerTones.size % 5;
    this.speakerTones.set(speakerId, tone);
    return tone;
  }

  private renderEmpty(hasChunks: boolean): void {
    this.feed.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "empty";

    const wave = document.createElement("span");
    wave.className = "wave";
    wave.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 5; i++) wave.appendChild(document.createElement("i"));

    const title = document.createElement("strong");
    title.textContent = hasChunks ? "Распознаю первые реплики" : "Слушаю созвон";
    const description = document.createElement("p");
    description.textContent = hasChunks
      ? "Аудиофрагмент уже получен и обрабатывается локально."
      : "Первые реплики появятся примерно через 20 секунд.";
    empty.append(wave, title, description);
    this.feed.appendChild(empty);
  }

  private renderSegments(live: LiveTranscriptResult): void {
    const fingerprint = JSON.stringify([
      live.totalChunks,
      live.segments.map((segment) => [
        segment.speakerId,
        segment.speaker,
        segment.start,
        segment.end,
        segment.text,
        segment.error,
      ]),
    ]);
    if (fingerprint === this.lastSegmentsFingerprint) return;
    this.lastSegmentsFingerprint = fingerprint;
    const shouldFollow = this.isNearBottom();
    this.feed.replaceChildren();

    if (live.segments.length === 0) {
      this.renderEmpty(live.totalChunks > 0);
      return;
    }

    for (const segment of live.segments) {
      const entry = document.createElement("article");
      entry.className = `entry tone-${this.getSpeakerTone(segment.speakerId)}${
        segment.error ? " error" : ""
      }`;

      const head = document.createElement("div");
      head.className = "entry-head";
      const speaker = document.createElement("span");
      speaker.className = "speaker";
      speaker.textContent = segment.speaker;
      const time = document.createElement("time");
      time.className = "time";
      time.textContent = `${segment.start} – ${segment.end}`;
      head.append(speaker, time);

      const text = document.createElement("p");
      text.className = "text";
      text.textContent = segment.text || "Не удалось распознать этот фрагмент";
      entry.append(head, text);
      this.feed.appendChild(entry);
    }

    if (shouldFollow) {
      requestAnimationFrame(this.scrollToLatest);
    } else {
      this.latestButton.classList.remove("hidden");
    }
  }

  private setStatus(
    state: "recording" | "processing" | "completed" | "reconnecting" | "error",
    label: string,
  ): void {
    this.status.className = `status ${state}`;
    this.status.textContent = label;
  }

  /** В Телемосте имена приходят с разметкой речи с задержкой — без пояснения «Неизвестный участник» выглядит поломкой. */
  private renderNotice(live: LiveTranscriptResult): void {
    const recording = !live.isFinal && live.status === "recording";
    const show = this.mixedAudioPlatform && recording && live.participants.length > 1;
    this.notice.hidden = !show;
    if (show && !this.notice.textContent) {
      this.notice.textContent =
        "Телемост отдаёт собеседников общим потоком: имя подставляется по разметке речи, " +
        "она приходит раз в 30 секунд, поэтому последние реплики подписываются с задержкой.";
    }
  }

  private render(live: LiveTranscriptResult): void {
    this.duration.textContent = live.duration || "00:00:00";
    const participants = live.participants.length;

    const hint = this.movedBefore || this.interacted ? "" : " · панель можно двигать";
    this.meta.textContent = `${participants} ${plural(
      participants,
      "участник",
      "участника",
      "участников",
    )}${hint}`;

    this.renderNotice(live);

    const replicas = live.segments.length;
    if (live.status === "processing" && !live.isFinal) {
      const percent =
        live.totalChunks > 0
          ? Math.min(100, Math.round((live.processedChunks / live.totalChunks) * 100))
          : 0;
      this.progressLabel.textContent = `Завершаю обработку · ${percent}%`;
      this.progressValue.style.width = `${percent}%`;
      this.progressTrack.hidden = false;
    } else {
      this.progressLabel.textContent =
        replicas > 0
          ? `${replicas} ${plural(replicas, "реплика", "реплики", "реплик")}`
          : "Жду первую реплику";
      this.progressTrack.hidden = true;
    }

    const recording = !live.isFinal && live.status === "recording";
    this.finishButton.hidden = !recording;
    if (!recording) this.disarmFinish();

    if (live.isFinal) {
      this.setStatus("completed", "Готово");
    } else if (live.status === "processing") {
      this.setStatus("processing", "Завершаю");
    } else if (live.status === "error") {
      this.setStatus("error", "Есть ошибки");
    } else {
      this.setStatus("recording", "Live");
    }
    this.renderSegments(live);
  }

  private async poll(): Promise<void> {
    if (this.destroyed) return;
    try {
      const response = (await chrome.runtime.sendMessage({
        action: "getLiveTranscript",
        sessionId: this.sessionId,
      })) as { ok?: boolean; live?: LiveTranscriptResult; error?: string } | undefined;
      if (!response?.ok || !response.live) {
        throw new Error(response?.error ?? "Фоновый процесс не вернул live-транскрипт");
      }
      if (this.destroyed) return;
      this.render(response.live);
      if (response.live.isFinal) return;
    } catch (error) {
      if (this.destroyed) return;
      console.warn("[Rechiv:live]", "live transcript update failed:", error);
      this.setStatus("reconnecting", "Переподключаюсь");
      this.meta.textContent = "Нет связи с фоновым процессом расширения";
    }
    this.pollTimer = setTimeout(() => void this.poll(), POLL_INTERVAL_MS);
  }

  private async restoreBounds(): Promise<void> {
    try {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      if (this.destroyed || this.interacted) return;
      const bounds = parseBounds(stored[STORAGE_KEY]);
      if (!bounds) return;
      this.movedBefore = true;

      const maxWidth = Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_GAP * 2);
      const maxHeight = Math.max(MIN_HEIGHT, window.innerHeight - VIEWPORT_GAP * 2);
      const width = clamp(bounds.width, MIN_WIDTH, Math.min(MAX_WIDTH, maxWidth));
      const height = clamp(bounds.height, MIN_HEIGHT, Math.min(MAX_HEIGHT, maxHeight));

      this.expandedHeight = height;
      this.host.style.width = `${Math.round(width)}px`;
      this.host.style.height = `${Math.round(height)}px`;
      this.host.style.left = `${Math.round(
        clamp(bounds.left, VIEWPORT_GAP, window.innerWidth - width - VIEWPORT_GAP),
      )}px`;
      this.host.style.top = `${Math.round(
        clamp(bounds.top, VIEWPORT_GAP, window.innerHeight - height - VIEWPORT_GAP),
      )}px`;
      this.host.style.right = "auto";
    } catch {
      // Останется позиция по умолчанию.
    }
  }

  private startResizeObserver(): void {
    if (typeof ResizeObserver === "undefined") return;
    this.resizeObserver = new ResizeObserver(() => {
      if (this.collapsed || this.destroyed) return;
      this.interacted = true;
      const height = this.host.getBoundingClientRect().height;
      if (height >= MIN_HEIGHT) this.expandedHeight = height;
      this.clampToViewport();
      this.scheduleSave();
    });
    this.resizeObserver.observe(this.host);
  }

  private clampToViewport(): void {
    if (!this.host.isConnected) return;
    const rect = this.host.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const width = Math.min(rect.width, Math.max(MIN_WIDTH, window.innerWidth - VIEWPORT_GAP * 2));
    const height = Math.min(
      rect.height,
      Math.max(this.collapsed ? 58 : MIN_HEIGHT, window.innerHeight - VIEWPORT_GAP * 2),
    );
    if (width !== rect.width) this.host.style.width = `${Math.round(width)}px`;
    if (height !== rect.height) this.host.style.height = `${Math.round(height)}px`;

    const currentLeft = rect.left;
    const currentTop = rect.top;
    const left = clamp(currentLeft, VIEWPORT_GAP, window.innerWidth - width - VIEWPORT_GAP);
    const top = clamp(currentTop, VIEWPORT_GAP, window.innerHeight - height - VIEWPORT_GAP);
    if (left !== currentLeft || this.host.style.right !== "auto") {
      this.host.style.left = `${Math.round(left)}px`;
      this.host.style.right = "auto";
    }
    if (top !== currentTop) this.host.style.top = `${Math.round(top)}px`;
  }

  private scheduleSave(): void {
    if (this.collapsed || this.destroyed) return;
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      const rect = this.host.getBoundingClientRect();
      if (rect.width < MIN_WIDTH || rect.height < MIN_HEIGHT) return;
      void chrome.storage.local.set({
        [STORAGE_KEY]: {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        } satisfies OverlayBounds,
      });
    }, SAVE_DELAY_MS);
  }
}

export function showLiveTranscriptOverlay(sessionId: string): LiveTranscriptOverlay {
  if (activeOverlay?.sessionId === sessionId && activeOverlay.host.isConnected) {
    activeOverlay.reveal();
    return activeOverlay;
  }
  activeOverlay?.destroy();
  const overlay = new LiveTranscriptOverlay(sessionId, () => {
    if (activeOverlay === overlay) activeOverlay = null;
  });
  activeOverlay = overlay;
  overlay.mount();
  return overlay;
}

export function destroyLiveTranscriptOverlay(): void {
  activeOverlay?.destroy();
  activeOverlay = null;
}
