/**
 * verify-routes.mjs — route regression test for the host half.
 *
 * Why this exists: the host registers webserver routes, and the way the
 * webserver MATCHES them is not obvious. A prefix route is matched with
 *
 *   pathname !== prefix && !pathname.startsWith(`${prefix}/`)
 *
 * so registering `.../media/` (with a trailing slash) makes the matcher test
 * `.../media//`, which no real request ever starts with — every media URL 404s.
 * That shipped once. A hand-rolled probe using its own `startsWith(prefix)`
 * cannot see it, because the probe is not using the server's rule.
 *
 * So this file reproduces the server's exact rule (copied from
 * @deepseek-ai/dsh-host-webserver) and drives the real handlers through it.
 * Any route that only matches under a looser rule the server does not use will
 * fail here.
 *
 * Usage: node scripts/verify-routes.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Point the host half at a THROWAWAY harness home.
 *
 * `src/host.js` reads `process.env.DSH_HOME` lazily on every request, so setting it
 * before `apply` (and before any request) keeps this test away from the real
 * `~/.dsh/boot-animation/settings.json`. A regression test that rewrites the
 * operator's own configuration is worse than no regression test.
 */
const SANDBOX_HOME = mkdtempSync(join(tmpdir(), 'dsh-boot-animation-verify-'))
process.env.DSH_HOME = SANDBOX_HOME

// Imported AFTER the environment is set, so no module-level read can capture the
// real home. This is also why the import is not at the top of the file.
const { apply } = await import('../lib/index.js')

const BASE = '/dsh-boot-animation'

// --- capture registrations, mirroring the webserver's two tables ---
const exact = new Map()
const prefixes = new Map()
const ctx = {
  effect: (fn) => fn(),
  webServer: {
    register(route) {
      const table = route.kind === 'exact' ? exact : prefixes
      if (table.has(route.path)) throw new Error(`duplicate ${route.kind} route "${route.path}"`)
      table.set(route.path, route)
      return () => {}
    },
  },
}
apply(ctx)

/**
 * The webserver's own resolution: exact table first, then longest-prefix-wins.
 * Kept character-for-character in spirit with the shipped implementation.
 */
function resolve(pathname) {
  const hit = exact.get(pathname)
  if (hit !== undefined) return hit
  let best
  for (const [prefix, route] of prefixes) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) continue
    if (best === undefined || prefix.length > best.path.length) best = route
  }
  return best
}

/**
 * Drive one request through the resolved handler.
 *
 * Bodies are delivered the node:http way, which is what the host's `readBody` is
 * written against: it attaches `data`/`end` listeners, so a mock that answered
 * synchronously would never be observed. Events are therefore buffered here and
 * replayed when the handler subscribes.
 */
function call(rawUrl, method = 'GET', headers = {}, body) {
  return new Promise((done) => {
    const pathname = rawUrl.split('?')[0]
    const route = resolve(pathname)
    if (route === undefined) {
      done({ code: 404, note: 'NO ROUTE MATCHED' })
      return
    }
    const pending = []
    const listeners = new Map()
    const req = {
      method,
      url: rawUrl,
      headers,
      on(type, listener) {
        const list = listeners.get(type) ?? []
        list.push(listener)
        listeners.set(type, list)
        // Replay whatever arrived before this listener existed.
        for (const event of pending.splice(0)) {
          if (event.type === type) listener(event.payload)
        }
        return req
      },
      destroy() {},
    }
    // Text is kept for JSON routes; media bodies are only counted, so a 3MB
    // embedded clip never becomes a JS string in this harness.
    let text = ''
    let bytes = 0
    const res = {
      statusCode: 200,
      headers: {},
      write(chunk) {
        if (chunk === undefined) return true
        if (Buffer.isBuffer(chunk)) bytes += chunk.length
        else {
          const s = String(chunk)
          text += s
          bytes += Buffer.byteLength(s)
        }
        return true
      },
      on: () => {},
      once: () => {},
      emit: () => {},
      writeHead(code, headers2) {
        this.statusCode = code
        Object.assign(this.headers, headers2 ?? {})
      },
      end(payload) {
        if (payload !== undefined) {
          if (Buffer.isBuffer(payload)) bytes += payload.length
          else {
            const s = String(payload)
            text += s
            bytes += Buffer.byteLength(s)
          }
        }
        done({ code: this.statusCode, headers: this.headers, body: text === '' ? null : text, bytes })
      },
    }
    route.handler(req, res)
    if (body !== undefined) {
      const emit = (type, payload) => {
        const list = listeners.get(type)
        if (list === undefined || list.length === 0) {
          pending.push({ type, payload })
          return
        }
        for (const listener of list) listener(payload)
      }
      // A tick later, so the handler is always the one that attaches first.
      setTimeout(() => {
        emit('data', Buffer.from(String(body), 'utf8'))
        emit('end')
      }, 0)
    }
  })
}

/** A POST with a JSON body. */
const post = (url, payload) => call(url, 'POST', { 'content-type': 'application/json' }, JSON.stringify(payload))

const failures = []
const resources = {}
async function expect(url, want) {
  const r = await call(url)
  resources[url] = r
  const ok = r.code === want
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${url} -> ${r.code} (want ${want})${r.note === undefined ? '' : ' ' + r.note}`)
  if (!ok) failures.push(`${url} -> ${r.code} (want ${want})`)
  return r
}

/**
 * A failure must never be cacheable.
 *
 * A 404 with no cache directive is heuristically cacheable, so a route that
 * 404s once while broken keeps 404ing in that browser long after the fix: the
 * server answers 200 to curl and the user still sees nothing. Asserting it here
 * is the only way that stays true as routes are added.
 */
function expectNoStore(url) {
  const r = resources[url]
  if (r === undefined) {
    failures.push(`${url}: never requested, cannot check cacheability`)
    return
  }
  const value = r.headers?.['cache-control'] ?? ''
  const ok = String(value).includes('no-store')
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${url} cache-control: ${value === '' ? '(none)' : value}`)
  if (!ok) failures.push(`${url} answered ${r.code} without cache-control: no-store`)
}

console.log('registered exact   :', [...exact.keys()].join(' ') || '(none)')
console.log('registered prefixes:', [...prefixes.keys()].join(' '))

// A route registered as a prefix with a trailing slash can never match: this is
// the exact shape of the bug this file exists to catch.
for (const path of prefixes.keys()) {
  if (path.endsWith('/')) {
    failures.push(`prefix route "${path}" ends with "/" — the server matches "${path}/" and it will never fire`)
  }
}

/**
 * The built-in clips must be EMBEDDED, and must arrive with no media file on disk.
 *
 * This is the point of embedding them: nothing can be lost to a missing `files`
 * entry, a stale copy in an installed profile, or a container that shipped
 * without faststart. If a future change reintroduces a package media directory,
 * this check is what says so.
 */
console.log('\nembedded built-ins:')
{
  const r = await call(`${BASE}/videos.json`)
  const payload = JSON.parse(r.body ?? '{"videos":[]}')
  const builtins = (payload.videos ?? []).filter((v) => v.source === 'embedded')
  const okCount = builtins.length >= 2
  console.log(`  ${okCount ? 'ok  ' : 'FAIL'} ${builtins.length} embedded clip(s): ${builtins.map((v) => v.name).join(' / ') || '(none)'}`)
  if (!okCount) failures.push(`expected at least 2 embedded clips, found ${builtins.length}`)

  for (const clip of builtins) {
    if (clip.file !== null && clip.file !== undefined) {
      failures.push(`embedded clip ${clip.id} reports a file (${clip.file}); it must live in code only`)
    }
    if (clip.faststart !== true) failures.push(`embedded clip ${clip.id} is not marked faststart`)
    const media = await call(`${BASE}/media/${clip.id}`)
    const okBytes = media.code === 200 && media.bytes === clip.bytes
    console.log(
      `  ${okBytes ? 'ok  ' : 'FAIL'} /media/${clip.id} -> ${media.code}, ${media.bytes} bytes (declared ${clip.bytes})`,
    )
    if (!okBytes) failures.push(`${clip.id} served ${media.bytes} bytes, expected ${clip.bytes}`)

    const etag = media.headers?.etag
    if (typeof etag !== 'string' || !etag.includes('embedded-')) {
      failures.push(`${clip.id} etag is ${etag ?? '(none)'}; embedded clips must use a content-derived etag`)
    } else {
      const again = await call(`${BASE}/media/${clip.id}`, 'GET', { 'if-none-match': etag })
      if (again.code !== 304) failures.push(`${clip.id} ignored If-None-Match (${again.code}, want 304)`)
    }
  }
}

const list = JSON.parse((await expect(`${BASE}/videos.json`, 200)).body ?? '{"videos":[]}')
const ids = Array.isArray(list.videos) ? list.videos.map((v) => v.id) : []
console.log(`library: ${ids.length} video(s) — ${ids.join(', ')}`)

/**
 * The list must show DISTINCT clips, not distinct paths.
 *
 * A user who also keeps their own copy of a shipped clip saw it twice under two
 * different badges, which read as "the plugin does not have this clip". The list
 * collapses identical artifacts (size+mtime) and reports how many it merged, so
 * a hidden duplicate is visible in the payload rather than silent.
 */
{
  const seen = new Map()
  let ok = true
  for (const v of list.videos ?? []) {
    const identity = `${v.bytes}@${new Date(v.mtime).getTime()}`
    if (seen.has(identity)) {
      console.log(`  FAIL ${v.id} duplicates ${seen.get(identity)} (${v.bytes} bytes, ${v.mtime})`)
      failures.push(`two library rows share one artifact: ${v.id} and ${seen.get(identity)}`)
      ok = false
      continue
    }
    seen.set(identity, v.id)
  }
  const merged = (list.videos ?? []).filter((v) => (v.copies ?? 1) > 1)
  console.log(
    `  ${ok ? 'ok  ' : 'FAIL'} library has ${seen.size} distinct artifact(s)` +
      (merged.length > 0 ? `; merged duplicate(s): ${merged.map((v) => `${v.id}(x${v.copies})`).join(', ')}` : ''),
  )
  // A merged row must not claim to be a single path either.
  for (const v of merged) {
    if (!Array.isArray(v.alsoAt) || v.alsoAt.length === 0) {
      failures.push(`${v.id} advertises copies=${v.copies} but lists no alsoAt sources`)
    }
  }
}

await expect(`${BASE}/status.json`, 200)
await expect(`${BASE}/boot.mp4`, 200)
for (const id of ids) await expect(`${BASE}/media/${id}`, 200)
const missId = `${BASE}/media/definitely-not-an-id`
const noId = `${BASE}/media`
const slashId = `${BASE}/media/`
const wrongMethod = `${BASE}/select`
await expect(missId, 404)
await expect(noId, 404)
await expect(slashId, 404)
await expect(wrongMethod, 405) // GET on a POST-only endpoint
await expect(`${BASE}/nope.json`, 404)

console.log('\nuncacheable failures:')
for (const url of [missId, noId, slashId, wrongMethod]) expectNoStore(url)

/**
 * Media must be REUSABLE, not uncacheable.
 *
 * `no-store` on the video meant the browser could keep nothing, so every
 * overlay opening re-downloaded the whole clip and the splash sat black while
 * it did. The clip needs `no-cache` plus an ETag: a 304 reuses the local copy
 * (fast), and a swapped-in clip fails the comparison and streams fresh (correct).
 */
console.log('\nreusable media:')
{
  const url = `${BASE}/boot.mp4`
  const first = await call(url)
  const etag = first.headers?.etag
  const cache = String(first.headers?.['cache-control'] ?? '')
  const okEtag = typeof etag === 'string' && etag.length > 2
  const okCache = cache.includes('no-cache') && !cache.includes('no-store')
  console.log(`  ${okEtag ? 'ok  ' : 'FAIL'} ${url} etag: ${etag ?? '(none)'}`)
  console.log(`  ${okCache ? 'ok  ' : 'FAIL'} ${url} cache-control: ${cache === '' ? '(none)' : cache}`)
  if (!okEtag) failures.push(`${url} has no ETag, so nothing can be reused`)
  if (!okCache) failures.push(`${url} cache-control is "${cache}" — it must allow revalidated reuse`)

  if (okEtag) {
    const second = await call(url, 'GET', { 'if-none-match': etag })
    const ok304 = second.code === 304
    console.log(`  ${ok304 ? 'ok  ' : 'FAIL'} ${url} with If-None-Match -> ${second.code} (want 304)`)
    if (!ok304) failures.push(`${url} ignored If-None-Match (got ${second.code}, want 304) — replay would refetch`)
  }
}

/**
 * A cached clip must never be served for a DIFFERENT clip.
 *
 * This is the failure the user actually hit, read the other way round: with a
 * revalidating cache, a stale ETag accepted for the newly selected clip would
 * pin the overlay to the old video no matter how many times you refresh. Checked
 * across every library entry (via /media/<id>, so the run never rewrites the
 * user's selection file), asserting that different artifacts carry different
 * validators and that a foreign ETag is refused.
 *
 * The ETag is size+mtime, so two byte-identical copies DO share one — and that
 * is correct, not a collision: a 304 hands back the same bytes either way. The
 * assertion is therefore "distinct (size, mtime) implies distinct ETag", not
 * "all ETags differ".
 */
console.log('\nrevalidation across clips:')
{
  const etagById = new Map()
  for (const id of ids) {
    const r = await call(`${BASE}/media/${id}`)
    etagById.set(id, r.headers?.etag)
  }

  const etagByArtifact = new Map()
  let everyEtag = true
  for (const v of list.videos ?? []) {
    const e = etagById.get(v.id)
    if (typeof e !== 'string' || e.length < 3) everyEtag = false
    etagByArtifact.set(`${v.bytes}@${v.mtime}`, e)
  }
  const artifacts = [...etagByArtifact.keys()].length
  const validators = new Set([...etagByArtifact.values()])
  const okDistinct = everyEtag && validators.size === artifacts
  console.log(
    `  ${okDistinct ? 'ok  ' : 'FAIL'} ${ids.length} clip(s), ${artifacts} distinct artifact(s) -> ${validators.size} ETag(s)` +
      (okDistinct ? '' : ' — different artifacts share a validator, so the wrong video could be served'),
  )
  if (!okDistinct) failures.push('distinct artifacts do not have distinct ETags')

  // Two entries whose bytes differ: a stale validator must not be honoured.
  const pairs = []
  for (const a of list.videos ?? []) {
    for (const b of list.videos ?? []) {
      if (a.id !== b.id && a.bytes !== b.bytes) pairs.push([a.id, b.id])
    }
  }
  if (pairs.length > 0 && okDistinct) {
    const [a, b] = pairs[0]
    const r = await call(`${BASE}/media/${b}`, 'GET', { 'if-none-match': etagById.get(a) })
    const ok200 = r.code === 200
    console.log(`  ${ok200 ? 'ok  ' : 'FAIL'} /media/${b} with ${a}'s ETag -> ${r.code} (want 200)`)
    if (!ok200) {
      failures.push(`a foreign ETag was accepted for ${b} (got ${r.code}) — refresh would keep the old video`)
    }
  } else if (pairs.length === 0) {
    console.log('  skip  only one distinct clip present; cross-clip check needs two')
  }
}

/**
 * The settings and play-state routes.
 *
 * These are the routes that make the plugin configurable, and they are the ones a
 * user's own `settings.json` lives in - hence the throwaway DSH_HOME at the top of
 * this file. What is asserted: the plan carries a boot id and every clip's URL, a
 * settings PATCH merges instead of replacing, out-of-range values are clamped rather
 * than rejected, unknown keys are dropped, the legacy select file stays in step, the
 * play counter only moves when the page says so, and a reset cannot be made to
 * discard settings by accident.
 */
console.log('\nsettings and play state:')
{
  const plan = JSON.parse((await call(`${BASE}/plan.json`)).body ?? '{}')
  const okBootId = typeof plan.bootId === 'string' && plan.bootId.length >= 8
  console.log(`  ${okBootId ? 'ok  ' : 'FAIL'} /plan.json carries a host boot id: ${String(plan.bootId)}`)
  if (!okBootId) failures.push('the plan must carry a boot id; without it every page load looks like an app start')

  const curated = plan.clipUrls ?? {}
  const everyClip = ids.every((id) => typeof curated[id] === 'string' && curated[id].includes('/media/'))
  console.log(
    `  ${everyClip ? 'ok  ' : 'FAIL'} /plan.json maps every one of ${ids.length} clip(s) to a media URL`,
  )
  if (!everyClip) failures.push('the plan must map every clip id to a media URL, or a per-trigger clip cannot resolve')

  const okDefaults = plan.settings?.frequency === 'every' && plan.settings?.enabled === true
  console.log(
    `  ${okDefaults ? 'ok  ' : 'FAIL'} /plan.json carries settings (enabled=${String(plan.settings?.enabled)}, frequency=${String(plan.settings?.frequency)})`,
  )
  if (!okDefaults) failures.push('the plan must carry the resolved settings')

  const okAppStart = Array.isArray(plan.settings?.triggers) && plan.settings.triggers.includes('appStart')
  console.log(
    `  ${okAppStart ? 'ok  ' : 'FAIL'} the default trigger set includes appStart: ${JSON.stringify(plan.settings?.triggers)}`,
  )
  if (!okAppStart) failures.push('appStart must be a default trigger; it is the feature this plugin exists for')

  // A PATCH merges: one key changes, the rest must survive.
  const before = JSON.parse((await call(`${BASE}/settings.json`)).body ?? '{}').settings
  const patched = JSON.parse((await post(`${BASE}/settings.json`, { title: '冒烟测试' })).body ?? '{}')
  const okMerge = patched.settings?.title === '冒烟测试' && patched.settings?.frequency === before.frequency
  console.log(`  ${okMerge ? 'ok  ' : 'FAIL'} a settings PATCH merges instead of replacing`)
  if (!okMerge) failures.push('a settings PATCH must merge; replacing would discard every untouched key')

  // Out of range clamps, and unknown keys are dropped.
  const clamped = JSON.parse((await post(`${BASE}/settings.json`, { delayMs: 999999, nonsense: true })).body ?? '{}')
  const okClamp = clamped.settings?.delayMs === 10000 && clamped.settings?.nonsense === undefined
  console.log(`  ${okClamp ? 'ok  ' : 'FAIL'} out-of-range values clamp and unknown keys are dropped (delayMs=${String(clamped.settings?.delayMs)})`)
  if (!okClamp) failures.push('delayMs must clamp to its declared maximum and unknown keys must not persist')

  // A malformed trigger list is filtered, not trusted.
  const badTriggers = JSON.parse(
    (await post(`${BASE}/settings.json`, { triggers: ['appStart', 'not-a-trigger'] })).body ?? '{}',
  )
  const okTriggers =
    JSON.stringify(badTriggers.settings?.triggers) === JSON.stringify(['appStart'])
  console.log(`  ${okTriggers ? 'ok  ' : 'FAIL'} unknown trigger names are dropped: ${JSON.stringify(badTriggers.settings?.triggers)}`)
  if (!okTriggers) failures.push('an unknown trigger name must be dropped rather than stored')

  // A bad body is a 400, and never a 500 from an unhandled throw.
  const badBody = await call(`${BASE}/settings.json`, 'POST', {}, 'not json')
  console.log(`  ${badBody.code === 400 ? 'ok  ' : 'FAIL'} a non-JSON body -> ${badBody.code} (want 400)`)
  if (badBody.code !== 400) failures.push(`a non-JSON settings body answered ${badBody.code}, want 400`)

  const getOnly = await call(`${BASE}/reset`, 'GET')
  console.log(`  ${getOnly.code === 405 ? 'ok  ' : 'FAIL'} GET /reset -> ${getOnly.code} (want 405)`)
  if (getOnly.code !== 405) failures.push(`GET /reset answered ${getOnly.code}, want 405`)

  // Selecting a clip keeps the historical file in step, so a rollback still sees it.
  const pick = JSON.parse((await post(`${BASE}/select`, { id: ids[1] })).body ?? '{}')
  const state = JSON.parse((await call(`${BASE}/status.json`)).body ?? '{}')
  const okPick = pick.ok === true && state.settings?.clipId === ids[1] && state.active?.id === ids[1]
  console.log(`  ${okPick ? 'ok  ' : 'FAIL'} POST /select updates settings and the active clip (${String(state.active?.id)})`)
  if (!okPick) failures.push('POST /select must update both settings.json and the resolved active clip')

  const unknown = await post(`${BASE}/select`, { id: 'nope' })
  console.log(`  ${unknown.code === 404 ? 'ok  ' : 'FAIL'} POST /select with an unknown id -> ${unknown.code} (want 404)`)
  if (unknown.code !== 404) failures.push(`an unknown select id answered ${unknown.code}, want 404`)

  // The play counter moves only when the page reports a play.
  const runsBefore = JSON.parse((await call(`${BASE}/status.json`)).body ?? '{}').state?.runs ?? 0
  const played = JSON.parse((await post(`${BASE}/state`, { clipId: ids[0], conversationId: 'conv-1' })).body ?? '{}')
  const okRuns = played.state?.runs === runsBefore + 1 && typeof played.state?.ranAt === 'string'
  console.log(`  ${okRuns ? 'ok  ' : 'FAIL'} POST /state records a play (runs ${String(runsBefore)} -> ${String(played.state?.runs)})`)
  if (!okRuns) failures.push('POST /state must increment the run counter and stamp the time from the server clock')

  // frequency=once must stop the intro, and reset must restore it.
  await post(`${BASE}/settings.json`, { frequency: 'once' })
  const afterReset = JSON.parse((await post(`${BASE}/reset`, { what: 'state' })).body ?? '{}')
  const okReset = afterReset.ok === true && afterReset.state?.runs === 0 && afterReset.state?.ranAt === null
  console.log(`  ${okReset ? 'ok  ' : 'FAIL'} POST /reset clears the play history`)
  if (!okReset) failures.push('POST /reset must clear the play history')

  const keptSettings = afterReset.settings?.frequency === 'once'
  console.log(`  ${keptSettings ? 'ok  ' : 'FAIL'} POST /reset keeps the settings (frequency=${String(afterReset.settings?.frequency)})`)
  if (!keptSettings) failures.push('a state reset must not touch the user settings')

  // `all` is the deliberate wide reset, and it must restore the shipped defaults.
  const wiped = JSON.parse((await post(`${BASE}/reset`, { what: 'all' })).body ?? '{}')
  const okAll = wiped.ok === true && wiped.settings?.frequency === 'every' && wiped.settings?.title === ''
  console.log(`  ${okAll ? 'ok  ' : 'FAIL'} POST /reset {what:"all"} restores the defaults (frequency=${String(wiped.settings?.frequency)})`)
  if (!okAll) failures.push('a full reset must restore the shipped defaults')

  const badWhat = await post(`${BASE}/reset`, { what: 'everything' })
  console.log(`  ${badWhat.code === 400 ? 'ok  ' : 'FAIL'} POST /reset with an unknown scope -> ${badWhat.code} (want 400)`)
  if (badWhat.code !== 400) failures.push(`an unknown reset scope answered ${badWhat.code}, want 400`)

  // A GET on the settings route is the panel's read path, not a 405.
  const readSettings = await call(`${BASE}/settings.json`)
  const okRead = readSettings.code === 200 && JSON.parse(readSettings.body ?? '{}').settings !== undefined
  console.log(`  ${okRead ? 'ok  ' : 'FAIL'} GET /settings.json returns the panel payload (${readSettings.code})`)
  if (!okRead) failures.push('GET on the settings route must return the panel payload')
}

console.log('')
if (failures.length === 0) {
  console.log('all route checks passed')
  rmSync(SANDBOX_HOME, { recursive: true, force: true })
  process.exit(0)
}
console.log(`${failures.length} route check(s) failed:`)
for (const f of failures) console.log('  - ' + f)
rmSync(SANDBOX_HOME, { recursive: true, force: true })
process.exit(1)
