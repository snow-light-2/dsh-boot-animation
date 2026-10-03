/**
 * @dsh-external/dsh-boot-animation - the browser half's entry point.
 *
 * What changed from the previous version, and why:
 *
 * 1. THE INTRO IS A STARTUP ANIMATION. It used to play only when a conversation
 *    was entered - a new one once, or the pinned one every time - because that was
 *    the only thing it could observe. This version triggers on page load as well
 *    (`launch`), which is what "开机动画" means to a user. The conversation
 *    triggers are kept and can be switched off.
 *
 * 2. IT DOES NOT TAKE A SLOT. The overlay is appended to `document.body` by
 *    `boot-overlay.ts`, so it can cover the shell's own "Loading plugins…" surface
 *    and so it can be stacked above a desktop pet that draws on `document.body`
 *    outside every slot. Only the small sidebar control still uses a slot.
 *
 * 3. NOTHING VERSION-SENSITIVE IS INJECTED. `slots` is the only injected service,
 *    and the interface used from it (`inject`/`register`) is the oldest part of its
 *    API. The session service is read through `ctx.get('uiSession')` inside the
 *    apply body, so a host without it still runs the launch animation instead of
 *    failing the whole entry - which is exactly the class of failure that shows up
 *    as a white screen when a plugin renders a component that resolved to
 *    `undefined`.
 *
 * 4. THE SIDEBAR GOT ONE SEAT, NOT TWO. A single panel button replaces the old
 *    pin+panel pair: pinning a conversation now lives in the panel's first tab,
 *    and the panel also carries the settings the old version had nowhere to put.
 */

import type { ReactElement } from 'react'
import { createElement as h, useState } from 'react'

import { open, refreshConfig, installBridge, noteSession, triggerLaunch } from './boot-overlay.js'
import { fetchConfig } from './api.js'
import { SettingsPanel } from './settings-panel.js'
import { ensureStyle } from './styles.js'

/** Slot service for the one sidebar seat. Everything else is plain DOM. */
export const inject = ['slots']

const VERSION = '0.3.0'

/** The store `ui-session` publishes the current conversation on. */
type CurrentStore = {
  getSnapshot: () => unknown
  subscribe: (listener: () => void) => () => void
}

type Binding = {
  key?: unknown
  hooks?: { session?: { blankBit?: unknown } }
  props?: { sessionId?: unknown }
}

type ClientContext = {
  slots: {
    inject: (name: string, callback: () => unknown) => unknown
    register: (options: Record<string, unknown>, component: unknown) => unknown
  }
  get?: (name: string) => unknown
  effect?: (callback: () => unknown, label?: string) => unknown
  logger?: unknown
}

/**
 * The current conversation, read from the store directly.
 *
 * Subscribed with the store's own `subscribe`/`getSnapshot`, not with a React
 * hook: the overlay lives outside React, so the trigger logic cannot be a hook.
 * A missing store is a supported state - the launch trigger does not need it.
 */
function watchSession(store: CurrentStore | null): () => void {
  if (store === null) return () => {}
  let last: string | null = null
  const read = (): void => {
    let binding: Binding | null = null
    try {
      binding = store.getSnapshot() as Binding | null
    } catch {
      return
    }
    const sessionId =
      typeof binding?.props?.sessionId === 'string' ? binding.props.sessionId : null
    const isNew = binding?.hooks?.session?.blankBit === true
    const entered = last !== sessionId
    last = sessionId
    noteSession(sessionId, isNew, entered)
  }
  read()
  return store.subscribe(read)
}

/** Resolve the current-conversation store, tolerating a host that has none. */
function resolveStore(ctx: ClientContext): CurrentStore | null {
  try {
    const uiSession = ctx.get?.('uiSession') as { adapter?: { current?: CurrentStore } } | undefined
    const candidate = uiSession?.adapter?.current
    return candidate !== undefined &&
      typeof candidate.getSnapshot === 'function' &&
      typeof candidate.subscribe === 'function'
      ? candidate
      : null
  } catch {
    return null
  }
}

export function apply(ctx: ClientContext): void {
  ensureStyle()
  installBridge(VERSION)

  // ------------------------------------------------------------------ triggers
  //
  // Order matters. The plan has to arrive before a launch can be evaluated (it
  // carries the settings and the resolved clip), but the session subscription must
  // be live first, because on a cold start the session can settle before the plan
  // does and the conversation triggers would otherwise miss that transition.
  const store = resolveStore(ctx)
  const unwatch = watchSession(store)

  void (async () => {
    // The plan carries the settings, the play state and the resolved clip URL, so
    // one call arms every trigger. The overlay reads it again through the bridge
    // after each settings write.
    await refreshConfig()
    // After the first paint, so the shell's own boot surface is on screen before
    // the intro covers it: the same black frame reads as a crash over a blank
    // page and as an intro over a rendered shell.
    window.requestAnimationFrame(() => {
      triggerLaunch()
    })
  })()

  // ---------------------------------------------------------------- sidebar UI
  //
  // One seat. `sidebar.footer.action` is a list slot, so it coexists with the pet
  // pin and the doctor button instead of competing with them for a single seat.
  //
  // The registered component holds the open/closed state itself and renders the
  // panel as an ELEMENT. It is never called as a plain function: calling a
  // component directly would run the panel's hooks against this component's hook
  // list, so opening the dialog would change the hook count between renders and
  // React would throw "Rendered more hooks than during the previous render".
  const SidebarEntry = (): ReactElement => {
    const [panelOpen, setPanelOpen] = useState(false)

    if (panelOpen) {
      return h(SettingsPanel, {
        onClose: () => setPanelOpen(false),
        onPreview: (clipId: string | null) => {
          setPanelOpen(false)
          // Close first, then play: the intro must not appear underneath its own
          // settings dialog. The delay lets React commit the close before the
          // overlay covers the frame.
          window.setTimeout(() => {
            if (clipId === null) open('preview')
            else void previewClipById(clipId)
          }, 80)
        },
      })
    }

    return h(
      'button',
      {
        type: 'button',
        className: 'dba-btn dba-panel dba-hit',
        style: { width: '28px', height: '28px', padding: '0', borderRadius: '8px', border: '0' },
        title: '片头动画：设置什么时候播、怎么播、播哪一段',
        'aria-label': '片头动画设置',
        onClick: () => setPanelOpen(true),
      },
      '🎬',
    )
  }

  const mount = (): void => {
    ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots.register(
        {
          name: 'sidebar.footer.action',
          id: 'dsh-boot-animation-panel',
          order: 40,
          label: () => '片头动画',
        },
        SidebarEntry,
      ),
    )
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      mount()
      return () => {
        unwatch()
      }
    }, 'dsh-boot-animation: mounts')
  } else {
    mount()
  }
}

/**
 * Play one clip by id, for a per-clip preview.
 *
 * The host exposes every clip at `/media/<id>` with its content key pinned, so a
 * preview plays the clip the user clicked without first having to save it as the
 * pick - which is the difference between "试播" and "设成片头再看一次".
 */
async function previewClipById(clipId: string): Promise<void> {
  // Read the pinned URL from the host so the preview cannot be served from a cache
  // entry that belongs to different bytes.
  let url = '/dsh-boot-animation/media/' + encodeURIComponent(clipId)
  try {
    const config = await fetchConfig()
    const clip = config.clips.find((entry) => entry.id === clipId)
    if (clip !== undefined) url = clip.urls.media
  } catch {
    /* fall back to the unpinned URL */
  }
  open('preview', url)
}
