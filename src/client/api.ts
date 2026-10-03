/**
 * @dsh-external/dsh-boot-animation - the host routes, as one typed client.
 *
 * Every browser-side read of the host goes through this file, so the route set
 * exists in exactly one place and a renamed route is a compile error rather than
 * a silent 404 at runtime. All of it is same-origin: the plugin is served by the
 * DSH webserver itself, so there is no base URL to configure.
 */

import type { BootSettings, BootState, SettingsLimits } from '../shared/settings.js'

export const ROUTES = {
  /** The resolved active clip. */
  video: '/dsh-boot-animation/boot.mp4',
  /** One clip by id, with the content key appended. */
  media: '/dsh-boot-animation/media',
  /** Ids, names and sources only - what the library list needs. */
  list: '/dsh-boot-animation/videos.json',
  /** Remember one pick. */
  select: '/dsh-boot-animation/select',
  /** Everything the settings panel renders: settings, state, clips, ranges. */
  config: '/dsh-boot-animation/settings.json',
  /** Settings + play state + the single resolved URL, for the boot overlay. */
  plan: '/dsh-boot-animation/plan.json',
  /** Report that the intro ran. */
  state: '/dsh-boot-animation/state',
  /** Forget the play history. */
  reset: '/dsh-boot-animation/reset',
  /** Diagnostics. */
  status: '/dsh-boot-animation/status.json',
  /** One clip, uploaded as the raw POST body; the file name travels in `?name=`. */
  upload: '/dsh-boot-animation/upload',
} as const

/** One clip as `/settings.json` reports it. */
export type ClipEntry = {
  id: string
  name: string
  source: string
  bytes: number
  version: string | null
  /** False when the clip's index is not at the front, so the first frame may lag. */
  faststart?: boolean
  urls: { media: string; active: string }
}

/** One clip as `/videos.json` reports it - the on-disk view. */
export type VideoEntry = {
  id: string
  name: string
  file: string | null
  ext?: string
  source: string
  writable?: boolean
  embedded?: string | null
  bytes: number
  mtime: string | null
  legacy?: boolean
  faststart?: boolean
  copies?: number
  alsoAt?: string[]
  active?: boolean
  version?: string | null
}

/** `/settings.json` (GET) and the body of every settings write. */
export type ConfigPayload = {
  settings: BootSettings
  state: BootState
  active: { id: string; name: string; how: string; version: string | null } | null
  clips: ClipEntry[]
  videos: VideoEntry[]
  userDir: string
  settingsFile: string
  stateFile: string
  accepts: string[]
  limits: SettingsLimits
  defaults: BootSettings
  /** Ceiling for one uploaded clip, so the panel can refuse before sending it. */
  maxUploadBytes: number
}

/**
 * `/plan.json` - the smallest payload the boot overlay needs.
 *
 * `bootId` is the host process's identity: it changes when DeepSeek Harness itself
 * is launched and stays put across page reloads, which is how the overlay tells an
 * application start from an F5.
 *
 * `clipUrls` maps every clip id to its media URL, not just the active one, so a
 * per-trigger clip override resolves without a second request.
 */
export type PlanPayload = {
  settings: BootSettings
  state: BootState
  bootId: string | null
  clip: { id: string; name: string; how: string; version: string | null; bytes: number } | null
  url: string | null
  activeUrl: string | null
  clipUrls: Record<string, string>
  clipCount: number
}

/**
 * One GET with `no-store`.
 *
 * `no-store` on purpose: every one of these routes is a live decision (which clip
 * is picked, what the settings say), and a cached answer would make the panel
 * show a state the server no longer has.
 */
async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`)
  return (await response.json()) as T
}

/** One JSON POST, returning the parsed body even on a 4xx so the caller can read `error`. */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  let parsed: unknown = null
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`${url} answered ${String(response.status)} with a non-JSON body`)
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${url} answered ${String(response.status)} with an unexpected body`)
  }
  return parsed as T
}

/** Settings, state, clips and ranges in one request. */
export function fetchConfig(): Promise<ConfigPayload> {
  return getJson<ConfigPayload>(ROUTES.config)
}

/** Just enough to start the intro. */
export function fetchPlan(): Promise<PlanPayload> {
  return getJson<PlanPayload>(ROUTES.plan)
}

/** The video list as the library sees it. */
export function fetchVideos(): Promise<{ activeId: string | null; videos: VideoEntry[]; userDir: string }> {
  return getJson(ROUTES.list)
}

/** Persist a settings patch. Returns the settings the host actually stored. */
export async function saveSettings(
  patch: Partial<BootSettings>,
): Promise<{ ok: boolean; error?: string; settings?: BootSettings; state?: BootState; clips?: ClipEntry[] }> {
  return postJson(ROUTES.config, patch)
}

/** Remember one pick. */
export async function selectClip(id: string): Promise<{ ok: boolean; error?: string; name?: string }> {
  return postJson(ROUTES.select, { id })
}

/** Report that the intro ran; the host stamps the time and increments the counter. */
export async function reportPlayed(payload: {
  clipId?: string
  conversationId?: string
}): Promise<{ ok: boolean; state?: BootState }> {
  return postJson(ROUTES.state, payload)
}

/** Forget the play history, or everything. */
export async function resetState(what: 'state' | 'all'): Promise<{ ok: boolean; error?: string }> {
  return postJson(ROUTES.reset, { what })
}

/**
 * The URL for one clip, for a preview that must not be served from the wrong
 * cache entry. The content key is already in `urls.media` when the host knows it.
 */
export function mediaUrlFor(clip: ClipEntry): string {
  return clip.urls.media
}

/** `/status.json` as a diagnostic helper for the panel's "澶嶅埗璇婃柇" action. */
export function fetchStatus(): Promise<unknown> {
  return getJson(ROUTES.status)
}

/** What `/upload` answers: the stored clip, or why it was refused. */
export type UploadResult = {
  ok: boolean
  error?: string
  file?: string
  id?: string | null
  name?: string
  bytes?: number
  userDir?: string
  maxBytes?: number
}

/**
 * Upload one clip as the raw request body.
 *
 * XHR rather than fetch on purpose: `upload.onprogress` is the only way to show
 * how far a 200 MB clip has got, and a progress bar is the difference between
 * "it is working" and "it is stuck" for a file that takes a minute.
 */
export function uploadVideo(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('POST', `${ROUTES.upload}?name=${encodeURIComponent(file.name)}`)
    request.setRequestHeader('content-type', 'application/octet-stream')
    request.upload.onprogress = (event) => {
      if (onProgress !== undefined && event.lengthComputable && event.total > 0) {
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)))
      }
    }
    request.onload = () => {
      try {
        resolve(JSON.parse(request.responseText) as UploadResult)
      } catch {
        reject(new Error(`上传接口返回了非 JSON（HTTP ${String(request.status)}）`))
      }
    }
    request.onerror = () => reject(new Error('上传失败：网络错误'))
    request.onabort = () => reject(new Error('上传已取消'))
    request.send(file)
  })
}
