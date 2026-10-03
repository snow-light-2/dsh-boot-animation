/**
 * dsh-boot-animation - the settings vocabulary, shared by both halves.
 *
 * This module is the single source of truth for what a user can configure. It is
 * bundled into the browser half by tsdown AND transpiled to lib/settings.shared.mjs
 * for the host half (`scripts/build.mjs`), so the defaults, the ranges and the
 * validation cannot drift between what the server stores and what the panel
 * renders.
 *
 * Validation is deliberately total: `mergeSettings` returns a usable settings
 * object for ANY input, clamping numbers into range, dropping unknown keys, and
 * falling back to the default for a wrong type. A settings.json edited by hand, a
 * truncated file, or a POST body from a stale panel therefore degrades to a
 * playable configuration instead of throwing on every page load.
 */
/**
 * Hard bounds. Ranges are enforced on write AND used by the panel to build its
 * inputs, so the UI cannot offer a value the server would clamp away.
 */
export const SETTINGS_LIMITS = Object.freeze({
    delayMs: Object.freeze({ min: 0, max: 10000, step: 250 }),
    maxSeconds: Object.freeze({ min: 0, max: 600, step: 5 }),
    playbackRate: Object.freeze({ min: 0.25, max: 3, step: 0.25 }),
    volume: Object.freeze({ min: 0, max: 100, step: 1 }),
    backdropOpacity: Object.freeze({ min: 0, max: 100, step: 1 }),
    videoOpacity: Object.freeze({ min: 0, max: 100, step: 1 }),
    skipAfterMs: Object.freeze({ min: 0, max: 20000, step: 500 }),
    playCount: Object.freeze({ min: 1, max: 999, step: 1 }),
    zIndex: Object.freeze({ min: 1, max: 2147483647, step: 1 }),
    stallTimeoutMs: Object.freeze({ min: 5000, max: 120000, step: 1000 }),
    title: Object.freeze({ maxLength: 120 }),
    subtitle: Object.freeze({ maxLength: 200 }),
    skipLabel: Object.freeze({ maxLength: 24 }),
    hintLabel: Object.freeze({ maxLength: 60 }),
});
/** Trigger names, in the order the panel lists them. */
export const TRIGGERS = Object.freeze([
    'appStart',
    'pageLoad',
    'newConversation',
    'pinnedConversation',
    'conversation',
]);
/** Frequency names, in panel order. */
export const FREQUENCIES = Object.freeze(['every', 'daily', 'once', 'count']);
/**
 * Layer names. `overlay` is the default because a startup animation that a desktop
 * pet covers would read as "the plugin is broken"; `backdrop` is the option for
 * users who want the pet usable while the intro plays.
 */
export const LAYERS = Object.freeze(['overlay', 'backdrop']);
/**
 * Stacking index for each layer.
 *
 * These are not arbitrary. The desktop pet draws its context menu at 2147483000,
 * its chat at 2147483001, and its score popup at 2147483002, all appended to
 * `document.body` - outside any slot, so slot order cannot arbitrate them. An
 * earlier version of this plugin used 2147483000 for the intro, an exact tie with
 * the pet menu, which then painted over the intro. `overlay` therefore sits above
 * all three; `backdrop` sits just below the pet's own surfaces so the pet stays
 * reachable and visible.
 */
export const LAYER_Z = Object.freeze({
    overlay: 2147483600,
    backdrop: 2147482980,
});
/**
 * The defaults.
 *
 * `appStart` with `every` is what a user means by "开机动画": DeepSeek Harness
 * starts, the animation plays. The conversation triggers stay on so an existing
 * workflow does not silently change, and `pageLoad` stays OFF because a browser
 * refresh is not an application start - turning it on is how someone gets the
 * animation on every F5 instead.
 */
export const DEFAULT_SETTINGS = Object.freeze({
    version: 1,
    enabled: true,
    frequency: 'every',
    playCount: 3,
    triggers: Object.freeze(['appStart', 'newConversation', 'pinnedConversation']),
    clipId: null,
    perTriggerClip: Object.freeze({}),
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
});
/** A fresh play state: nothing has played yet. */
export const DEFAULT_STATE = Object.freeze({
    ranAt: null,
    runs: 0,
    clipId: null,
    conversationId: null,
});
/** Clamp a number into a declared range; anything unusable becomes the fallback. */
function clampNumber(value, limit, fallback) {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.min(limit.max, Math.max(limit.min, n));
}
/** A trimmed string, cut to the declared length. */
function limitedString(value, limit, fallback) {
    if (typeof value !== 'string')
        return fallback;
    return value.slice(0, limit.maxLength);
}
/** One of `allowed`, or the fallback. */
function oneOf(value, allowed, fallback) {
    return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}
/** A boolean, or the fallback for anything else (including the string 'true'). */
function boolean(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}
/** Keep only the trigger names we know, in the canonical order. */
function cleanTriggers(value, fallback) {
    if (!Array.isArray(value))
        return [...fallback];
    const wanted = new Set(value.filter((item) => typeof item === 'string'));
    return TRIGGERS.filter((trigger) => wanted.has(trigger));
}
/** A trigger to clip-id map with known triggers and non-empty string values. */
function cleanPerTriggerClip(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return {};
    const out = {};
    const source = value;
    for (const trigger of TRIGGERS) {
        const clip = source[trigger];
        if (typeof clip === 'string' && clip !== '')
            out[trigger] = clip;
    }
    return out;
}
/** A plain object, or an empty one - the input of every merge. */
function asRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value
        : {};
}
/**
 * Coerce any input into a complete, valid settings object.
 *
 * @param raw - Parsed settings.json, a POST patch, or garbage.
 * @param base - What to fall back to per field; defaults to the shipped defaults.
 * @returns A settings object safe to store and to serve.
 */
export function mergeSettings(raw, base = DEFAULT_SETTINGS) {
    const input = asRecord(raw);
    const fallback = base ?? DEFAULT_SETTINGS;
    const pick = (key) => input[key] === undefined ? fallback[key] : input[key];
    return {
        version: 1,
        enabled: boolean(pick('enabled'), DEFAULT_SETTINGS.enabled),
        frequency: oneOf(pick('frequency'), FREQUENCIES, DEFAULT_SETTINGS.frequency),
        playCount: clampNumber(pick('playCount'), SETTINGS_LIMITS.playCount, DEFAULT_SETTINGS.playCount),
        triggers: cleanTriggers(input.triggers === undefined ? fallback.triggers : input.triggers, DEFAULT_SETTINGS.triggers),
        clipId: typeof pick('clipId') === 'string' && pick('clipId') !== '' ? String(pick('clipId')) : null,
        perTriggerClip: input.perTriggerClip === undefined
            ? cleanPerTriggerClip(fallback.perTriggerClip)
            : cleanPerTriggerClip(input.perTriggerClip),
        layer: oneOf(pick('layer'), LAYERS, DEFAULT_SETTINGS.layer),
        backdropOpacity: clampNumber(pick('backdropOpacity'), SETTINGS_LIMITS.backdropOpacity, DEFAULT_SETTINGS.backdropOpacity),
        fit: oneOf(pick('fit'), ['cover', 'contain'], DEFAULT_SETTINGS.fit),
        videoOpacity: clampNumber(pick('videoOpacity'), SETTINGS_LIMITS.videoOpacity, DEFAULT_SETTINGS.videoOpacity),
        delayMs: clampNumber(pick('delayMs'), SETTINGS_LIMITS.delayMs, DEFAULT_SETTINGS.delayMs),
        maxSeconds: clampNumber(pick('maxSeconds'), SETTINGS_LIMITS.maxSeconds, DEFAULT_SETTINGS.maxSeconds),
        playbackRate: clampNumber(pick('playbackRate'), SETTINGS_LIMITS.playbackRate, DEFAULT_SETTINGS.playbackRate),
        loop: boolean(pick('loop'), DEFAULT_SETTINGS.loop),
        sound: boolean(pick('sound'), DEFAULT_SETTINGS.sound),
        volume: clampNumber(pick('volume'), SETTINGS_LIMITS.volume, DEFAULT_SETTINGS.volume),
        showSkip: boolean(pick('showSkip'), DEFAULT_SETTINGS.showSkip),
        skipAfterMs: clampNumber(pick('skipAfterMs'), SETTINGS_LIMITS.skipAfterMs, DEFAULT_SETTINGS.skipAfterMs),
        allowFullscreen: boolean(pick('allowFullscreen'), DEFAULT_SETTINGS.allowFullscreen),
        dismissOnInteract: boolean(pick('dismissOnInteract'), DEFAULT_SETTINGS.dismissOnInteract),
        title: limitedString(pick('title'), SETTINGS_LIMITS.title, DEFAULT_SETTINGS.title),
        subtitle: limitedString(pick('subtitle'), SETTINGS_LIMITS.subtitle, DEFAULT_SETTINGS.subtitle),
        showCountdown: boolean(pick('showCountdown'), DEFAULT_SETTINGS.showCountdown),
        skipLabel: limitedString(pick('skipLabel'), SETTINGS_LIMITS.skipLabel, DEFAULT_SETTINGS.skipLabel),
        hintLabel: limitedString(pick('hintLabel'), SETTINGS_LIMITS.hintLabel, DEFAULT_SETTINGS.hintLabel),
        zIndex: clampNumber(pick('zIndex'), SETTINGS_LIMITS.zIndex, DEFAULT_SETTINGS.zIndex),
        stallTimeoutMs: clampNumber(pick('stallTimeoutMs'), SETTINGS_LIMITS.stallTimeoutMs, DEFAULT_SETTINGS.stallTimeoutMs),
    };
}
/**
 * Coerce the play-state file.
 *
 * `ranAt` is only kept when it parses as a date, because every frequency rule
 * compares it against now: an unparseable value would otherwise read as NaN and
 * silently disable the daily rule instead of replaying.
 */
export function normalizeState(raw) {
    const input = asRecord(raw);
    let ranAt = null;
    if (typeof input.ranAt === 'string' && input.ranAt !== '') {
        const parsed = Date.parse(input.ranAt);
        if (Number.isFinite(parsed))
            ranAt = new Date(parsed).toISOString();
    }
    const runs = Number(input.runs);
    return {
        ranAt,
        runs: Number.isFinite(runs) ? Math.max(0, Math.trunc(runs)) : 0,
        clipId: typeof input.clipId === 'string' && input.clipId !== '' ? input.clipId : null,
        conversationId: typeof input.conversationId === 'string' && input.conversationId !== ''
            ? input.conversationId
            : null,
    };
}
/** The stacking index a settings object resolves to. */
export function resolvedZIndex(settings) {
    const custom = Number(settings.zIndex);
    if (Number.isFinite(custom) && custom > 0)
        return Math.trunc(custom);
    return LAYER_Z[settings.layer] ?? LAYER_Z.overlay;
}
/**
 * Whether the frequency rule allows another play.
 *
 * Split out from the browser trigger logic so it is unit-testable without a DOM,
 * and so the host and the client agree on what `daily` means: one play per
 * calendar day in LOCAL time, which is what a user means by "每天一次".
 *
 * @param settings - Current settings.
 * @param state - Recorded play history.
 * @param nowMs - Injectable clock, for tests.
 */
export function frequencyAllows(settings, state, nowMs = Date.now()) {
    const frequency = settings?.frequency ?? DEFAULT_SETTINGS.frequency;
    if (frequency === 'every')
        return true;
    const playedAt = state?.ranAt == null ? null : Date.parse(state.ranAt);
    if (frequency === 'once')
        return playedAt === null || !Number.isFinite(playedAt);
    if (frequency === 'count') {
        const limit = Number(settings?.playCount);
        return (state?.runs ?? 0) < (Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_SETTINGS.playCount);
    }
    // daily
    if (playedAt === null || !Number.isFinite(playedAt))
        return true;
    const last = new Date(playedAt);
    const now = new Date(nowMs);
    return (last.getFullYear() !== now.getFullYear() ||
        last.getMonth() !== now.getMonth() ||
        last.getDate() !== now.getDate());
}
