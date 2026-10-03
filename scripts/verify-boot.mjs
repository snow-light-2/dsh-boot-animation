/**
 * verify-boot.mjs — drives the BUILT browser bundle through a DOM shim.
 *
 * What this file exists to prove, in the order it matters:
 *
 *  1. The application-start trigger. This is the feature: the intro must play when
 *     DeepSeek Harness starts and NOT when someone presses F5 inside a running
 *     application. The two are indistinguishable from inside the page except by the
 *     host process id, so the whole mechanism is exercised here rather than trusted:
 *     same `bootId` -> no play, new `bootId` -> play.
 *
 *  2. The conflict fixes. The overlay must be `pointer-events: none` at the root so
 *     it cannot swallow a click meant for a desktop pet, and its stacking index must
 *     not TIE with the pet's own 2147483000.
 *
 *  3. That the built bundle loads and applies at all, with no injected service other
 *     than `slots`. A white screen from this plugin would start as a throw here.
 *
 * It imports `lib/client.js` - the committed artifact, not the source - because the
 * artifact is what ships. Usage: node scripts/verify-boot.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const ok = (label, good, detail = '') => {
  console.log(`  ${good ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ' — ' + detail}`)
  if (!good) failures.push(label + (detail === '' ? '' : ' — ' + detail))
}

/* ------------------------------------------------------------------ DOM shim */

/** A tiny element: enough of the DOM for the overlay, and nothing more. */
function createElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentElement: null,
    style: {
      values: new Map(),
      setProperty(name, value) {
        this.values.set(name, value)
      },
      getPropertyValue(name) {
        return this.values.get(name) ?? ''
      },
    },
    dataset: {},
    className: '',
    textContent: '',
    hidden: false,
    muted: false,
    volume: 1,
    playbackRate: 1,
    loop: false,
    playsInline: false,
    preload: '',
    autoplay: false,
    src: '',
    currentSrc: '',
    readyState: 0,
    networkState: 0,
    error: null,
    listeners: new Map(),
    setAttribute(name, value) {
      this[name] = value
    },
    removeAttribute(name) {
      delete this[name]
    },
    appendChild(child) {
      child.parentElement = this
      this.children.push(child)
      return child
    },
    remove() {
      if (this.parentElement !== null) {
        const index = this.parentElement.children.indexOf(this)
        if (index !== -1) this.parentElement.children.splice(index, 1)
        this.parentElement = null
      }
    },
    contains(node) {
      for (let cursor = node; cursor != null; cursor = cursor.parentElement) {
        if (cursor === this) return true
      }
      return false
    },
    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? []
      list.push(listener)
      this.listeners.set(type, list)
    },
    removeEventListener(type, listener) {
      const list = this.listeners.get(type) ?? []
      this.listeners.set(
        type,
        list.filter((entry) => entry !== listener),
      )
    },
    dispatch(type) {
      for (const listener of this.listeners.get(type) ?? []) listener({ type, target: this })
    },
    /** Resolve play() the way a browser with a satisfied autoplay policy would. */
    play() {
      this.readyState = 4
      this.dispatch('playing')
      return Promise.resolve()
    },
    pause() {},
    load() {},
    requestFullscreen() {
      return Promise.resolve()
    },
    classList: {
      add() {},
      remove() {},
    },
    querySelector() {
      return null
    },
  }
  // A deep-ish walk, so `select`-style lookups in the panel are not needed here.
  element.findAll = (tag) => {
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child.tagName === String(tag).toUpperCase()) out.push(child)
        walk(child)
      }
    }
    walk(element)
    return out
  }
  return element
}

const body = createElement('body')
const head = createElement('head')

const documentShim = {
  body,
  head,
  fullscreenElement: null,
  documentElement: createElement('html'),
  createElement,
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  exitFullscreen: () => Promise.resolve(),
}

const storage = new Map()
const windowShim = {
  document: documentShim,
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  requestAnimationFrame: (fn) => setTimeout(() => fn(0), 0),
  addEventListener() {},
  removeEventListener() {},
  alert() {},
}

globalThis.window = windowShim
globalThis.document = documentShim
globalThis.performance = globalThis.performance ?? { now: () => Date.now() }
globalThis.localStorage = windowShim.localStorage

/* --------------------------------------------------------------- load bundle */

const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
let entry = null
windowShim.__ModuleLoader__ = {
  load(definition) {
    entry = definition
  },
}

/**
 * The module table the page provides.
 *
 * React is the only external this bundle requires, and the stub is deliberately
 * minimal: this test is about trigger decisions and styling, not about rendering.
 */
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  useMemo: (fn) => fn(),
  useSyncExternalStore: () => null,
}

const moduleTable = { react: reactStub, 'react/jsx-runtime': { jsx: reactStub.createElement } }

console.log('bundle load:')
try {
  // eslint-disable-next-line no-new-func -- evaluating a committed artifact is the point
  new Function('window', 'document', 'globalThis', source)(windowShim, documentShim, globalThis)
  ok('lib/client.js evaluates', entry !== null, entry === null ? 'no __ModuleLoader__.load call' : `id=${entry.id}`)
} catch (error) {
  ok('lib/client.js evaluates', false, String(error))
}
if (entry === null) {
  console.log('\ncannot continue without the bundle')
  process.exit(1)
}
ok('bundle id is dsh-boot-animation', entry.id === 'dsh-boot-animation', entry.id)

let exported = null
try {
  exported = entry.factory((name) => {
    if (!(name in moduleTable)) throw new Error(`unexpected require("${name}")`)
    return moduleTable[name]
  })
} catch (error) {
  ok('factory runs with only react provided', false, String(error))
}
if (exported === null) {
  console.log('\ncannot continue without exports')
  process.exit(1)
}
ok('factory runs with only react provided', true)
ok('declares inject: [slots]', JSON.stringify(exported.inject) === '["slots"]', JSON.stringify(exported.inject))
ok('exports apply()', typeof exported.apply === 'function')

/* ------------------------------------------------------------- apply + plan */

/** Host answers, as route -> body, so the overlay can be driven without a server. */
const host = {
  plan: null,
  posts: [],
  failPlan: false,
}

const slotsRegistered = []
const slotsInjected = []
const ctx = {
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get: () => undefined, // no uiSession: the appStart trigger must not need it
  slots: {
    inject: (name, callback) => {
      slotsInjected.push(name)
      callback()
    },
    register: (options, component) => {
      slotsRegistered.push({ options, component })
      return () => {}
    },
  },
}

globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (init?.method === 'POST') {
    host.posts.push({ url: target, body: JSON.parse(String(init.body)) })
    return { ok: true, status: 200, json: async () => ({ ok: true, state: { ranAt: null, runs: 1 } }) }
  }
  if (target.includes('/plan.json')) {
    if (host.failPlan) return { ok: false, status: 500, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => host.plan }
  }
  return { ok: true, status: 200, json: async () => ({ settings: host.plan.settings, state: host.plan.state, clips: [], videos: [], active: host.plan.clip, limits: {}, userData: {} }) }
}

const basePlan = (overrides = {}) => ({
  settings: {
    version: 1,
    enabled: true,
    frequency: 'every',
    playCount: 3,
    triggers: ['appStart', 'newConversation', 'pinnedConversation'],
    clipId: 'builtin:startup',
    perTriggerClip: {},
    layer: 'overlay',
    backdropOpacity: 100,
    fit: 'cover',
    videoOpacity: 100,
    delayMs: 0,
    maxSeconds: 0,
    playbackRate: 1,
    loop: false,
    sound: false,
    volume: 100,
    showSkip: true,
    skipAfterMs: 1200,
    allowFullscreen: true,
    dismissOnInteract: true,
    title: '',
    subtitle: '',
    showCountdown: true,
    skipLabel: '跳过',
    hintLabel: '',
    zIndex: 0,
    stallTimeoutMs: 25000,
    ...(overrides.settings ?? {}),
  },
  state: { ranAt: null, runs: 0, clipId: null, conversationId: null, ...(overrides.state ?? {}) },
  bootId: overrides.bootId ?? 'boot-1',
  clip: overrides.clip === undefined ? { id: 'builtin:startup', name: '启动问题', how: 'embedded', version: 'v1', bytes: 10 } : overrides.clip,
  url: overrides.url === undefined ? '/dsh-boot-animation/media/builtin%3Astartup?v=v1' : overrides.url,
  activeUrl: '/dsh-boot-animation/boot.mp4?v=v1',
  clipUrls: overrides.clipUrls ?? {
    'builtin:startup': '/dsh-boot-animation/media/builtin%3Astartup?v=v1',
    'builtin:brand': '/dsh-boot-animation/media/builtin%3Abrand?v=vB',
  },
  clipCount: 2,
})

/** Count the overlays currently in the document. */
const overlayCount = () => body.findAll('div').filter((el) => el.className.includes('dba-root')).length
const lastOverlay = () => {
  const all = body.findAll('div').filter((el) => el.className.includes('dba-root'))
  return all[all.length - 1]
}

/** Run one page load: reset the DOM, apply, and let the microtasks settle. */
async function pageLoad({ bootId, planOverrides = {}, freshStorage = false } = {}) {
  for (const child of [...body.children]) child.remove()
  if (freshStorage) storage.clear()
  host.plan = basePlan({ bootId, ...planOverrides })
  exported.apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 30))
}

console.log('\nslot seats (conflict surface):')
await pageLoad({ bootId: 'boot-1', freshStorage: true })
ok(
  'registers exactly one slot seat',
  slotsRegistered.length === 1,
  slotsRegistered.map((r) => `${r.options.name}#${String(r.options.id)}`).join(', '),
)
ok(
  'the seat is sidebar.footer.action',
  slotsRegistered[0]?.options.name === 'sidebar.footer.action',
  String(slotsRegistered[0]?.options.name),
)
ok(
  'never registers into shell.overlay (a pet owns that list slot)',
  !slotsRegistered.some((r) => r.options.name === 'shell.overlay'),
)
ok('every registered component is a function', slotsRegistered.every((r) => typeof r.component === 'function'))

console.log('\napplication-start trigger:')
{
  await pageLoad({ bootId: 'boot-A', freshStorage: true })
  ok('first page load after a launch plays', overlayCount() === 1, `overlays=${String(overlayCount())}`)
  ok(
    'the play is reported to the host for the frequency counter',
    host.posts.some((p) => p.url.includes('/state')),
    JSON.stringify(host.posts.map((p) => p.url)),
  )
  ok(
    'the playing reason is appStart',
    lastOverlay()?.dataset?.dbaPlaying === 'appStart',
    String(lastOverlay()?.dataset?.dbaPlaying),
  )

  // Same boot id: the F5 case.
  await pageLoad({ bootId: 'boot-A' })
  ok('a reload in the same application session does NOT play', overlayCount() === 0, `overlays=${String(overlayCount())}`)

  // New boot id: the application was started again.
  await pageLoad({ bootId: 'boot-B' })
  ok('a new application session plays again', overlayCount() === 1, `overlays=${String(overlayCount())}`)

  // pageLoad on, appStart off: a reload should play.
  await pageLoad({ bootId: 'boot-B', planOverrides: { settings: { triggers: ['pageLoad'] } } })
  ok('pageLoad trigger plays on a reload', overlayCount() === 1, `overlays=${String(overlayCount())}`)
  await pageLoad({ bootId: 'boot-C', planOverrides: { settings: { triggers: ['pageLoad'] } } })
  ok(
    'pageLoad reason is reported on a fresh start too',
    lastOverlay()?.dataset?.dbaPlaying === 'pageLoad',
    String(lastOverlay()?.dataset?.dbaPlaying),
  )

  // Master switch.
  await pageLoad({ bootId: 'boot-D', planOverrides: { settings: { enabled: false } } })
  ok('the master switch suppresses everything', overlayCount() === 0)

  // Frequency rules.
  await pageLoad({
    bootId: 'boot-E',
    planOverrides: {
      settings: { frequency: 'once' },
      state: { ranAt: new Date().toISOString(), runs: 1 },
    },
  })
  ok('frequency=once does not replay when history exists', overlayCount() === 0)
  await pageLoad({ bootId: 'boot-F', planOverrides: { settings: { frequency: 'count', playCount: 2 }, state: { ranAt: new Date().toISOString(), runs: 2 } } })
  ok('frequency=count stops at the limit', overlayCount() === 0)

  // No clip at all: it must not sit on a black screen.
  await pageLoad({ bootId: 'boot-G', planOverrides: { clip: null, url: null, activeUrl: null, clips: [] } })
  ok('no resolved clip means no overlay', overlayCount() === 0)
}

console.log('\nconflict fixes:')
{
  await pageLoad({ bootId: 'boot-H', freshStorage: true })
  const overlay = lastOverlay()
  const z = Number(overlay?.style.getPropertyValue('--dba-z'))
  ok('overlay layer does not tie with the pet menu (2147483000)', z !== 2147483000, `z=${String(z)}`)
  ok('overlay layer sits above it', z > 2147483000, `z=${String(z)}`)

  await pageLoad({ bootId: 'boot-I', planOverrides: { settings: { layer: 'backdrop' } } })
  const z2 = Number(lastOverlay()?.style.getPropertyValue('--dba-z'))
  ok('backdrop layer sits below the pet menu', z2 < 2147483000, `z=${String(z2)}`)

  // The custom z-index wins when set.
  await pageLoad({ bootId: 'boot-J', planOverrides: { settings: { zIndex: 4242 } } })
  ok('a custom z-index overrides the layer', lastOverlay()?.style.getPropertyValue('--dba-z') === '4242')

  // Per-trigger clip: the host's per-clip URL must be the one used. This is the
  // check that caught a real bug - the plan used to carry only the ACTIVE clip's
  // URL, so an override fell back to the wrong video instead of failing loudly.
  await pageLoad({
    bootId: 'boot-K',
    planOverrides: { settings: { perTriggerClip: { appStart: 'builtin:brand' } } },
  })
  const video = lastOverlay()?.findAll('video')[0]
  ok(
    'a per-trigger clip plays its own URL',
    typeof video?.src === 'string' && video.src.includes('brand'),
    String(video?.src),
  )

  // An override whose clip the host cannot serve must fall back, not show nothing.
  await pageLoad({
    bootId: 'boot-K2',
    planOverrides: { settings: { perTriggerClip: { appStart: 'builtin:missing' } } },
  })
  ok('an unknown override falls back to the active clip', overlayCount() === 1, `overlays=${String(overlayCount())}`)
}

console.log('\npointer events (the pet must stay clickable):')
{
  const css = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
  ok(
    '.dba-root is pointer-events: none',
    /\.dba-root\{[^}]*pointer-events:none/.test(css.replace(/\s+/g, '')),
    'the root must not swallow clicks',
  )
  ok('.dba-hit re-enables pointer events on controls', css.includes('.dba-hit{pointer-events:auto'))
  ok('no full-frame pointer-events:auto on the root', !/\.dba-root\{[^}]*pointer-events:auto/.test(css.replace(/\s+/g, '')))
  ok('the stylesheet is namespaced with dba-', css.includes('dba-root') && !css.includes('.dsh-pet-root'))
}

console.log('\nresilience:')
{
  /*
   * The host-outage path lives in its own process (verify-boot-resilience.mjs),
   * because the bridge inspected below has already been armed by the page loads
   * above - module state is per page, and a page whose host never answered is a
   * state this process can no longer be in. What is checked here is the part this
   * process CAN be in: the bridge's read-only surface and its two commands.
   */
  await pageLoad({ bootId: 'boot-L', freshStorage: true })
  const api = windowShim.__dshBootAnimation
  ok('publishes the console bridge', typeof api?.play === 'function', `version=${String(api?.version)}`)
  ok('bridge reports the app-start verdict', api?.appStart === true, String(api?.appStart))
  ok('bridge exposes the resolved clip', api?.clip?.id === 'builtin:startup', String(api?.clip?.id))
  ok(
    'bridge exposes a playing-change subscription for other plugins (a pet can yield)',
    typeof api?.onPlayingChange === 'function',
  )

  let seen = null
  const unsubscribe = api.onPlayingChange((playing) => {
    seen = playing
  })
  const before = overlayCount()
  api.play('manual')
  ok('the bridge can open the intro on demand', overlayCount() > before, `overlays=${String(overlayCount())}`)
  ok('the playing flag is readable', api.playing === true)
  ok('a subscriber is notified', seen === true, String(seen))
  api.close('test')
  ok('the bridge can close it', api.playing === false)
  ok('the subscriber sees the close', seen === false, String(seen))
  unsubscribe()
}

console.log('')
if (failures.length === 0) {
  console.log('all boot checks passed')
  process.exit(0)
}
console.log(`${failures.length} boot check(s) failed:`)
for (const failure of failures) console.log('  - ' + failure)
process.exit(1)
