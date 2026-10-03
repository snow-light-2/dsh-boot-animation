/**
 * verify-boot-resilience.mjs — the failure path, in a FRESH module instance.
 *
 * Split out of verify-boot.mjs on purpose. That file drives one page load after
 * another in a single process, which is fine for trigger decisions but wrong for a
 * host-outage test: the module-level bridge it inspects was armed by an earlier,
 * successful page load, so the assertions there would describe the previous run.
 *
 * Running the outage in its own process is also the only way to assert it at all:
 * the page's module scope is evaluated once per page, so "the host answered
 * nothing" is a state that can only be reached before any answer arrives.
 *
 * Usage: node scripts/verify-boot-resilience.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A DOM shim with exactly what the overlay touches. See verify-boot.mjs. */
function createElement(tag) {
  const element = {
    tagName: String(tag).toUpperCase(),
    children: [],
    parentElement: null,
    style: { values: new Map(), setProperty(n, v) { this.values.set(n, v) }, getPropertyValue(n) { return this.values.get(n) ?? '' } },
    dataset: {},
    className: '',
    textContent: '',
    listeners: new Map(),
    setAttribute(n, v) { this[n] = v },
    removeAttribute(n) { delete this[n] },
    appendChild(child) { child.parentElement = this; this.children.push(child); return child },
    remove() {
      const parent = this.parentElement
      if (parent === null) return
      const index = parent.children.indexOf(this)
      if (index !== -1) parent.children.splice(index, 1)
      this.parentElement = null
    },
    contains(node) {
      for (let cursor = node; cursor != null; cursor = cursor.parentElement) if (cursor === this) return true
      return false
    },
    addEventListener(type, listener) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list) },
    removeEventListener() {},
    dispatch() {},
    play() { this.readyState = 4; return Promise.resolve() },
    pause() {},
    load() {},
    requestFullscreen() { return Promise.resolve() },
    classList: { add() {}, remove() {} },
    findAll(tag) {
      const out = []
      const walk = (node) => {
        for (const child of node.children) {
          if (child.tagName === String(tag).toUpperCase()) out.push(child)
          walk(child)
        }
      }
      walk(this)
      return out
    },
  }
  return element
}

const body = createElement('body')
const documentShim = {
  body,
  head: createElement('head'),
  fullscreenElement: null,
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

const source = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8')
let entry = null
windowShim.__ModuleLoader__ = { load: (definition) => { entry = definition } }

const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
  useMemo: (fn) => fn(),
  useSyncExternalStore: () => null,
}

new Function('window', 'document', 'globalThis', source)(windowShim, documentShim, globalThis)
const exported = entry.factory((name) => {
  if (name === 'react') return reactStub
  if (name === 'react/jsx-runtime') return { jsx: reactStub.createElement }
  throw new Error(`unexpected require("${name}")`)
})

/** Every request fails, as a host restarting under the page would. */
globalThis.fetch = async () => {
  throw new Error('ECONNREFUSED (simulated host outage)')
}

let registered = 0
const ctx = {
  effect: (fn) => {
    const dispose = fn()
    return typeof dispose === 'function' ? dispose : () => {}
  },
  get: () => undefined,
  slots: {
    inject: (_name, callback) => callback(),
    register: () => {
      registered += 1
      return () => {}
    },
  },
}

const failures = []
const ok = (label, good, detail = '') => {
  console.log(`  ${good ? 'ok  ' : 'FAIL'} ${label}${detail === '' ? '' : ' — ' + detail}`)
  if (!good) failures.push(label)
}

console.log('host outage at first paint:')
exported.apply(ctx)
await new Promise((resolve) => setTimeout(resolve, 50))

ok('the plugin still arms its sidebar seat', registered === 1, `registered=${String(registered)}`)
ok('no overlay is left on screen', body.findAll('div').filter((el) => el.className.includes('dba-root')).length === 0)
ok('the console bridge is published anyway', typeof windowShim.__dshBootAnimation?.play === 'function')
ok(
  'the bridge reports that no application start was confirmed',
  windowShim.__dshBootAnimation?.appStart === false,
  String(windowShim.__dshBootAnimation?.appStart),
)
ok('the bridge reports no resolved clip', windowShim.__dshBootAnimation?.url === null)

// A manual play with nothing resolved must decline rather than open a black frame.
windowShim.__dshBootAnimation.play('manual')
await new Promise((resolve) => setTimeout(resolve, 20))
ok('a manual play with no clip does nothing', windowShim.__dshBootAnimation?.playing === false)

console.log('')
if (failures.length === 0) {
  console.log('all resilience checks passed')
  process.exit(0)
}
console.log(`${failures.length} resilience check(s) failed`)
process.exit(1)
