/**
 * dsh-boot-animation - host half.
 *
 * Plain JavaScript with no DSH SDK imports, so it needs no compiler and no DSH
 * source checkout: `scripts/build.sh` copies this file to lib/index.js.
 *
 * It serves the intro video plus the settings that decide WHEN that video plays.
 * The decisions themselves run in the browser (only the page knows about
 * conversations), so this half owns three things: the clip library, the settings
 * file, and the play-state file the browser reports back to.
 *
 * 1. Range requests. Browsers issue them for media, and a video element that
 *    gets a 200 where it expected 206 sometimes refuses to play at all.
 *
 * 2. A LIBRARY, not a single slot. Every clip in every source is listed, the
 *    user picks one in the UI, and the choice is remembered. The historical
 *    three-level priority is kept as the fallback when nothing has been picked,
 *    so an existing drop-in (`$DSH_HOME/boot-animation/intro.mp4`) keeps working
 *    untouched.
 *
 * 3. The clips the plugin ships are EMBEDDED IN CODE, not files. There is no
 *    `assets/boot.mp4` or `videos/*.mp4` to lose, be filtered out of the package,
 *    or be shipped with the wrong container flags. `lib/clips.meta.js` carries
 *    the names and sizes; `lib/clips.data.js` carries the base64 bytes and is
 *    imported LAZILY, so the host does not parse ~8MB it may never need.
 *    A user's own files still work exactly as before and still win.
 *
 * 4. Everything is resolved PER REQUEST, so a user can drop in their own file
 *    without restarting DSH.
 *
 * Layout:
 *   $DSH_HOME/boot-animation/settings.json   animation settings (written by us)
 *   $DSH_HOME/boot-animation/selection.json  legacy pick file, still mirrored
 *   $DSH_HOME/boot-animation/state.json      when it last played (written by us)
 *   $DSH_HOME/boot-animation/videos/*.mp4    user library (drop-in)
 *   $DSH_HOME/boot-animation/intro.mp4       legacy drop-in, still honoured
 *   lib/clips.meta.js + lib/clips.data.js    the embedded built-in clips
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLIPS } from './clips.meta.js'
import {
  DEFAULT_SETTINGS,
  SETTINGS_LIMITS,
  mergeSettings,
  normalizeState,
} from './settings.shared.mjs'

export const name = 'dsh-boot-animation'

/** The webserver routes are the only host service this plugin needs. */
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))

const BASE_ROUTE = '/dsh-boot-animation'
const ROUTE = BASE_ROUTE + '/boot.mp4'
/**
 * NO trailing slash. The webserver matches a prefix route with
 *   pathname !== prefix && !pathname.startsWith(prefix + '/')
 * so a registered path of `.../media/` would be tested as
 * `.../media//` and never match a real `.../media/<id>` request 鈥?every
 * media URL 404s. Keep this bare and add the separator at slice time.
 */
const MEDIA_ROUTE = BASE_ROUTE + '/media'
const LIST_ROUTE = BASE_ROUTE + '/videos.json'
const SELECT_ROUTE = BASE_ROUTE + '/select'
const STATUS_ROUTE = BASE_ROUTE + '/status.json'
const SETTINGS_ROUTE = BASE_ROUTE + '/settings.json'
const STATE_ROUTE = BASE_ROUTE + '/state'
const RESET_ROUTE = BASE_ROUTE + '/reset'
const PLAN_ROUTE = BASE_ROUTE + '/plan.json'
const CONTENT_TYPE = 'video/mp4'
/** Upper bound on a settings POST body. Nothing here is big enough to need more. */
const MAX_BODY_BYTES = 32768

/** Extensions treated as video for listing purposes. */
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov', '.mkv'])

/**
 * Which copy survives when the same clip exists in more than one place.
 * Lower wins, so the plugin's own copy beats a user's duplicate.
 */
const SOURCE_RANK = { embedded: 0, yours: 2, env: 3 }

/** Display order in the picker: the plugin's clips first, the user's after. */
const LIST_RANK = { embedded: 0, yours: 2, env: 3 }

/** Ids of the embedded clips are namespaced so they can never collide with a path. */
const EMBEDDED_PREFIX = 'builtin:'

/**
 * Decoded embedded clips, filled on first use.
 *
 * `clips.data.js` is ~8MB of base64. Importing it eagerly would make every DSH
 * start pay for a video it may never serve, so it is imported on the first
 * request for an embedded clip and the decoded Buffers are kept afterwards.
 */
const decoded = new Map()
let dataModule = null

async function embeddedBuffer(id) {
  const cached = decoded.get(id)
  if (cached !== undefined) return cached
  if (dataModule === null) dataModule = await import('./clips.data.js')
  for (const clip of CLIPS) {
    if (decoded.has(clip.id)) continue
    const b64 = dataModule[clip.id]
    if (typeof b64 === 'string') decoded.set(clip.id, Buffer.from(b64, 'base64'))
  }
  return decoded.get(id) ?? null
}

/**
 * This host process's identity, generated once per DeepSeek Harness launch.
 *
 * It exists so the PAGE can tell "the application just started" from "someone
 * reloaded the page": the host process lives exactly as long as one application
 * session, so an id it has never seen before means a new launch. Random rather
 * than time-based, because two starts inside the same millisecond must still be
 * two different ids.
 */
const BOOT_ID = randomUUID()

const HOME = () => process.env.DSH_HOME ?? join(homedir(), '.dsh')
const HOME_DIR = () => join(HOME(), 'boot-animation')
const SELECTION_FILE = () => join(HOME_DIR(), 'selection.json')
const SETTINGS_FILE = () => join(HOME_DIR(), 'settings.json')
const STATE_FILE = () => join(HOME_DIR(), 'state.json')

/**
 * Display names are only needed for files the plugin itself ships, and it no
 * longer ships any: both built-in clips are embedded and carry their names in
 * `clips.meta.js`. A file the user dropped in keeps its own name, because the
 * plugin cannot know what it contains.
 */
function displayName(_source, fileName) {
  return basename(fileName, extname(fileName))
}

/**
 * Managed directories: what the USER adds. The plugin's own clips are embedded
 * in code now, so there is no package directory to scan 鈥?nothing can be lost to
 * a missing `files` entry or a stale copy in an install.
 */
function scanDirs() {
  return [
    { source: 'yours', dir: join(HOME_DIR(), 'videos'), writable: true },
    { source: 'yours', dir: HOME_DIR(), writable: true },
  ]
}

function statFile(p) {
  try {
    const s = statSync(p)
    return s.isFile() && s.size > 0 ? s : null
  } catch {
    return null
  }
}

/**
 * Whether the `moov` atom sits in the head of the file.
 *
 * This is the difference between a video that starts playing immediately and
 * one that shows nothing until the whole file has been downloaded 鈥?and the
 * client gives up on a stalled clip (stallTimeoutMs), so an un-optimised mp4
 * reads to a user as "the video will not load". Cheap to test: read the first
 * 64KB and look for `moov`. An optimised file puts it within the first few
 * hundred bytes; an un-optimised one has only `ftyp`/`mdat` up there.
 *
 * Reported, never enforced: a `.webm` or an exotic container has no `moov` at
 * all and is not something to warn about, so `false` here means "not known to
 * be optimised", and the UI only nudges on `.mp4`/`.m4v`.
 */
function hasFaststart(filePath) {
  const HEAD = 65536
  let fd = null
  try {
    fd = openSync(filePath, 'r')
    const buffer = Buffer.alloc(HEAD)
    const read = readSync(fd, buffer, 0, HEAD, 0)
    const head = buffer.subarray(0, read).toString('latin1')
    const moov = head.indexOf('moov')
    if (moov === -1) return false
    const mdat = head.indexOf('mdat')
    return mdat === -1 || moov < mdat
  } catch {
    return false
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Content identity of a file, cached against (size, mtime).
 *
 * Needed so a user's copy of a built-in clip collapses into the built-in row.
 * Embedding made this exact rather than heuristic: the embedded clips carry
 * their real sha256, and size+mtime alone would miss a copy that was re-saved.
 * Hashing a few megabytes costs milliseconds and happens once per distinct file
 * per process, because the result is memoised on the stat that produced it.
 */
const contentKeys = new Map()

function contentKeyOf(filePath, stats) {
  const stamp = `${stats.size}@${Math.round(stats.mtimeMs)}`
  const cached = contentKeys.get(filePath)
  if (cached !== undefined && cached.stamp === stamp) return cached.key
  let key = `size:${stats.size}`
  try {
    key = createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 16)
  } catch {
    /* unreadable: fall back to a size-only key, which at worst merges equals */
  }
  contentKeys.set(filePath, { stamp, key })
  return key
}

/** Stable, URL-safe id for a path. Deterministic across processes (no hash lib). */
function makeId(p) {
  let h = 0x811c9dc5
  const normalised = p.replace(/\\/g, '/').toLowerCase()
  for (let i = 0; i < normalised.length; i += 1) {
    h ^= normalised.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  const stem = basename(p, extname(p))
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return (stem || 'video') + '-' + h.toString(16).padStart(8, '0')
}

function readFileSyncSafe(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

/**
 * Replace one small JSON file atomically-ish.
 *
 * A half-written settings.json would silently reset every choice the user made,
 * so the payload lands in a sibling temp file and is renamed over the target.
 */
function writeJsonFile(target, value) {
  mkdirSync(dirname(target), { recursive: true })
  const payload = JSON.stringify(value, null, 2) + '\n'
  const tmp = target + '.tmp'
  writeFileSync(tmp, payload, 'utf8')
  try {
    renameSync(tmp, target)
  } catch {
    writeFileSync(target, payload, 'utf8')
  }
}

function readJsonFile(target) {
  const raw = readFileSyncSafe(target)
  if (raw === null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** The historical single-id pick file, still read so a downgrade keeps the pick. */
function readSelection() {
  const parsed = readJsonFile(SELECTION_FILE())
  return typeof parsed?.id === 'string' && parsed.id !== '' ? parsed.id : null
}

/**
 * Mirror the pick into the legacy file.
 *
 * `null` is a real value here 鈥?it means "no pick", which is what a reset
 * stores 鈥?so it is written through rather than skipped.
 */
function writeSelection(id) {
  writeJsonFile(SELECTION_FILE(), { id: id ?? null, at: new Date().toISOString() })
}

/**
 * The animation settings, defaults filled in.
 *
 * `settings.json` is the single place the client writes configuration through
 * the POST route; an existing `selection.json` is migrated into it on first read
 * so an install that already picked a clip keeps that clip.
 */
function readSettings() {
  const raw = readJsonFile(SETTINGS_FILE()) ?? {}
  const settings = mergeSettings(raw)
  if (settings.clipId === null) {
    const legacy = readSelection()
    if (legacy !== null) settings.clipId = legacy
  }
  return settings
}

/** Validate and persist a patch; returns the settings actually stored. */
function writeSettingsPatch(patch) {
  const current = readSettings()
  const next = mergeSettings({ ...current, ...patch }, current)
  writeJsonFile(SETTINGS_FILE(), next)
  return next
}

/** Play-state: when the intro last ran, and how many times. */
function readState() {
  return normalizeState(readJsonFile(STATE_FILE()))
}

function writeState(patch) {
  const current = readState()
  const next = normalizeState({ ...current, ...patch })
  writeJsonFile(STATE_FILE(), next)
  return next
}

/**
 * Every distinct clip the plugin can play: the embedded built-ins plus whatever
 * the user has dropped in.
 *
 * Two de-duplications happen here, and both exist because the picker was showing
 * more rows than there were videos:
 *
 * 1. By real path, so `intro.mp4` is not listed twice (its directory is also a
 *    scan root).
 * 2. By CONTENT, so one clip is one row no matter how many copies of it exist.
 *    This is the case that actually confused a user: a copy of a built-in clip
 *    sat beside the built-in itself, under a different badge, and it read as
 *    "these are not the same kind of thing".
 *
 *    Identity is a content hash, not size+mtime. Embedded clips carry their
 *    sha256 in the metadata, and a file's hash is computed once and cached
 *    against (size, mtime) 鈥?so an exact duplicate is recognised even when its
 *    mtime differs, which size+mtime could not do.
 *
 *    When copies collide the EMBEDDED entry wins: it cannot be deleted or lost,
 *    so a selection pointing at it always resolves. The user's file stays where
 *    it is 鈥?collapsed in the LIST, never on disk.
 */
function listVideos() {
  const seen = new Set()
  const found = []

  for (const clip of CLIPS) {
    found.push({
      id: EMBEDDED_PREFIX + clip.id,
      name: clip.name,
      file: null,
      ext: clip.ext,
      source: 'embedded',
      writable: false,
      bytes: clip.bytes,
      mtimeMs: 0,
      mtime: null,
      legacy: false,
      // Guaranteed at embed time: scripts/embed-clips.mjs refuses a clip whose
      // moov is not already in front.
      faststart: true,
      path: null,
      embedded: clip.id,
      contentKey: clip.sha256,
      copies: 1,
      alsoAt: [],
    })
  }

  for (const { source, dir, writable } of scanDirs()) {
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const fileName of names) {
      const ext = extname(fileName).toLowerCase()
      if (!VIDEO_EXT.has(ext)) continue
      const full = join(dir, fileName)
      const key = full.replace(/\\/g, '/').toLowerCase()
      if (seen.has(key)) continue
      const stats = statFile(full)
      if (stats === null) continue
      seen.add(key)
      found.push({
        id: makeId(full),
        name: displayName(source, fileName),
        file: fileName,
        ext,
        source,
        writable,
        bytes: stats.size,
        mtimeMs: stats.mtimeMs,
        mtime: new Date(stats.mtimeMs).toISOString(),
        legacy: fileName.toLowerCase() === 'intro.mp4',
        faststart: hasFaststart(full),
        path: full,
        embedded: null,
        contentKey: contentKeyOf(full, stats),
        copies: 1,
        alsoAt: [],
      })
    }
  }

  const byContent = new Map()
  for (const video of found) {
    const kept = byContent.get(video.contentKey)
    if (kept === undefined) {
      byContent.set(video.contentKey, video)
      continue
    }
    const keepNew = (SOURCE_RANK[video.source] ?? 9) < (SOURCE_RANK[kept.source] ?? 9)
    const winner = keepNew ? video : kept
    const loser = keepNew ? kept : video
    winner.copies += loser.copies
    winner.alsoAt.push(loser.source, ...loser.alsoAt)
    byContent.set(video.contentKey, winner)
  }

  const out = [...byContent.values()]
  out.sort((a, b) => {
    const bySource = (LIST_RANK[a.source] ?? 9) - (LIST_RANK[b.source] ?? 9)
    if (bySource !== 0) return bySource
    // Keep the embedded clips in the order they were embedded.
    if (a.source === 'embedded' && b.source === 'embedded') {
      return (
        CLIPS.findIndex((c) => EMBEDDED_PREFIX + c.id === a.id) -
        CLIPS.findIndex((c) => EMBEDDED_PREFIX + c.id === b.id)
      )
    }
    return b.mtimeMs - a.mtimeMs
  })
  return out
}

/**
 * Which video plays when nothing has been picked.
 *
 * An explicit pick wins; otherwise the historical three-level priority, so
 * nothing that worked before stops working.
 */
function resolveActive() {
  const videos = listVideos()
  const picked = readSettings().clipId
  if (picked !== null) {
    const hit = videos.find((v) => v.id === picked)
    if (hit) return { video: hit, how: 'selected', videos }
    // Picked file was deleted: fall through rather than show nothing.
  }

  const fromEnv = process.env.DSH_BOOT_ANIMATION
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') {
    const candidates = videos.find((v) => v.path === fromEnv.trim())
    if (candidates) return { video: candidates, how: 'env', videos }
    const stats = statFile(fromEnv.trim())
    if (stats !== null) {
      return {
        video: {
          id: makeId(fromEnv.trim()),
          name: basename(fromEnv.trim(), extname(fromEnv.trim())),
          file: basename(fromEnv.trim()),
          ext: extname(fromEnv.trim()).toLowerCase(),
          source: 'env',
          writable: false,
          bytes: stats.size,
          mtimeMs: stats.mtimeMs,
          mtime: new Date(stats.mtimeMs).toISOString(),
          legacy: false,
          faststart: hasFaststart(fromEnv.trim()),
          path: fromEnv.trim(),
          embedded: null,
          contentKey: contentKeyOf(fromEnv.trim(), stats),
          copies: 1,
          alsoAt: [],
        },
        how: 'env',
        videos,
      }
    }
  }

  const legacyDropIn = videos.find((v) => v.source === 'yours' && v.legacy)
  if (legacyDropIn) return { video: legacyDropIn, how: 'legacy-dropin', videos }

  const yours = videos.find((v) => v.source === 'yours')
  if (yours) return { video: yours, how: 'library', videos }

  // Nothing of the user's: the plugin's own clips. These are embedded, so this
  // can never come up empty 鈥?which is the point of embedding them.
  const embedded = videos.find((v) => v.source === 'embedded')
  if (embedded) return { video: embedded, how: 'embedded', videos }

  return { video: null, how: 'none', videos }
}

function findById(id) {
  if (id === 'active') return resolveActive().video
  return listVideos().find((v) => v.id === id) ?? null
}

function sendJson(res, payload, status = 200) {
  const body = JSON.stringify(payload, null, 2)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Plain-text reply, always uncacheable.
 *
 * Every failure path has to say `no-store`. A 404 with no cache directive is
 * heuristically cacheable, so a route that 404s once while it is broken keeps
 * 404ing in that browser AFTER the fix 鈥?the server returns 200 and the user
 * still sees nothing. That is exactly how "the video will not play" survived a
 * fix that curl proved was live.
 */
function sendText(res, status, body) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

function publicVideo(v, extra = {}) {
  return {
    id: v.id,
    name: v.name,
    file: v.file,
    ext: v.ext,
    source: v.source,
    writable: v.writable,
    embedded: v.embedded ?? null,
    bytes: v.bytes,
    mtime: v.mtime,
    legacy: v.legacy,
    faststart: v.faststart === true,
    /**
     * The clip's content identity, so a client can pin it into the media URL as
     * `?v=`. A bare URL must revalidate on every play (correct but slow); a
     * versioned one can be cached forever. It is also what stops a browser from
     * splicing bytes served under the same URL before and after a clip changed.
     */
    version: v.contentKey ?? null,
    // How many on-disk copies collapsed into this row, and where the others
    // live. Reported so a collapsed duplicate is visible rather than mysterious.
    copies: v.copies ?? 1,
    alsoAt: v.alsoAt ?? [],
    ...extra,
  }
}

/**
 * The `?v=<contentKey>` suffix for a media URL, or an empty string.
 *
 * One helper so every generated URL - the single active route, the per-clip media
 * route, and the plan's per-trigger clips - pins the content key the same way. A
 * URL without it can only revalidate; a URL with it may be cached forever, which
 * is what makes the second play of an unchanged clip instant.
 */
function query(version) {
  return typeof version === 'string' && version !== '' ? '?v=' + encodeURIComponent(version) : ''
}

/**
 * One clip as the settings panel wants it: id, label and the media URL to play.
 *
 * The URL pins the content key, so a preview is never served from a cache entry
 * that belongs to a different set of bytes.
 */
function previewEntry(v) {
  const version = v.contentKey ?? null
  return {
    id: v.id,
    name: v.name,
    source: v.source,
    bytes: v.bytes,
    version,
    urls: {
      media: MEDIA_ROUTE + '/' + encodeURIComponent(v.id) + query(version),
      active: ROUTE + query(version),
    },
  }
}

/** Everything the panel needs to render itself in one request. */
function serveConfig(res) {
  const { video, how, videos } = resolveActive()
  sendJson(res, {
    settings: readSettings(),
    state: readState(),
    active:
      video === null
        ? null
        : { id: video.id, name: video.name, how, version: video.contentKey ?? null },
    clips: videos.map(previewEntry),
    videos: videos.map((v) => publicVideo(v, { active: video !== null && v.id === video.id })),
    userDir: join(HOME_DIR(), 'videos'),
    settingsFile: SETTINGS_FILE(),
    stateFile: STATE_FILE(),
    accepts: [...VIDEO_EXT],
    limits: SETTINGS_LIMITS,
    defaults: DEFAULT_SETTINGS,
  })
}

function serveList(res) {
  const { video, how, videos } = resolveActive()
  sendJson(res, {
    activeId: video === null ? null : video.id,
    activeHow: how,
    activeVersion: video === null ? null : video.contentKey ?? null,
    videos: videos.map((v) => publicVideo(v, { active: video !== null && v.id === video.id })),
    userDir: join(HOME_DIR(), 'videos'),
    accepts: [...VIDEO_EXT],
  })
}

function serveStatus(res) {
  // Deliberately reports WHICH slot is active without echoing absolute paths
  // back to anything that can reach this port.
  const { video, how, videos } = resolveActive()
  sendJson(res, {
    active:
      video === null
        ? null
        : {
            kind: how,
            id: video.id,
            name: video.name,
            bytes: video.bytes,
            version: video.contentKey ?? null,
          },
    count: videos.length,
    videos: videos.map((v) => publicVideo(v, { active: video !== null && v.id === video.id })),
    settings: readSettings(),
    state: readState(),
    // Legacy fields, kept because README and older probes read them.
    candidates: [
      { kind: 'selection', exists: readSettings().clipId !== null, bytes: 0 },
      { kind: 'library', exists: videos.length > 0, bytes: videos.length },
      {
        kind: 'embedded',
        exists: CLIPS.length > 0,
        bytes: CLIPS.reduce((total, clip) => total + clip.bytes, 0),
      },
    ],
    lookupOrder:
      'settings.json clipId -> DSH_BOOT_ANIMATION -> $DSH_HOME/boot-animation/intro.mp4 -> ' +
      '$DSH_HOME/boot-animation/videos -> embedded built-ins',
  })
}

/**
 * Identity of one on-disk cut, for conditional requests.
 *
 * Size plus mtime is enough: a file the user replaces differs in at least one of
 * them, and both are free (no read, no hash of a 3MB file per request).
 */
function etagOf(stats) {
  return '"' + stats.size.toString(16) + '-' + Math.round(stats.mtimeMs).toString(16) + '"'
}

/**
 * Which `cache-control` a media response may carry.
 *
 * A bare URL can only revalidate: `no-cache` means "keep it, but ask before
 * using", so an unchanged clip answers 304 and playback starts from the local
 * copy, while a clip the user just swapped in fails the comparison and streams
 * fresh. Correct, but it costs a round trip per play and it leaves the browser
 * free to splice ranges served before and after the bytes changed 鈥?which shows
 * up as a video that never paints.
 *
 * A URL that PINS the content key (`?v=<contentKey>`) cannot go stale: the key
 * changes whenever the bytes do, so the old URL is simply a different resource.
 * That one may be cached forever, which is what makes a replay start without a
 * single request.
 *
 * `no-store` used to be here, the worst of both worlds for media: the browser
 * could not keep a byte, so every overlay opening re-downloaded the whole clip
 * and the splash sat black while it did.
 */
function cacheControlFor(req, version) {
  if (typeof version === 'string' && version !== '') {
    const raw = typeof req.url === 'string' ? req.url : ''
    const query = raw.indexOf('?')
    if (query !== -1) {
      try {
        if (new URLSearchParams(raw.slice(query + 1)).get('v') === version) {
          return 'public, max-age=31536000, immutable'
        }
      } catch {
        /* malformed query: fall through to revalidation */
      }
    }
  }
  return 'no-cache'
}

/**
 * Serve media bytes with Range support and content-addressed caching.
 *
 * `open(start, end)` yields the body for the resolved slice, either a Buffer
 * (embedded clips) or a Readable (files), so this one routine covers both.
 */
function sendMedia(req, res, { size, etag, lastModified, version = null, open }) {
  const validators = {}
  if (etag !== null) validators.etag = etag
  if (lastModified !== null) validators['last-modified'] = lastModified
  const cacheControl = cacheControlFor(req, version)

  if (etag !== null) {
    const inm = req.headers['if-none-match']
    const matched =
      typeof inm === 'string' &&
      inm
        .split(',')
        .map((s) => s.trim())
        .some((candidate) => candidate === etag || candidate === '*')
    if (matched) {
      // The body the browser already has is still current.
      res.writeHead(304, { ...validators, 'cache-control': cacheControl })
      res.end()
      return
    }
  }

  const body = (start, end) => {
    const chunk = open(start, end)
    if (Buffer.isBuffer(chunk)) res.end(chunk)
    else chunk.pipe(res)
  }

  const range = req.headers.range
  if (typeof range === 'string') {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (match !== null) {
      const rawStart = match[1]
      const rawEnd = match[2]
      let start = rawStart === '' ? undefined : Number(rawStart)
      let end = rawEnd === '' ? undefined : Number(rawEnd)
      if (start === undefined && end !== undefined) {
        // Suffix form: last N bytes.
        start = Math.max(0, size - end)
        end = size - 1
      }
      if (start !== undefined && end === undefined) end = size - 1
      const valid =
        start !== undefined &&
        end !== undefined &&
        Number.isFinite(start) &&
        Number.isFinite(end) &&
        start <= end &&
        start < size
      if (!valid) {
        res.writeHead(416, {
          'content-range': 'bytes */' + String(size),
          'cache-control': 'no-store',
        })
        res.end()
        return
      }
      end = Math.min(end, size - 1)
      res.writeHead(206, {
        ...validators,
        'content-type': CONTENT_TYPE,
        'content-length': String(end - start + 1),
        'content-range': 'bytes ' + String(start) + '-' + String(end) + '/' + String(size),
        'accept-ranges': 'bytes',
        'cache-control': cacheControl,
      })
      if (req.method === 'HEAD') {
        res.end()
        return
      }
      body(start, end)
      return
    }
  }

  res.writeHead(200, {
    ...validators,
    'content-type': CONTENT_TYPE,
    'content-length': String(size),
    'accept-ranges': 'bytes',
    'cache-control': cacheControl,
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  body(undefined, undefined)
}

/** Serve a clip from disk. */
function streamFile(req, res, filePath, size, version = null) {
  let stats = null
  try {
    stats = statSync(filePath)
  } catch {
    /* fall through: serve without validators */
  }
  sendMedia(req, res, {
    size,
    version,
    etag: stats === null ? null : etagOf(stats),
    lastModified: stats === null ? null : new Date(stats.mtimeMs).toUTCString(),
    open: (start, end) =>
      start === undefined ? createReadStream(filePath) : createReadStream(filePath, { start, end }),
  })
}

/** Serve an embedded clip from memory. */
function streamEmbedded(req, res, buffer, contentKey) {
  sendMedia(req, res, {
    size: buffer.length,
    version: contentKey,
    // The content hash is already the clip's identity, so revalidation is exact
    // rather than stat-based.
    etag: '"embedded-' + contentKey + '"',
    lastModified: null,
    open: (start, end) => (start === undefined ? buffer : buffer.subarray(start, end + 1)),
  })
}

/**
 * Serve one resolved clip, from memory or from disk.
 *
 * Async because an embedded clip's data module is imported on first use, so the
 * host does not parse ~8MB of base64 at startup for a video it may never serve.
 */
async function streamClip(req, res, video) {
  if (video.embedded !== null && video.embedded !== undefined) {
    const buffer = await embeddedBuffer(video.embedded)
    if (buffer === null) {
      sendText(res, 500, 'dsh-boot-animation: embedded clip data is missing from lib/clips.data.js')
      return
    }
    streamEmbedded(req, res, buffer, video.contentKey)
    return
  }
  streamFile(req, res, video.path, video.bytes, video.contentKey)
}

/** The historical single-video route: whatever is active right now. */
function serveVideo(req, res) {
  const { video } = resolveActive()
  if (video === null) {
    sendText(
      res,
      404,
      'dsh-boot-animation: no video found (drop an .mp4 into ' +
        join(HOME_DIR(), 'videos') +
        ', set DSH_BOOT_ANIMATION, or add $DSH_HOME/boot-animation/intro.mp4)',
    )
    return
  }
  void streamClip(req, res, video).catch(() => {
    try {
      sendText(res, 500, 'dsh-boot-animation: could not read the clip')
    } catch {
      /* headers already sent */
    }
  })
}

/**
 * One specific video from the library, by id.
 *
 * The handler signature is `(req, res)` 鈥?the webserver does NOT pass a URL as
 * a third argument. Reading `req.url` is therefore the only way to see the id,
 * and doing it from a parameter that is always undefined made every request
 * 404 (the library listed videos it could not then serve).
 */
function serveMedia(req, res) {
  const raw = typeof req.url === 'string' ? req.url : ''
  const path = raw.split('?')[0]
  // MEDIA_ROUTE has no trailing slash, so drop exactly one separator here.
  const id = decodeURIComponent(path.slice(MEDIA_ROUTE.length + 1))
  const video = id === '' ? null : findById(id)
  if (video === null) {
    sendText(res, 404, 'dsh-boot-animation: no such video id')
    return
  }
  void streamClip(req, res, video).catch(() => {
    try {
      sendText(res, 500, 'dsh-boot-animation: could not read the clip')
    } catch {
      /* headers already sent */
    }
  })
}

/**
 * Read a small JSON POST body, or answer an error.
 *
 * One shared reader instead of a copy per route: the previous version inlined
 * this into the select handler, and every new body-taking route would otherwise
 * grow another slightly different version of the same bounds check.
 */
function readBody(req, res, handle) {
  let body = ''
  let overflowed = false
  req.on('data', (chunk) => {
    if (overflowed) return
    body += chunk
    if (body.length > MAX_BODY_BYTES) {
      overflowed = true
      req.destroy()
    }
  })
  req.on('end', () => {
    if (overflowed) {
      sendJson(res, { ok: false, error: 'request body too large' }, 413)
      return
    }
    handle(body)
  })
  req.on('error', () => {
    try {
      sendJson(res, { ok: false, error: 'request error' }, 400)
    } catch {
      /* socket already gone */
    }
  })
}

/** Parse a JSON object body, or answer an error and return null. */
function readJsonObject(req, res, handle) {
  readBody(req, res, (body) => {
    let parsed = null
    try {
      parsed = JSON.parse(body)
    } catch {
      sendJson(res, { ok: false, error: 'invalid JSON body' }, 400)
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      sendJson(res, { ok: false, error: 'body must be a JSON object' }, 400)
      return
    }
    handle(parsed)
  })
}

/** POST /select  { "id": "..." }  鈥?remembers the user's choice. */
function handleSelect(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, { ok: false, error: 'POST required' }, 405)
    return
  }
  readJsonObject(req, res, (payload) => {
    const id = typeof payload.id === 'string' ? payload.id : ''
    if (id === '') {
      sendJson(res, { ok: false, error: 'id must be a non-empty string' }, 400)
      return
    }
    const video = listVideos().find((v) => v.id === id) ?? null
    if (video === null) {
      sendJson(res, { ok: false, error: 'no video with that id' }, 404)
      return
    }
    try {
      // Both files, on purpose: settings.json is what the client reads, and
      // selection.json keeps an older client (or a rollback) able to see the
      // same pick instead of silently falling back to the built-in clip.
      writeSettingsPatch({ clipId: video.id })
      writeSelection(video.id)
    } catch (error) {
      sendJson(
        res,
        { ok: false, error: 'could not save selection: ' + String(error?.message ?? error) },
        500,
      )
      return
    }
    sendJson(res, { ok: true, activeId: video.id, name: video.name })
  })
}

/** GET /settings.json 鈥?settings, play state, clips and the ranges the panel needs. */
function serveSettings(res) {
  serveConfig(res)
}

/**
 * POST /settings.json  { ...patch }  鈥?merge a patch into settings.json.
 *
 * A merge, not a replace: the client sends only what the user changed, so a
 * stale panel cannot wipe a field it never rendered. Values outside their
 * declared range are clamped by the shared validator rather than rejected, and
 * unknown keys are dropped, so a typo can never persist.
 */
function handleSettings(req, res) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    serveConfig(res)
    return
  }
  if (req.method !== 'POST') {
    sendJson(res, { ok: false, error: 'GET or POST required' }, 405)
    return
  }
  readJsonObject(req, res, (patch) => {
    try {
      const settings = writeSettingsPatch(patch)
      // Keep the legacy pick file in step, so both readers agree.
      if (patch.clipId !== undefined) writeSelection(settings.clipId)
      sendJson(res, { ok: true, settings, state: readState(), clips: listVideos().map(previewEntry) })
    } catch (error) {
      sendJson(
        res,
        { ok: false, error: 'could not save settings: ' + String(error?.message ?? error) },
        500,
      )
    }
  })
}

/**
 * POST /state  { clipId, conversationId }  鈥?record that the intro ran.
 *
 * The browser owns the decision (only it sees conversations), so it reports the
 * outcome here: this is what makes "once per day" and "play count" survive a
 * reload. `ranAt` is stamped by the server from its own clock, because a clock
 * the client could set backwards would let an intro replay on every refresh.
 */
function handleState(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, { ok: false, error: 'POST required' }, 405)
    return
  }
  readJsonObject(req, res, (payload) => {
    try {
      const before = readState()
      const next = writeState({
        ranAt: new Date().toISOString(),
        runs: before.runs + 1,
        clipId: typeof payload.clipId === 'string' ? payload.clipId : before.clipId,
        conversationId:
          typeof payload.conversationId === 'string' ? payload.conversationId : before.conversationId,
      })
      sendJson(res, { ok: true, state: next })
    } catch (error) {
      sendJson(res, { ok: false, error: 'could not save state: ' + String(error?.message ?? error) }, 500)
    }
  })
}

/**
 * POST /reset  鈥?forget the play history, and optionally the settings.
 *
 * Exists because "it only plays once" and "it never plays any more" look like
 * bugs from the outside, and the honest answer to both is a visible way to start
 * over. `{ "what": "state" | "all" }`; the default touches only history, never
 * the user's settings, so resetting cannot discard a configuration by accident.
 */
function handleReset(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, { ok: false, error: 'POST required' }, 405)
    return
  }
  readBody(req, res, (body) => {
    let what = 'state'
    if (body.trim() !== '') {
      try {
        const parsed = JSON.parse(body)
        if (typeof parsed?.what === 'string') what = parsed.what
      } catch {
        sendJson(res, { ok: false, error: 'invalid JSON body' }, 400)
        return
      }
    }
    if (what !== 'state' && what !== 'all') {
      sendJson(res, { ok: false, error: 'what must be "state" or "all"' }, 400)
      return
    }
    try {
      writeState({ ranAt: null, runs: 0, clipId: null, conversationId: null })
      if (what === 'all') {
        writeJsonFile(SETTINGS_FILE(), DEFAULT_SETTINGS)
        writeSelection(null)
      }
      sendJson(res, { ok: true, what, settings: readSettings(), state: readState() })
    } catch (error) {
      sendJson(res, { ok: false, error: 'could not reset: ' + String(error?.message ?? error) }, 500)
    }
  })
}

/**
 * The clip the settings resolve to, plus everything the boot overlay needs to
 * decide whether to play it.
 *
 * Exposed as its own route because the overlay must be able to start WITHOUT the
 * settings panel: on a cold start the panel is not mounted, and the overlay needs
 * one URL per clip plus a handful of booleans.
 *
 * `bootId` is the part that makes this a STARTUP animation. It is generated once
 * per host process - i.e. once per DeepSeek Harness launch - and the page stores
 * the id it has already acted on. A page that sees a new id knows the application
 * itself just started; a page that sees the one it already stored was reloaded
 * inside a running session. That is the only reliable way to tell "the app started"
 * from "someone pressed F5", because both look identical from inside the browser.
 */
function servePlan(res) {
  const { video, how, videos } = resolveActive()
  const settings = readSettings()
  const version = video?.contentKey ?? null
  sendJson(res, {
    settings,
    state: readState(),
    bootId: BOOT_ID,
    clip:
      video === null
        ? null
        : {
            id: video.id,
            name: video.name,
            how,
            version,
            bytes: video.bytes,
          },
    url: video === null ? null : MEDIA_ROUTE + '/' + encodeURIComponent(video.id) + query(version),
    activeUrl: video === null ? null : ROUTE + query(version),
    /**
     * The media URL of EVERY clip, keyed by id.
     *
     * A map rather than a list because its one consumer - a per-trigger clip
     * override - asks "what is the URL for this id", and the plan's own `clips` list
     * only ever describes the ACTIVE clip. Shipping the whole map is what lets
     * "play the cinematic clip on startup and the short one for a new chat" work
     * without a second request or a second source of truth about the id scheme.
     */
    clipUrls: Object.fromEntries(
      videos.map((v) => [v.id, MEDIA_ROUTE + '/' + encodeURIComponent(v.id) + query(v.contentKey ?? null)]),
    ),
    clipCount: videos.length,
  })
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: serveVideo }),
    'dsh-boot-animation: boot video',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: MEDIA_ROUTE, handler: serveMedia }),
    'dsh-boot-animation: video library',
  )
  ctx.effect(
    () =>
      ctx.webServer.register({ kind: 'prefix', path: LIST_ROUTE, handler: (_req, res) => serveList(res) }),
    'dsh-boot-animation: video list',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: SELECT_ROUTE, handler: handleSelect }),
    'dsh-boot-animation: select video',
  )
  ctx.effect(
    () =>
      ctx.webServer.register({ kind: 'prefix', path: STATUS_ROUTE, handler: (_req, res) => serveStatus(res) }),
    'dsh-boot-animation: status',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: SETTINGS_ROUTE, handler: handleSettings }),
    'dsh-boot-animation: settings',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: STATE_ROUTE, handler: handleState }),
    'dsh-boot-animation: play state',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: RESET_ROUTE, handler: handleReset }),
    'dsh-boot-animation: reset',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: PLAN_ROUTE, handler: (_req, res) => servePlan(res) }),
    'dsh-boot-animation: play plan',
  )
  // One line at boot so an operator can see the resolved configuration in the
  // harness log without opening the GUI.
  try {
    const settings = readSettings()
    ctx.logger?.('dsh-boot-animation').info(
      'clip=%s triggers=%s frequency=%s layer=%s',
      String(settings.clipId),
      settings.triggers.join(','),
      settings.frequency,
      settings.layer,
    )
  } catch {
    /* logging must never keep the plugin from mounting */
  }
}
