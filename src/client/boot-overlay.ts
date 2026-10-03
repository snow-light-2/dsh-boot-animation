/**
 * @dsh-external/dsh-boot-animation - the intro overlay itself.
 *
 * This is the piece that makes the plugin a STARTUP animation for DeepSeek
 * Harness rather than a decoration for conversations. It is deliberately NOT a
 * React component in a slot:
 *
 *   - `shell.overlay` only renders once the shell has mounted its frame, so an
 *     intro seated there cannot cover the loading surface that precedes it - the
 *     one moment the animation is actually for.
 *   - A slot cell would also be constrained to the shell's own stacking context.
 *     A desktop pet draws its menus at z-index 2147483000 on `document.body`,
 *     outside every slot, so a slot-based intro ties with it and loses.
 *
 * So the overlay is plain DOM appended to `document.body` the moment the client
 * plugin applies. No slot, no React root, no dependency on the session service to
 * exist before something can be shown.
 *
 * TRIGGERS (`settings.triggers`):
 *
 *   appStart            the application launched - once per DSH start. This is the
 *                       boot animation. It is told apart from a page reload by the
 *                       host process id (`bootId`); see claimAppStart below.
 *   pageLoad            every page load inside a running application, i.e. also F5.
 *                       Off by default: an application start is not a refresh.
 *   newConversation     a conversation that is still empty, once per conversation.
 *   pinnedConversation  the conversation the user pinned, every time it opens.
 *   conversation        every conversation entry, once per conversation.
 *
 * FREQUENCY (`settings.frequency`) then decides whether a trigger may fire at all:
 * every / daily / once / count. The split matters: a trigger says "this event
 * happened", the frequency says "am I allowed to show it now", and the conversation
 * memory says "have I already shown it for THIS conversation".
 */

import {
  DEFAULT_SETTINGS,
  DEFAULT_STATE,
  frequencyAllows,
  resolvedZIndex,
} from '../shared/settings.js'
import type { BootSettings, BootState, TriggerName } from '../shared/settings.js'
import { fetchPlan, reportPlayed, type PlanPayload } from './api.js'
import { ensureStyle } from './styles.js'

/** Where the conversation ids that already played are remembered. */
const SEEN_KEY = 'dsh-boot-animation:seen'
/** The chosen intro conversation. */
const PIN_KEY = 'dsh-boot-animation:pinned'
/**
 * Where the host process id that served this page is remembered.
 *
 * This is what makes "application start" distinguishable from "page reload". The
 * DSH host process boots once per application launch and runs for the whole
 * session, so the `bootId` it reports is a stable label for "this app session". A
 * page that finds a DIFFERENT id than the one it stored is looking at a freshly
 * started application - that is the boot animation. A page that finds the SAME id
 * was reloaded inside a session that was already running: the F5 case, which must
 * not replay a boot animation.
 */
const BOOT_KEY = 'dsh-boot-animation:bootId'
/** Bounded so localStorage cannot grow forever on a long-lived install. */
const MAX_SEEN = 200
/** Debug narration for a black frame that reports nothing by itself. */
const DEBUG = false
/** Fade-out duration, in ms, shared with the stylesheet's transition. */
const FADE_MS = 320

export type { TriggerName } from '../shared/settings.js'

export type PlayReason = TriggerName | 'preview' | 'manual'

/** What the module-level state looks like. */
type Bridge = {
  settings: BootSettings
  state: BootState
  clip: PlanPayload['clip']
  url: string | null
  /** Every clip the host can serve, so a per-trigger pick resolves to a URL. */
  clips: Map<string, string>
  loaded: boolean
  playing: boolean
  sessionId: string | null
  isNewConversation: boolean
  listeners: Set<(playing: boolean) => void>
  lastReason: PlayReason | null
  bootId: string | null
  /** True only for the FIRST page load after the application itself started. */
  appStarted: boolean
}

const bridge: Bridge = {
  settings: { ...DEFAULT_SETTINGS },
  state: { ...DEFAULT_STATE },
  clip: null,
  url: null,
  clips: new Map(),
  loaded: false,
  playing: false,
  sessionId: null,
  isNewConversation: false,
  listeners: new Set(),
  lastReason: null,
  bootId: null,
  appStarted: false,
}

/** The open overlay, so a second open can replace the first instead of stacking. */
let closeCurrent: ((reason: string) => void) | null = null

/* ------------------------------------------------------------------ storage */

function readSeen(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
  } catch {
    return []
  }
}

function hasPlayed(sessionId: string): boolean {
  return readSeen().includes(sessionId)
}

function markPlayed(sessionId: string): void {
  try {
    const seen = readSeen()
    if (!seen.includes(sessionId)) seen.push(sessionId)
    while (seen.length > MAX_SEEN) seen.shift()
    window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen))
  } catch {
    /* private mode: it simply replays next time */
  }
}

/** Forget which conversations already played - the panel's reset action. */
export function forgetPlayedConversations(): void {
  try {
    window.localStorage.removeItem(SEEN_KEY)
  } catch {
    /* private mode: nothing was remembered anyway */
  }
}

export function readPinned(): string | null {
  try {
    const value = window.localStorage.getItem(PIN_KEY)
    return value === null || value === '' ? null : value
  } catch {
    return null
  }
}

export function writePinned(sessionId: string | null): void {
  try {
    if (sessionId === null) window.localStorage.removeItem(PIN_KEY)
    else window.localStorage.setItem(PIN_KEY, sessionId)
  } catch {
    /* private mode: the pin simply does not persist */
  }
}

/* -------------------------------------------------------------------- debug */

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function narrate(text: string): void {
  try {
    console.log('[dsh-boot-animation] ' + text)
  } catch {
    /* console unavailable */
  }
}

function log(...args: unknown[]): void {
  if (!DEBUG) return
  narrate(args.map((a) => (typeof a === 'object' && a !== null ? safeJson(a) : String(a))).join(' '))
}

/**
 * The always-on subset.
 *
 * A black overlay reports nothing by itself - no network error, no thrown
 * exception, just a video element that never paints - so the few things needed to
 * diagnose one from the outside are logged unconditionally: which URL the element
 * actually used, when the first frame arrived, when the element errored and with
 * which code, and when the stall watchdog gave up. One line each, only on a play.
 */
function notify(...args: unknown[]): void {
  narrate(args.map((a) => (typeof a === 'object' && a !== null ? safeJson(a) : String(a))).join(' '))
}

/* -------------------------------------------------------------- config state */

/** Whether the intro may play at all right now. */
function allowed(): boolean {
  if (!bridge.settings.enabled) return false
  if (bridge.url === null || bridge.clip === null) return false
  return frequencyAllows(bridge.settings, bridge.state)
}

/**
 * The URL a trigger should play.
 *
 * `perTriggerClip` wins over the global pick, and the two are separate on purpose:
 * "play the cinematic clip when DSH starts, but the short one for a new chat" is a
 * real preference, and a single global slot cannot express it. An override the host
 * cannot serve falls back to the active clip rather than showing nothing.
 */
function urlFor(reason: PlayReason): string | null {
  const override = bridge.settings.perTriggerClip?.[reason as TriggerName]
  if (typeof override === 'string' && override !== '') {
    const url = bridge.clips.get(override)
    if (url !== undefined) return url
    log('per-trigger clip is not in the plan, falling back', override)
  }
  return bridge.url
}

function emit(): void {
  for (const listener of bridge.listeners) {
    try {
      listener(bridge.playing)
    } catch {
      /* a stale subscriber must not break playback */
    }
  }
}

/**
 * Re-read the settings, state and clip from the host.
 *
 * Failures are swallowed rather than thrown: a settings route that is briefly
 * unavailable (a restart in progress) must not take the whole client plugin down
 * with it, and the defaults are a playable configuration on their own.
 */
export async function refreshConfig(): Promise<PlanPayload | null> {
  try {
    const plan = await fetchPlan()
    applyPlan(plan)
    return plan
  } catch (error: unknown) {
    log('plan fetch failed', String(error))
    return null
  }
}

/** Fold one host answer into the in-memory decision state. */
export function applyPlan(plan: PlanPayload): void {
  bridge.settings = plan.settings ?? { ...DEFAULT_SETTINGS }
  bridge.state = plan.state ?? { ...DEFAULT_STATE }
  bridge.clip = plan.clip
  // `activeUrl` is the historical single route and always resolves to whatever is
  // active, so it is the fallback when a per-trigger clip is not in the plan.
  bridge.url = plan.url ?? plan.activeUrl
  // Every clip's URL, so a per-trigger override resolves without a second request.
  bridge.clips = new Map(Object.entries(plan.clipUrls ?? {}))
  bridge.bootId = typeof plan.bootId === 'string' ? plan.bootId : null
  bridge.appStarted = claimAppStart(bridge.bootId)
  bridge.loaded = true
  log('plan applied', {
    clip: bridge.clip?.id ?? null,
    triggers: bridge.settings.triggers,
    frequency: bridge.settings.frequency,
    layer: bridge.settings.layer,
    appStarted: bridge.appStarted,
  })
}

/* ----------------------------------------------------------- app start mark */

/**
 * Whether this page load is the first one after the application itself started.
 *
 * The host reports a `bootId` derived from its own process lifetime, so a page that
 * has never seen it is the first page of a new application session. Claims the id
 * as a side effect, because this question is asked once per page load and a second
 * ask must not fire the animation twice.
 *
 * A host that reports no id at all (an older host half) degrades to "every page
 * load counts as a start": that is what the `appStart` wording promises, and it
 * beats never playing at all.
 */
function claimAppStart(bootId: string | null): boolean {
  if (bootId === null) return true
  try {
    const known = window.localStorage.getItem(BOOT_KEY)
    window.localStorage.setItem(BOOT_KEY, bootId)
    return known !== bootId
  } catch {
    // Private mode: nothing can be remembered, so treat this as a start rather
    // than silently disabling the feature.
    return true
  }
}

/** Whether the current page load was the first after an application launch. */
export function isAppStart(): boolean {
  return bridge.appStarted
}

/* ----------------------------------------------------------------- triggers */

/** A trigger happened; decide whether it plays. */
export function trigger(reason: PlayReason): boolean {
  if (reason === 'preview' || reason === 'manual') {
    open(reason)
    return true
  }
  if (!bridge.settings.enabled) return false
  if (!bridge.settings.triggers.includes(reason as TriggerName)) return false
  if (!allowed()) {
    log('trigger blocked by frequency', reason)
    return false
  }
  // Application-scoped triggers are not remembered per conversation. They are
  // already bounded by the boot id (`appStart`) or by the frequency rule
  // (`pageLoad`), and remembering them per conversation would stop the animation
  // from playing the second time the application starts that day.
  const sessionScoped =
    reason === 'newConversation' || reason === 'pinnedConversation' || reason === 'conversation'
  if (sessionScoped) {
    const sessionId = bridge.sessionId
    if (sessionId === null) return false
    if (hasPlayed(sessionId)) return false
    markPlayed(sessionId)
  }
  open(reason)
  return true
}

/** Called by the session subscription whenever the current conversation changes. */
export function noteSession(sessionId: string | null, isNewConversation: boolean, entered: boolean): void {
  bridge.sessionId = sessionId
  bridge.isNewConversation = isNewConversation
  if (!entered || sessionId === null) return
  if (readPinned() === sessionId && bridge.settings.triggers.includes('pinnedConversation')) {
    // The designated conversation plays every time it is opened. The per
    // conversation memory is bypassed on purpose: a pin means "always".
    if (allowed()) open('pinnedConversation')
    return
  }
  if (isNewConversation && bridge.settings.triggers.includes('newConversation')) {
    if (hasPlayed(sessionId)) return
    markPlayed(sessionId)
    if (allowed()) open('newConversation')
    return
  }
  if (bridge.settings.triggers.includes('conversation')) {
    if (hasPlayed(sessionId)) return
    markPlayed(sessionId)
    if (allowed()) open('conversation')
  }
}

/**
 * The one-shot start evaluation, run once per page load after the plan arrives.
 *
 * Decides between the two application-level triggers: the first load after the app
 * started is `appStart`, any later load inside the running app is `pageLoad`.
 * `appStart` wins when both are enabled, because a start IS a page load - firing
 * both would play the animation twice on startup.
 */
export function triggerStart(): void {
  const triggers = bridge.settings.triggers
  if (bridge.appStarted) {
    if (triggers.includes('appStart')) {
      log('application start')
      trigger('appStart')
      return
    }
    if (triggers.includes('pageLoad')) {
      log('application start; playing because pageLoad is enabled')
      trigger('pageLoad')
    }
    return
  }
  if (triggers.includes('pageLoad')) {
    log('page load inside a running application')
    trigger('pageLoad')
  }
}

/** @deprecated Renamed to triggerStart. Kept so an older call site still resolves. */
export function triggerLaunch(): void {
  triggerStart()
}

/* ------------------------------------------------------------------ overlay */

type OpenHandle = { close: (reason: string) => void }

/**
 * Open the intro now.
 *
 * @param reason - What asked for it, reported as `dbaState.lastReason`.
 * @param urlOverride - Play this URL instead of the resolved one (the preview path).
 */
export function open(reason: PlayReason, urlOverride?: string): OpenHandle | null {
  const settings = bridge.settings
  const url = urlOverride ?? urlFor(reason)
  if (url === null) {
    notify('nothing to play: no clip resolved')
    return null
  }
  if (closeCurrent !== null) closeCurrent('replaced')

  ensureStyle()
  const root = document.createElement('div')
  root.className = 'dba-root'
  root.dataset.dbaPlaying = reason
  root.setAttribute('role', 'presentation')
  // Inline on the element rather than in the sheet, so changing a setting never
  // rebuilds the stylesheet and never reloads the media element.
  root.style.setProperty('--dba-z', String(resolvedZIndex(settings)))
  root.style.setProperty(
    '--dba-backdrop',
    settings.layer === 'backdrop'
      ? `rgba(0,0,0,${String(Math.max(0, Math.min(100, settings.backdropOpacity)) / 100)})`
      : 'rgba(0,0,0,1)',
  )
  root.style.setProperty('--dba-video-opacity', String(Math.max(0, Math.min(100, settings.videoOpacity)) / 100))
  root.style.setProperty('--dba-fade', `${String(FADE_MS)}ms`)

  const video = document.createElement('video')
  video.className = settings.fit === 'cover' ? 'dba-video dba-cover' : 'dba-video'
  video.src = url
  video.muted = !settings.sound
  video.volume = Math.max(0, Math.min(1, settings.volume / 100))
  video.defaultPlaybackRate = settings.playbackRate
  video.playbackRate = settings.playbackRate
  video.loop = settings.loop
  video.playsInline = true
  video.preload = 'auto'
  video.autoplay = true
  video.setAttribute('aria-hidden', 'true')

  const controls = document.createElement('div')
  controls.className = 'dba-controls'

  const status = document.createElement('div')
  status.className = 'dba-status'
  status.textContent = '正在加载片头…'

  const caption = document.createElement('div')
  caption.className = 'dba-caption'
  if (settings.title !== '') {
    const title = document.createElement('div')
    title.className = 'dba-title'
    title.textContent = settings.title
    caption.appendChild(title)
  }
  if (settings.subtitle !== '') {
    const subtitle = document.createElement('div')
    subtitle.className = 'dba-subtitle'
    subtitle.textContent = settings.subtitle
    caption.appendChild(subtitle)
  }

  const countdownFill = document.createElement('div')
  countdownFill.className = 'dba-countdown-fill'

  const hint = document.createElement('div')
  hint.className = 'dba-hint'

  root.appendChild(video)
  if (settings.title !== '' || settings.subtitle !== '') root.appendChild(caption)
  if (settings.maxSeconds > 0 && settings.showCountdown) {
    const countdown = document.createElement('div')
    countdown.className = 'dba-countdown'
    countdown.appendChild(countdownFill)
    root.appendChild(countdown)
  }
  root.appendChild(status)
  root.appendChild(controls)

  let closed = false
  const timers: number[] = []
  const later = (fn: () => void, ms: number): void => {
    timers.push(window.setTimeout(fn, ms))
  }

  const close = (why: string): void => {
    if (closed) return
    closed = true
    for (const timer of timers) window.clearTimeout(timer)
    timers.length = 0
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('keydown', onKeyDown, true)
    try {
      video.pause()
      // Drop the source so the decoder is released immediately; a paused element
      // that keeps its src holds its buffers until GC.
      video.removeAttribute('src')
      video.load()
    } catch {
      /* already stopped */
    }
    if (document.fullscreenElement !== null) void document.exitFullscreen?.().catch(() => {})
    root.classList.add('dba-closing')
    later(() => {
      root.remove()
    }, FADE_MS)
    log('closed', why)
    if (closeCurrent === close) {
      closeCurrent = null
      bridge.playing = false
      emit()
    }
  }

  closeCurrent = close
  bridge.playing = true
  bridge.lastReason = reason
  emit()

  /* -------------------------------------------------------------- controls */

  const playButton = document.createElement('button')
  playButton.type = 'button'
  playButton.className = 'dba-btn dba-hit'
  playButton.textContent = '播放'
  playButton.hidden = true
  playButton.addEventListener('click', (event) => {
    event.stopPropagation()
    playButton.hidden = true
    void attemptPlay()
  })
  controls.appendChild(playButton)

  let muted = video.muted
  const soundButton = document.createElement('button')
  soundButton.type = 'button'
  soundButton.className = 'dba-btn dba-ghost dba-hit'
  soundButton.textContent = muted ? '🔇' : '🔊'
  soundButton.title = '切换声音（浏览器要求先有一次点击才允许出声）'
  soundButton.addEventListener('click', (event) => {
    event.stopPropagation()
    muted = !muted
    video.muted = muted
    soundButton.textContent = muted ? '🔇' : '🔊'
    if (!muted) void video.play().catch(() => {})
  })
  controls.appendChild(soundButton)

  if (settings.allowFullscreen) {
    const fullButton = document.createElement('button')
    fullButton.type = 'button'
    fullButton.className = 'dba-btn dba-ghost dba-hit'
    fullButton.textContent = '⛶'
    fullButton.title = '全屏播放'
    fullButton.addEventListener('click', (event) => {
      event.stopPropagation()
      if (document.fullscreenElement === null) void root.requestFullscreen?.().catch(() => {})
      else void document.exitFullscreen?.().catch(() => {})
    })
    controls.appendChild(fullButton)
  }

  const skipButton = document.createElement('button')
  skipButton.type = 'button'
  skipButton.className = 'dba-btn dba-hit'
  skipButton.textContent = settings.skipLabel === '' ? '跳过' : settings.skipLabel
  skipButton.addEventListener('click', (event) => {
    event.stopPropagation()
    close('skip')
  })
  if (settings.showSkip && settings.skipAfterMs <= 0) controls.appendChild(skipButton)

  if (settings.hintLabel !== '') {
    hint.textContent = settings.hintLabel
    root.appendChild(hint)
  }

  /* -------------------------------------------------------------- playback */

  const attemptPlay = async (): Promise<void> => {
    try {
      await video.play()
      status.style.display = 'none'
      root.dataset.dbaState = 'playing'
    } catch (error: unknown) {
      // Autoplay refused: a browser rule, not a plugin bug. Surface a button
      // rather than a black frame - the one thing a user can act on.
      log('play rejected', String(error))
      // Recorded on the element so the keydown handler can tell "the user is
      // typing and wants this gone" from "the browser is waiting for the gesture
      // that starts playback"; closing on that first keypress would make the intro
      // appear to fail whenever someone pressed a key during the delay.
      root.dataset.dbaState = 'awaiting-gesture'
      playButton.hidden = false
      status.textContent = '点击「播放」开始片头'
    }
  }

  const report = (label: string): void =>
    notify(label, {
      reason,
      clip: bridge.clip?.id ?? null,
      src: video.currentSrc === '' ? video.src : video.currentSrc,
      readyState: video.readyState,
      networkState: video.networkState,
    })

  video.addEventListener('playing', () => {
    status.style.display = 'none'
    report('first frame painted')
  })
  video.addEventListener('ended', () => close('ended'))
  video.addEventListener('error', () => {
    const code = video.error?.code ?? 0
    const message = video.error?.message ?? ''
    notify('video element error', { code, message, src: video.currentSrc || url })
    status.textContent = '片头加载失败 —— 控制台有 [dsh-boot-animation] 日志'
    // Do not slam the overlay shut: the reason has to stay readable for a moment,
    // and 跳过 is right there. A silent close is how a real failure looks like
    // "nothing happened".
    later(() => close('error'), 8000)
  })

  // A stalled clip must never trap the user behind the overlay.
  later(
    () => {
      if (!closed && video.readyState < 2) {
        report('stalled, giving up')
        close('stalled')
      }
    },
    Math.max(3000, settings.stallTimeoutMs),
  )

  // A hard stop, so a looping or unusually long clip still ends.
  if (settings.maxSeconds > 0) {
    const totalMs = settings.maxSeconds * 1000
    const startedAt = performance.now()
    const step = (): void => {
      if (closed) return
      const elapsed = performance.now() - startedAt
      countdownFill.style.transform = `scaleX(${String(Math.max(0, 1 - elapsed / totalMs))})`
      if (elapsed >= totalMs) {
        close('maxSeconds')
        return
      }
      window.requestAnimationFrame(step)
    }
    window.requestAnimationFrame(step)
  }

  // The skip affordance can be withheld briefly, so a short intro is not covered
  // by a button nobody needs. The timer is registered in `timers`, so closing
  // first cancels it.
  if (settings.showSkip && settings.skipAfterMs > 0) {
    later(() => {
      if (!closed && skipButton.parentElement === null) controls.appendChild(skipButton)
    }, settings.skipAfterMs)
  }

  /**
   * Dismiss on real interaction with the page behind.
   *
   * A capture-phase listener on the document, because the overlay itself is
   * `pointer-events: none`: a click on a desktop pet or on the app must reach its
   * target AND end an intro the user has visibly stopped watching. Keydown is
   * included so typing dismisses it too.
   */
  function onPointerDown(event: PointerEvent): void {
    const target = event.target
    if (target instanceof Node && root.contains(target)) return
    if (settings.dismissOnInteract) close('interact')
  }
  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      close('escape')
      return
    }
    if (!settings.dismissOnInteract) return
    if (root.dataset.dbaState === 'awaiting-gesture') return
    if (event.target instanceof Node && root.contains(event.target)) return
    close('interact')
  }
  if (settings.dismissOnInteract || settings.showSkip) {
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown, true)
  }

  document.body.appendChild(root)

  if (settings.delayMs > 0) {
    later(() => {
      if (!closed) void attemptPlay()
    }, settings.delayMs)
  } else {
    void attemptPlay()
  }

  // The host owns the play counter, because only it can stamp a clock the client
  // cannot wind backwards: `daily` and `count` are enforced from its answer.
  if (reason !== 'preview' && reason !== 'manual') {
    void reportPlayed({
      ...(bridge.clip?.id == null ? {} : { clipId: bridge.clip.id }),
      ...(bridge.sessionId == null ? {} : { conversationId: bridge.sessionId }),
    })
      .then((answer) => {
        if (answer.ok && answer.state !== undefined) bridge.state = answer.state
      })
      .catch(() => {
        /* offline: the local conversation memory still prevents a replay loop */
      })
  }

  return { close }
}

/* ------------------------------------------------------------------- bridge */

/**
 * The global handle.
 *
 * Published on `window.__dshBootAnimation` so a user can drive the intro from the
 * console (`__dshBootAnimation.play()`) and so another plugin - a desktop pet, or a
 * skin - can ask whether an intro is on screen before drawing over it, instead of
 * the two racing for the same pixels. Read-only introspection plus two explicit
 * commands; nothing here lets a third party change settings behind the panel's back.
 */
export type BootAnimationBridge = {
  readonly version: string
  readonly settings: BootSettings
  readonly state: BootState
  readonly playing: boolean
  readonly clip: PlanPayload['clip']
  readonly url: string | null
  readonly lastReason: PlayReason | null
  readonly appStart: boolean
  play: (reason?: PlayReason) => void
  close: (reason?: string) => void
  refresh: () => Promise<void>
  forgetConversations: () => void
  onPlayingChange: (listener: (playing: boolean) => void) => () => void
}

export function installBridge(version: string): void {
  const api: BootAnimationBridge = {
    version,
    get settings() {
      return bridge.settings
    },
    get state() {
      return bridge.state
    },
    get playing() {
      return bridge.playing
    },
    get clip() {
      return bridge.clip
    },
    get url() {
      return bridge.url
    },
    get lastReason() {
      return bridge.lastReason
    },
    get appStart() {
      return bridge.appStarted
    },
    play: (reason: PlayReason = 'manual') => {
      open(reason)
    },
    close: (reason = 'manual') => {
      closeCurrent?.(reason)
    },
    refresh: async () => {
      await refreshConfig()
    },
    forgetConversations: () => {
      forgetPlayedConversations()
    },
    onPlayingChange: (listener) => {
      bridge.listeners.add(listener)
      return () => {
        bridge.listeners.delete(listener)
      }
    },
  }
  try {
    ;(window as unknown as { __dshBootAnimation?: BootAnimationBridge }).__dshBootAnimation = api
  } catch {
    /* a frozen global scope: the panel still works through its own imports */
  }
}

/** The settings the overlay is deciding with, for the panel's own display. */
export function currentSettings(): BootSettings {
  return bridge.settings
}

export function currentState(): BootState {
  return bridge.state
}

export function currentSessionId(): string | null {
  return bridge.sessionId
}

export function isPlaying(): boolean {
  return bridge.playing
}

export function subscribePlaying(listener: (playing: boolean) => void): () => void {
  bridge.listeners.add(listener)
  return () => {
    bridge.listeners.delete(listener)
  }
}

/** True once the host has answered once. */
export function isLoaded(): boolean {
  return bridge.loaded
}
