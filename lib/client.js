window.__ModuleLoader__.load({
	id: "dsh-boot-animation",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		//#region src/shared/settings.ts
		/**
		* Hard bounds. Ranges are enforced on write AND used by the panel to build its
		* inputs, so the UI cannot offer a value the server would clamp away.
		*/
		const SETTINGS_LIMITS = Object.freeze({
			delayMs: Object.freeze({
				min: 0,
				max: 1e4,
				step: 250
			}),
			maxSeconds: Object.freeze({
				min: 0,
				max: 600,
				step: 5
			}),
			playbackRate: Object.freeze({
				min: .25,
				max: 3,
				step: .25
			}),
			volume: Object.freeze({
				min: 0,
				max: 100,
				step: 1
			}),
			backdropOpacity: Object.freeze({
				min: 0,
				max: 100,
				step: 1
			}),
			videoOpacity: Object.freeze({
				min: 0,
				max: 100,
				step: 1
			}),
			skipAfterMs: Object.freeze({
				min: 0,
				max: 2e4,
				step: 500
			}),
			playCount: Object.freeze({
				min: 1,
				max: 999,
				step: 1
			}),
			zIndex: Object.freeze({
				min: 0,
				max: 2147483647,
				step: 1
			}),
			stallTimeoutMs: Object.freeze({
				min: 5e3,
				max: 12e4,
				step: 1e3
			}),
			title: Object.freeze({ maxLength: 120 }),
			subtitle: Object.freeze({ maxLength: 200 }),
			skipLabel: Object.freeze({ maxLength: 24 }),
			hintLabel: Object.freeze({ maxLength: 60 })
		});
		/** Trigger names, in the order the panel lists them. */
		const TRIGGERS = Object.freeze([
			"appStart",
			"pageLoad",
			"newConversation",
			"pinnedConversation",
			"conversation"
		]);
		/** Frequency names, in panel order. */
		const FREQUENCIES = Object.freeze([
			"every",
			"daily",
			"once",
			"count"
		]);
		/**
		* Layer names. `overlay` is the default because a startup animation that a desktop
		* pet covers would read as "the plugin is broken"; `backdrop` is the option for
		* users who want the pet usable while the intro plays.
		*/
		const LAYERS = Object.freeze(["overlay", "backdrop"]);
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
		const LAYER_Z = Object.freeze({
			overlay: 2147483600,
			backdrop: 2147482980
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
		const DEFAULT_SETTINGS = Object.freeze({
			version: 1,
			enabled: true,
			frequency: "every",
			playCount: 3,
			triggers: Object.freeze([
				"appStart",
				"newConversation",
				"pinnedConversation"
			]),
			clipId: null,
			perTriggerClip: Object.freeze({}),
			layer: "overlay",
			backdropOpacity: 100,
			fit: "cover",
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
			title: "",
			subtitle: "",
			showCountdown: true,
			skipLabel: "跳过",
			hintLabel: "",
			zIndex: 0,
			stallTimeoutMs: 25e3
		});
		/** A fresh play state: nothing has played yet. */
		const DEFAULT_STATE = Object.freeze({
			ranAt: null,
			runs: 0,
			clipId: null,
			conversationId: null
		});
		/** The stacking index a settings object resolves to. */
		function resolvedZIndex(settings) {
			const custom = Number(settings.zIndex);
			if (Number.isFinite(custom) && custom > 0) return Math.trunc(custom);
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
		function frequencyAllows(settings, state, nowMs = Date.now()) {
			const frequency = settings?.frequency ?? DEFAULT_SETTINGS.frequency;
			if (frequency === "every") return true;
			const playedAt = state?.ranAt == null ? null : Date.parse(state.ranAt);
			if (frequency === "once") return playedAt === null || !Number.isFinite(playedAt);
			if (frequency === "count") {
				const limit = Number(settings?.playCount);
				return (state?.runs ?? 0) < (Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_SETTINGS.playCount);
			}
			if (playedAt === null || !Number.isFinite(playedAt)) return true;
			const last = new Date(playedAt);
			const now = new Date(nowMs);
			return last.getFullYear() !== now.getFullYear() || last.getMonth() !== now.getMonth() || last.getDate() !== now.getDate();
		}
		//#endregion
		//#region src/client/api.ts
		const ROUTES = {
			/** The resolved active clip. */
			video: "/dsh-boot-animation/boot.mp4",
			/** One clip by id, with the content key appended. */
			media: "/dsh-boot-animation/media",
			/** Ids, names and sources only - what the library list needs. */
			list: "/dsh-boot-animation/videos.json",
			/** Remember one pick. */
			select: "/dsh-boot-animation/select",
			/** Everything the settings panel renders: settings, state, clips, ranges. */
			config: "/dsh-boot-animation/settings.json",
			/** Settings + play state + the single resolved URL, for the boot overlay. */
			plan: "/dsh-boot-animation/plan.json",
			/** Report that the intro ran. */
			state: "/dsh-boot-animation/state",
			/** Forget the play history. */
			reset: "/dsh-boot-animation/reset",
			/** Diagnostics. */
			status: "/dsh-boot-animation/status.json"
		};
		/**
		* One GET with `no-store`.
		*
		* `no-store` on purpose: every one of these routes is a live decision (which clip
		* is picked, what the settings say), and a cached answer would make the panel
		* show a state the server no longer has.
		*/
		async function getJson(url) {
			const response = await fetch(url, { cache: "no-store" });
			if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`);
			return await response.json();
		}
		/** One JSON POST, returning the parsed body even on a 4xx so the caller can read `error`. */
		async function postJson(url, body) {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body)
			});
			let parsed = null;
			try {
				parsed = await response.json();
			} catch {
				throw new Error(`${url} answered ${String(response.status)} with a non-JSON body`);
			}
			if (typeof parsed !== "object" || parsed === null) throw new Error(`${url} answered ${String(response.status)} with an unexpected body`);
			return parsed;
		}
		/** Settings, state, clips and ranges in one request. */
		function fetchConfig() {
			return getJson(ROUTES.config);
		}
		/** Just enough to start the intro. */
		function fetchPlan() {
			return getJson(ROUTES.plan);
		}
		/** Persist a settings patch. Returns the settings the host actually stored. */
		async function saveSettings(patch) {
			return postJson(ROUTES.config, patch);
		}
		/** Remember one pick. */
		async function selectClip(id) {
			return postJson(ROUTES.select, { id });
		}
		/** Report that the intro ran; the host stamps the time and increments the counter. */
		async function reportPlayed(payload) {
			return postJson(ROUTES.state, payload);
		}
		/** Forget the play history, or everything. */
		async function resetState(what) {
			return postJson(ROUTES.reset, { what });
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* @dsh-external/dsh-boot-animation - the browser half's stylesheet.
		*
		* One injected <style> tag, with every value a user can change coming from CSS
		* custom properties set inline by the caller. That split is deliberate:
		*
		*   - the RULES live here, so the sheet is written once and never re-parsed;
		*   - the VALUES (`--dba-z`, `--dba-backdrop`, `--dba-video-opacity`) are set on
		*     the root element at open time, so changing a setting never rebuilds CSS.
		*
		* Namespacing: every class starts with `dba-` and every custom property with
		* `--dba-`. Nothing here touches a bare tag selector, `:root`, or `body`, so this
		* sheet cannot restyle another plugin's UI - which is the failure mode that turns
		* one plugin's install into another plugin's bug report.
		*
		* Pointer events are layered on purpose. `.dba-root` is `pointer-events: none`, so
		* the intro never swallows a click meant for the page or for a desktop pet behind
		* it; only the controls opt back in with `.dba-hit`. The previous version put
		* `pointer-events: auto` on the full-frame root, which made every click during the
		* intro land on the video instead of the pet.
		*
		* NOTE: never put a backtick in this block - the whole sheet is a template
		* literal, and one backtick ends it. scripts/check-css-template.mjs enforces it.
		*/
		const STYLE_ID = "dsh-boot-animation-style";
		const CSS = `
.dba-root{position:fixed;inset:0;z-index:var(--dba-z,2147483600);
  background:var(--dba-backdrop,rgba(0,0,0,1));
  display:flex;align-items:center;justify-content:center;
  pointer-events:none;overflow:hidden;
  opacity:1;transition:opacity var(--dba-fade,320ms) ease}
.dba-root.dba-closing{opacity:0}
.dba-hit{pointer-events:auto}
.dba-video{width:100%;height:100%;object-fit:contain;background:transparent;display:block;
  opacity:var(--dba-video-opacity,1);pointer-events:none}
/* The ONLY difference between the fit modes is object-fit.
   Do not "harden" this with position/inset changes: the bar fix does not need
   them, and an overlay that rendered correctly under flex + percentage sizing
   went fully black in the real app the one time the layout mechanics were
   rewritten for no reason. Minimal change, or you trade a cosmetic defect for a
   functional one. */
.dba-video.dba-cover{object-fit:cover;object-position:center}
.dba-controls{position:absolute;top:20px;right:22px;z-index:2;display:flex;gap:8px;align-items:center}
.dba-btn{border:1px solid rgba(255,255,255,.42);background:rgba(0,0,0,.42);
  color:#fff;border-radius:999px;padding:6px 16px;font-size:13px;line-height:1.4;
  font-family:inherit;cursor:pointer;transition:background 160ms ease}
.dba-btn:hover{background:rgba(0,0,0,.66)}
.dba-btn.dba-ghost{padding:6px 11px}
.dba-caption{position:absolute;left:0;right:0;bottom:64px;z-index:2;text-align:center;
  color:#fff;font-family:inherit;text-shadow:0 1px 10px rgba(0,0,0,.92);padding:0 24px}
.dba-title{font-size:22px;font-weight:600;letter-spacing:.04em;line-height:1.35}
.dba-subtitle{font-size:13px;opacity:.82;margin-top:6px;letter-spacing:.06em}
.dba-hint{position:absolute;bottom:30px;left:50%;transform:translateX(-50%);
  z-index:2;color:rgba(255,255,255,.82);font-size:13px;letter-spacing:.06em;
  font-family:inherit;text-shadow:0 1px 8px rgba(0,0,0,.9);
  animation:dba-breathe 2.4s ease-in-out infinite;white-space:nowrap}
@keyframes dba-breathe{0%,100%{opacity:.55}50%{opacity:1}}
.dba-status{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
  z-index:2;color:rgba(255,255,255,.88);font-size:14px;letter-spacing:.04em;
  font-family:inherit;text-align:center;max-width:78vw;
  background:rgba(0,0,0,.46);border-radius:10px;padding:10px 18px;
  text-shadow:0 1px 10px rgba(0,0,0,.9)}
.dba-countdown{position:absolute;left:0;right:0;bottom:0;z-index:2;height:3px;
  background:rgba(255,255,255,.16)}
.dba-countdown-fill{height:100%;width:100%;background:rgba(255,255,255,.72);
  transform-origin:left center;transform:scaleX(1)}
/* --- settings panel ------------------------------------------------------ */
.dba-veil{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.46);
  display:flex;align-items:center;justify-content:center;padding:24px;
  pointer-events:auto}
.dba-lib{width:min(680px,100%);max-height:min(84vh,760px);overflow:auto;
  background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-text-primary,#191919);
  border:1px solid rgba(127,127,127,.28);border-radius:14px;padding:18px 18px 14px;
  box-shadow:0 18px 60px rgba(0,0,0,.34);font-family:inherit;
  font-size:13px;line-height:1.55}
.dba-lib h3{margin:0 0 4px;font-size:15px;font-weight:600}
.dba-lib h4{margin:16px 0 8px;font-size:12.5px;font-weight:600;
  color:var(--dsw-alias-text-secondary,#777);text-transform:uppercase;letter-spacing:.08em}
.dba-lib p{margin:0 0 12px;color:var(--dsw-alias-text-secondary,#777);font-size:12.5px}
.dba-item{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;
  cursor:pointer;border:1px solid transparent}
.dba-item:hover{background:rgba(127,127,127,.12)}
.dba-item.dba-cur{border-color:rgba(7,193,96,.55);background:rgba(7,193,96,.10)}
.dba-item .dba-nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dba-badge{font-size:11px;padding:1px 7px;border-radius:999px;
  background:rgba(127,127,127,.18);color:var(--dsw-alias-text-secondary,#777);white-space:nowrap}
.dba-badge.dba-b-sel{background:rgba(7,193,96,.16);color:#07974b}
.dba-badge.dba-b-warn{background:rgba(210,120,40,.18);color:#b46214;cursor:help}
.dba-meta{font-size:11.5px;color:var(--dsw-alias-text-secondary,#999);white-space:nowrap}
.dba-mark{width:16px;text-align:center;color:#07c160;font-weight:700}
.dba-dir{margin:12px 0 0;padding:9px 10px;border-radius:9px;background:rgba(127,127,127,.10);
  font-size:11.5px;color:var(--dsw-alias-text-secondary,#777);word-break:break-all}
.dba-dir code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;
  color:var(--dsw-alias-text-primary,#333)}
.dba-bar{display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap}
.dba-btn.dba-btn-on{border-color:rgba(7,193,96,.6);background:rgba(7,193,96,.12);color:#07974b}
.dba-btn.dba-btn-preview{border-color:rgba(7,193,96,.55);color:#07974b;font-weight:600}
.dba-btn.dba-btn-preview:hover{background:rgba(7,193,96,.12)}
.dba-btn.dba-panel{border:1px solid rgba(127,127,127,.34);background:transparent;color:inherit;
  border-radius:8px;padding:5px 14px;font-size:12.5px;font-family:inherit;cursor:pointer}
.dba-btn.dba-panel:hover{background:rgba(127,127,127,.14)}
.dba-btn.dba-panel.dba-btn-on{border-color:rgba(7,193,96,.6);background:rgba(7,193,96,.12);color:#07974b}
.dba-msg{margin-top:10px;font-size:12px;min-height:16px;color:var(--dsw-alias-text-secondary,#777)}
.dba-msg.dba-ok{color:#07974b}
.dba-msg.dba-err{color:#d24a43}
.dba-row{display:flex;align-items:center;gap:10px;padding:5px 0;min-height:28px}
.dba-row > .dba-lab{width:150px;flex:none;color:var(--dsw-alias-text-secondary,#777)}
.dba-row > .dba-ctl{flex:1;min-width:0;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dba-row input[type=range]{flex:1;min-width:120px;accent-color:#07974b}
.dba-row input[type=text],.dba-row input[type=number]{flex:1;min-width:80px;
  background:transparent;color:inherit;font-family:inherit;font-size:12.5px;
  border:1px solid rgba(127,127,127,.34);border-radius:7px;padding:4px 8px}
.dba-row input[type=checkbox]{accent-color:#07974b;width:15px;height:15px}
.dba-val{font-size:11.5px;color:var(--dsw-alias-text-secondary,#999);
  min-width:44px;text-align:right;font-variant-numeric:tabular-nums}
.dba-note{font-size:11.5px;color:var(--dsw-alias-text-secondary,#999);margin:2px 0 0 160px}
.dba-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px}
.dba-chip{border:1px solid rgba(127,127,127,.34);border-radius:8px;padding:7px 10px;
  cursor:pointer;user-select:none;display:flex;flex-direction:column;gap:2px}
.dba-chip:hover{background:rgba(127,127,127,.12)}
.dba-chip.dba-on{border-color:rgba(7,193,96,.6);background:rgba(7,193,96,.12)}
.dba-chip .dba-chip-t{font-size:12.5px;font-weight:600}
.dba-chip .dba-chip-d{font-size:11px;color:var(--dsw-alias-text-secondary,#888)}
.dba-tabs{display:flex;gap:6px;margin:12px 0 4px;border-bottom:1px solid rgba(127,127,127,.22)}
.dba-tab{border:0;background:transparent;color:var(--dsw-alias-text-secondary,#777);
  font-family:inherit;font-size:12.5px;padding:6px 10px;cursor:pointer;border-bottom:2px solid transparent}
.dba-tab.dba-on{color:var(--dsw-alias-text-primary,#191919);border-bottom-color:#07974b;font-weight:600}
`;
		/** Inject the sheet once. Idempotent, so a second call is free. */
		function ensureStyle() {
			if (document.getElementById("dsh-boot-animation-style") !== null) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			style.textContent = CSS;
			document.head.appendChild(style);
		}
		//#endregion
		//#region src/client/boot-overlay.ts
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
		/** Where the conversation ids that already played are remembered. */
		const SEEN_KEY = "dsh-boot-animation:seen";
		/** The chosen intro conversation. */
		const PIN_KEY = "dsh-boot-animation:pinned";
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
		const BOOT_KEY = "dsh-boot-animation:bootId";
		/** Bounded so localStorage cannot grow forever on a long-lived install. */
		const MAX_SEEN = 200;
		/** Fade-out duration, in ms, shared with the stylesheet's transition. */
		const FADE_MS = 320;
		const bridge = {
			settings: { ...DEFAULT_SETTINGS },
			state: { ...DEFAULT_STATE },
			clip: null,
			url: null,
			clips: /* @__PURE__ */ new Map(),
			loaded: false,
			playing: false,
			sessionId: null,
			isNewConversation: false,
			listeners: /* @__PURE__ */ new Set(),
			lastReason: null,
			bootId: null,
			appStarted: false
		};
		/** The open overlay, so a second open can replace the first instead of stacking. */
		let closeCurrent = null;
		function readSeen() {
			try {
				const parsed = JSON.parse(window.localStorage.getItem(SEEN_KEY) ?? "[]");
				return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
			} catch {
				return [];
			}
		}
		function hasPlayed(sessionId) {
			return readSeen().includes(sessionId);
		}
		function markPlayed(sessionId) {
			try {
				const seen = readSeen();
				if (!seen.includes(sessionId)) seen.push(sessionId);
				while (seen.length > MAX_SEEN) seen.shift();
				window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
			} catch {}
		}
		/** Forget which conversations already played - the panel's reset action. */
		function forgetPlayedConversations() {
			try {
				window.localStorage.removeItem(SEEN_KEY);
			} catch {}
		}
		function readPinned() {
			try {
				const value = window.localStorage.getItem(PIN_KEY);
				return value === null || value === "" ? null : value;
			} catch {
				return null;
			}
		}
		function safeJson(value) {
			try {
				return JSON.stringify(value);
			} catch {
				return String(value);
			}
		}
		function narrate(text) {
			try {
				console.log("[dsh-boot-animation] " + text);
			} catch {}
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
		function notify(...args) {
			narrate(args.map((a) => typeof a === "object" && a !== null ? safeJson(a) : String(a)).join(" "));
		}
		/** Whether the intro may play at all right now. */
		function allowed() {
			if (!bridge.settings.enabled) return false;
			if (bridge.url === null || bridge.clip === null) return false;
			return frequencyAllows(bridge.settings, bridge.state);
		}
		/**
		* The URL a trigger should play.
		*
		* `perTriggerClip` wins over the global pick, and the two are separate on purpose:
		* "play the cinematic clip when DSH starts, but the short one for a new chat" is a
		* real preference, and a single global slot cannot express it. An override the host
		* cannot serve falls back to the active clip rather than showing nothing.
		*/
		function urlFor(reason) {
			const override = bridge.settings.perTriggerClip?.[reason];
			if (typeof override === "string" && override !== "") {
				const url = bridge.clips.get(override);
				if (url !== void 0) return url;
			}
			return bridge.url;
		}
		function emit() {
			for (const listener of bridge.listeners) try {
				listener(bridge.playing);
			} catch {}
		}
		/**
		* Re-read the settings, state and clip from the host.
		*
		* Failures are swallowed rather than thrown: a settings route that is briefly
		* unavailable (a restart in progress) must not take the whole client plugin down
		* with it, and the defaults are a playable configuration on their own.
		*/
		async function refreshConfig() {
			try {
				const plan = await fetchPlan();
				applyPlan(plan);
				return plan;
			} catch (error) {
				return null;
			}
		}
		/** Fold one host answer into the in-memory decision state. */
		function applyPlan(plan) {
			bridge.settings = plan.settings ?? { ...DEFAULT_SETTINGS };
			bridge.state = plan.state ?? { ...DEFAULT_STATE };
			bridge.clip = plan.clip;
			bridge.url = plan.url ?? plan.activeUrl;
			bridge.clips = new Map(Object.entries(plan.clipUrls ?? {}));
			bridge.bootId = typeof plan.bootId === "string" ? plan.bootId : null;
			bridge.appStarted = claimAppStart(bridge.bootId);
			bridge.loaded = true;
			bridge.clip?.id, bridge.settings.triggers, bridge.settings.frequency, bridge.settings.layer, bridge.appStarted;
		}
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
		function claimAppStart(bootId) {
			if (bootId === null) return true;
			try {
				const known = window.localStorage.getItem(BOOT_KEY);
				window.localStorage.setItem(BOOT_KEY, bootId);
				return known !== bootId;
			} catch {
				return true;
			}
		}
		/** A trigger happened; decide whether it plays. */
		function trigger(reason) {
			if (reason === "preview" || reason === "manual") {
				open(reason);
				return true;
			}
			if (!bridge.settings.enabled) return false;
			if (!bridge.settings.triggers.includes(reason)) return false;
			if (!allowed()) return false;
			if (reason === "newConversation" || reason === "pinnedConversation" || reason === "conversation") {
				const sessionId = bridge.sessionId;
				if (sessionId === null) return false;
				if (hasPlayed(sessionId)) return false;
				markPlayed(sessionId);
			}
			open(reason);
			return true;
		}
		/** Called by the session subscription whenever the current conversation changes. */
		function noteSession(sessionId, isNewConversation, entered) {
			bridge.sessionId = sessionId;
			bridge.isNewConversation = isNewConversation;
			if (!entered || sessionId === null) return;
			if (readPinned() === sessionId && bridge.settings.triggers.includes("pinnedConversation")) {
				if (allowed()) open("pinnedConversation");
				return;
			}
			if (isNewConversation && bridge.settings.triggers.includes("newConversation")) {
				if (hasPlayed(sessionId)) return;
				markPlayed(sessionId);
				if (allowed()) open("newConversation");
				return;
			}
			if (bridge.settings.triggers.includes("conversation")) {
				if (hasPlayed(sessionId)) return;
				markPlayed(sessionId);
				if (allowed()) open("conversation");
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
		function triggerStart() {
			const triggers = bridge.settings.triggers;
			if (bridge.appStarted) {
				if (triggers.includes("appStart")) {
					trigger("appStart");
					return;
				}
				if (triggers.includes("pageLoad")) trigger("pageLoad");
				return;
			}
			if (triggers.includes("pageLoad")) trigger("pageLoad");
		}
		/** @deprecated Renamed to triggerStart. Kept so an older call site still resolves. */
		function triggerLaunch() {
			triggerStart();
		}
		/**
		* Open the intro now.
		*
		* @param reason - What asked for it, reported as `dbaState.lastReason`.
		* @param urlOverride - Play this URL instead of the resolved one (the preview path).
		*/
		function open(reason, urlOverride) {
			const settings = bridge.settings;
			const url = urlOverride ?? urlFor(reason);
			if (url === null) {
				notify("nothing to play: no clip resolved");
				return null;
			}
			if (closeCurrent !== null) closeCurrent("replaced");
			ensureStyle();
			const root = document.createElement("div");
			root.className = "dba-root";
			root.dataset.dbaPlaying = reason;
			root.setAttribute("role", "presentation");
			root.style.setProperty("--dba-z", String(resolvedZIndex(settings)));
			root.style.setProperty("--dba-backdrop", settings.layer === "backdrop" ? `rgba(0,0,0,${String(Math.max(0, Math.min(100, settings.backdropOpacity)) / 100)})` : "rgba(0,0,0,1)");
			root.style.setProperty("--dba-video-opacity", String(Math.max(0, Math.min(100, settings.videoOpacity)) / 100));
			root.style.setProperty("--dba-fade", `${String(FADE_MS)}ms`);
			const video = document.createElement("video");
			video.className = settings.fit === "cover" ? "dba-video dba-cover" : "dba-video";
			video.src = url;
			video.muted = !settings.sound;
			video.volume = Math.max(0, Math.min(1, settings.volume / 100));
			video.defaultPlaybackRate = settings.playbackRate;
			video.playbackRate = settings.playbackRate;
			video.loop = settings.loop;
			video.playsInline = true;
			video.preload = "auto";
			video.autoplay = true;
			video.setAttribute("aria-hidden", "true");
			const controls = document.createElement("div");
			controls.className = "dba-controls";
			const status = document.createElement("div");
			status.className = "dba-status";
			status.textContent = "正在加载片头…";
			const caption = document.createElement("div");
			caption.className = "dba-caption";
			if (settings.title !== "") {
				const title = document.createElement("div");
				title.className = "dba-title";
				title.textContent = settings.title;
				caption.appendChild(title);
			}
			if (settings.subtitle !== "") {
				const subtitle = document.createElement("div");
				subtitle.className = "dba-subtitle";
				subtitle.textContent = settings.subtitle;
				caption.appendChild(subtitle);
			}
			const countdownFill = document.createElement("div");
			countdownFill.className = "dba-countdown-fill";
			const hint = document.createElement("div");
			hint.className = "dba-hint";
			root.appendChild(video);
			if (settings.title !== "" || settings.subtitle !== "") root.appendChild(caption);
			if (settings.maxSeconds > 0 && settings.showCountdown) {
				const countdown = document.createElement("div");
				countdown.className = "dba-countdown";
				countdown.appendChild(countdownFill);
				root.appendChild(countdown);
			}
			root.appendChild(status);
			root.appendChild(controls);
			let closed = false;
			const timers = [];
			const later = (fn, ms) => {
				timers.push(window.setTimeout(fn, ms));
			};
			const close = (why) => {
				if (closed) return;
				closed = true;
				for (const timer of timers) window.clearTimeout(timer);
				timers.length = 0;
				document.removeEventListener("pointerdown", onPointerDown, true);
				document.removeEventListener("keydown", onKeyDown, true);
				try {
					video.pause();
					video.removeAttribute("src");
					video.load();
				} catch {}
				if (document.fullscreenElement !== null) document.exitFullscreen?.().catch(() => {});
				root.classList.add("dba-closing");
				later(() => {
					root.remove();
				}, FADE_MS);
				if (closeCurrent === close) {
					closeCurrent = null;
					bridge.playing = false;
					emit();
				}
			};
			closeCurrent = close;
			bridge.playing = true;
			bridge.lastReason = reason;
			emit();
			const playButton = document.createElement("button");
			playButton.type = "button";
			playButton.className = "dba-btn dba-hit";
			playButton.textContent = "播放";
			playButton.hidden = true;
			playButton.addEventListener("click", (event) => {
				event.stopPropagation();
				playButton.hidden = true;
				attemptPlay();
			});
			controls.appendChild(playButton);
			let muted = video.muted;
			const soundButton = document.createElement("button");
			soundButton.type = "button";
			soundButton.className = "dba-btn dba-ghost dba-hit";
			soundButton.textContent = muted ? "🔇" : "🔊";
			soundButton.title = "切换声音（浏览器要求先有一次点击才允许出声）";
			soundButton.addEventListener("click", (event) => {
				event.stopPropagation();
				muted = !muted;
				video.muted = muted;
				soundButton.textContent = muted ? "🔇" : "🔊";
				if (!muted) video.play().catch(() => {});
			});
			controls.appendChild(soundButton);
			if (settings.allowFullscreen) {
				const fullButton = document.createElement("button");
				fullButton.type = "button";
				fullButton.className = "dba-btn dba-ghost dba-hit";
				fullButton.textContent = "⛶";
				fullButton.title = "全屏播放";
				fullButton.addEventListener("click", (event) => {
					event.stopPropagation();
					if (document.fullscreenElement === null) root.requestFullscreen?.().catch(() => {});
					else document.exitFullscreen?.().catch(() => {});
				});
				controls.appendChild(fullButton);
			}
			const skipButton = document.createElement("button");
			skipButton.type = "button";
			skipButton.className = "dba-btn dba-hit";
			skipButton.textContent = settings.skipLabel === "" ? "跳过" : settings.skipLabel;
			skipButton.addEventListener("click", (event) => {
				event.stopPropagation();
				close("skip");
			});
			if (settings.showSkip && settings.skipAfterMs <= 0) controls.appendChild(skipButton);
			if (settings.hintLabel !== "") {
				hint.textContent = settings.hintLabel;
				root.appendChild(hint);
			}
			const attemptPlay = async () => {
				try {
					await video.play();
					status.style.display = "none";
					root.dataset.dbaState = "playing";
				} catch (error) {
					root.dataset.dbaState = "awaiting-gesture";
					playButton.hidden = false;
					status.textContent = "点击「播放」开始片头";
				}
			};
			const report = (label) => notify(label, {
				reason,
				clip: bridge.clip?.id ?? null,
				src: video.currentSrc === "" ? video.src : video.currentSrc,
				readyState: video.readyState,
				networkState: video.networkState
			});
			video.addEventListener("playing", () => {
				status.style.display = "none";
				report("first frame painted");
			});
			video.addEventListener("ended", () => close("ended"));
			video.addEventListener("error", () => {
				notify("video element error", {
					code: video.error?.code ?? 0,
					message: video.error?.message ?? "",
					src: video.currentSrc || url
				});
				status.textContent = "片头加载失败 —— 控制台有 [dsh-boot-animation] 日志";
				later(() => close("error"), 8e3);
			});
			later(() => {
				if (!closed && video.readyState < 2) {
					report("stalled, giving up");
					close("stalled");
				}
			}, Math.max(3e3, settings.stallTimeoutMs));
			if (settings.maxSeconds > 0) {
				const totalMs = settings.maxSeconds * 1e3;
				const startedAt = performance.now();
				const step = () => {
					if (closed) return;
					const elapsed = performance.now() - startedAt;
					countdownFill.style.transform = `scaleX(${String(Math.max(0, 1 - elapsed / totalMs))})`;
					if (elapsed >= totalMs) {
						close("maxSeconds");
						return;
					}
					window.requestAnimationFrame(step);
				};
				window.requestAnimationFrame(step);
			}
			if (settings.showSkip && settings.skipAfterMs > 0) later(() => {
				if (!closed && skipButton.parentElement === null) controls.appendChild(skipButton);
			}, settings.skipAfterMs);
			/**
			* Dismiss on real interaction with the page behind.
			*
			* A capture-phase listener on the document, because the overlay itself is
			* `pointer-events: none`: a click on a desktop pet or on the app must reach its
			* target AND end an intro the user has visibly stopped watching. Keydown is
			* included so typing dismisses it too.
			*/
			function onPointerDown(event) {
				const target = event.target;
				if (target instanceof Node && root.contains(target)) return;
				if (settings.dismissOnInteract) close("interact");
			}
			function onKeyDown(event) {
				if (event.key === "Escape") {
					close("escape");
					return;
				}
				if (!settings.dismissOnInteract) return;
				if (root.dataset.dbaState === "awaiting-gesture") return;
				if (event.target instanceof Node && root.contains(event.target)) return;
				close("interact");
			}
			if (settings.dismissOnInteract || settings.showSkip) {
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown, true);
			}
			document.body.appendChild(root);
			if (settings.delayMs > 0) later(() => {
				if (!closed) attemptPlay();
			}, settings.delayMs);
			else attemptPlay();
			if (reason !== "preview" && reason !== "manual") reportPlayed({
				...bridge.clip?.id == null ? {} : { clipId: bridge.clip.id },
				...bridge.sessionId == null ? {} : { conversationId: bridge.sessionId }
			}).then((answer) => {
				if (answer.ok && answer.state !== void 0) bridge.state = answer.state;
			}).catch(() => {});
			return { close };
		}
		function installBridge(version) {
			const api = {
				version,
				get settings() {
					return bridge.settings;
				},
				get state() {
					return bridge.state;
				},
				get playing() {
					return bridge.playing;
				},
				get clip() {
					return bridge.clip;
				},
				get url() {
					return bridge.url;
				},
				get lastReason() {
					return bridge.lastReason;
				},
				get appStart() {
					return bridge.appStarted;
				},
				play: (reason = "manual") => {
					open(reason);
				},
				close: (reason = "manual") => {
					closeCurrent?.(reason);
				},
				refresh: async () => {
					await refreshConfig();
				},
				forgetConversations: () => {
					forgetPlayedConversations();
				},
				onPlayingChange: (listener) => {
					bridge.listeners.add(listener);
					return () => {
						bridge.listeners.delete(listener);
					};
				}
			};
			try {
				window.__dshBootAnimation = api;
			} catch {}
		}
		//#endregion
		//#region src/client/settings-panel.tsx
		function formatBytes(n) {
			if (!Number.isFinite(n) || n <= 0) return "0 B";
			if (n < 1024) return n + " B";
			if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
			return (n / 1024 / 1024).toFixed(2) + " MB";
		}
		function formatWhen(iso) {
			if (iso === null) return "还没有播放过";
			const at = Date.parse(iso);
			if (!Number.isFinite(at)) return "记录不可读";
			const delta = Date.now() - at;
			if (delta < 6e4) return "刚刚";
			if (delta < 36e5) return `${String(Math.round(delta / 6e4))} 分钟前`;
			if (delta < 864e5) return `${String(Math.round(delta / 36e5))} 小时前`;
			return new Date(at).toLocaleString();
		}
		/** Where a clip comes from, as one word a user can act on. */
		const SOURCE_LABEL = {
			yours: "你自己加的",
			embedded: "插件内置",
			env: "环境变量"
		};
		/**
		* Trigger copy.
		*
		* `appStart` is the headline: this plugin exists to play DeepSeek Harness's own
		* startup animation. `pageLoad` is spelled out separately because it is the F5
		* case, and a user who turns it on should know that is what they asked for.
		*/
		const TRIGGER_LABEL = {
			appStart: {
				title: "启动 DSH 时",
				detail: "每次打开 DeepSeek Harness 播一次"
			},
			pageLoad: {
				title: "页面刷新时（F5）",
				detail: "应用没重启也算一次"
			},
			newConversation: {
				title: "新对话时",
				detail: "每个新对话一次"
			},
			pinnedConversation: {
				title: "钉住的会话",
				detail: "每次进入都播"
			},
			conversation: {
				title: "任意会话",
				detail: "每个会话首次进入"
			}
		};
		const FREQUENCY_LABEL = {
			every: {
				title: "每次都播",
				detail: "符合触发器就播"
			},
			daily: {
				title: "每天一次",
				detail: "当天已播过就不再播"
			},
			once: {
				title: "只播一次",
				detail: "直到你点「重置播放记录」"
			},
			count: {
				title: "限制次数",
				detail: "播满设定次数为止"
			}
		};
		const LAYER_LABEL = {
			overlay: {
				title: "盖住一切",
				detail: "片头在最上层，桌宠被遮住"
			},
			backdrop: {
				title: "放在桌宠下面",
				detail: "桌宠仍可点击，片头在其下播放"
			}
		};
		function Row({ label, children, note }) {
			return (0, react.createElement)("div", null, (0, react.createElement)("div", { className: "dba-row" }, (0, react.createElement)("span", { className: "dba-lab" }, label), (0, react.createElement)("span", { className: "dba-ctl" }, children)), note === void 0 ? null : (0, react.createElement)("div", { className: "dba-note" }, note));
		}
		function Slider({ limit, value, suffix, onCommit }) {
			const [local, setLocal] = (0, react.useState)(value);
			const dragging = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (!dragging.current) setLocal(value);
			}, [value]);
			return (0, react.createElement)("span", { style: {
				display: "flex",
				alignItems: "center",
				gap: "8px",
				flex: 1,
				minWidth: "160px"
			} }, (0, react.createElement)("input", {
				type: "range",
				min: limit.min,
				max: limit.max,
				step: limit.step,
				value: local,
				onPointerDown: () => {
					dragging.current = true;
				},
				onChange: (event) => {
					setLocal(Number(event.target.value));
				},
				onPointerUp: () => {
					dragging.current = false;
					onCommit(local);
				},
				onKeyUp: () => {
					onCommit(local);
				}
			}), (0, react.createElement)("span", { className: "dba-val" }, `${String(local)}${suffix ?? ""}`));
		}
		function Toggle({ value, onChange, label }) {
			return (0, react.createElement)("label", { style: {
				display: "inline-flex",
				alignItems: "center",
				gap: "6px",
				cursor: "pointer"
			} }, (0, react.createElement)("input", {
				type: "checkbox",
				checked: value,
				onChange: (event) => onChange(event.target.checked)
			}), label === void 0 ? null : (0, react.createElement)("span", null, label));
		}
		function TextField({ value, placeholder, maxLength, onCommit }) {
			const [local, setLocal] = (0, react.useState)(value);
			(0, react.useEffect)(() => {
				setLocal(value);
			}, [value]);
			return (0, react.createElement)("input", {
				type: "text",
				value: local,
				placeholder: placeholder ?? "",
				maxLength,
				onChange: (event) => setLocal(event.target.value),
				onBlur: () => onCommit(local),
				onKeyDown: (event) => {
					if (event.key === "Enter") onCommit(local);
				}
			});
		}
		function Chip({ title, detail, on, onClick }) {
			return (0, react.createElement)("div", {
				className: on ? "dba-chip dba-on" : "dba-chip",
				onClick
			}, (0, react.createElement)("span", { className: "dba-chip-t" }, on ? "✓ " + title : title), (0, react.createElement)("span", { className: "dba-chip-d" }, detail));
		}
		function SettingsPanel({ onClose, onPreview }) {
			ensureStyle();
			const [config, setConfig] = (0, react.useState)(null);
			const [tab, setTab] = (0, react.useState)("triggers");
			const [msg, setMsg] = (0, react.useState)({
				text: "",
				kind: ""
			});
			const [busy, setBusy] = (0, react.useState)(false);
			const load = (0, react.useCallback)(async () => {
				try {
					const next = await fetchConfig();
					setConfig(next);
					setMsg({
						text: "",
						kind: ""
					});
				} catch (error) {
					setMsg({
						text: "读取设置失败：" + String(error),
						kind: "dba-err"
					});
				}
			}, []);
			(0, react.useEffect)(() => {
				load();
			}, [load]);
			(0, react.useEffect)(() => {
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [onClose]);
			/**
			* Optimistic write: the local view updates first, then the host's answer replaces
			* it. A slider that waited for a round trip per step would feel broken on a slow
			* disk, and the host is the authority either way.
			*/
			const patch = (0, react.useCallback)(async (change, note) => {
				setBusy(true);
				setConfig((current) => current === null ? current : {
					...current,
					settings: {
						...current.settings,
						...change
					}
				});
				try {
					const answer = await saveSettings(change);
					if (answer.ok !== true) setMsg({
						text: "保存失败：" + String(answer.error ?? "未知错误"),
						kind: "dba-err"
					});
					else if (answer.settings !== void 0) {
						const saved = answer.settings;
						setConfig((current) => current === null ? current : {
							...current,
							settings: saved,
							...answer.state === void 0 ? {} : { state: answer.state },
							...answer.clips === void 0 ? {} : { clips: answer.clips }
						});
						if (note !== void 0) setMsg({
							text: note,
							kind: "dba-ok"
						});
					}
					await refreshConfig();
				} catch (error) {
					setMsg({
						text: "保存失败：" + String(error),
						kind: "dba-err"
					});
				} finally {
					setBusy(false);
				}
			}, []);
			const choose = (0, react.useCallback)(async (clip) => {
				setBusy(true);
				try {
					const answer = await selectClip(clip.id);
					if (answer.ok === true) {
						setMsg({
							text: "已切换：" + String(answer.name ?? clip.id),
							kind: "dba-ok"
						});
						await load();
						await refreshConfig();
					} else setMsg({
						text: "切换失败：" + String(answer.error ?? "未知错误"),
						kind: "dba-err"
					});
				} catch (error) {
					setMsg({
						text: "操作失败：" + String(error),
						kind: "dba-err"
					});
				} finally {
					setBusy(false);
				}
			}, [load]);
			const settings = config?.settings ?? null;
			const clips = config?.clips ?? [];
			const state = config?.state ?? null;
			const limits = config?.limits ?? SETTINGS_LIMITS;
			const activeName = config === null ? "…" : config.active === null ? "（没有可用的片子）" : `${config.active.name}（${config.active.how}）`;
			const setTrigger = (trigger, on) => {
				if (settings === null) return;
				const next = on ? TRIGGERS.filter((t) => settings.triggers.includes(t) || t === trigger) : settings.triggers.filter((t) => t !== trigger);
				patch({ triggers: [...next] }, on ? `已开启：${TRIGGER_LABEL[trigger].title}` : `已关闭：${TRIGGER_LABEL[trigger].title}`);
			};
			return (0, react.createElement)("div", {
				className: "dba-veil",
				onClick: (event) => {
					if (event.target === event.currentTarget) onClose();
				}
			}, (0, react.createElement)("div", {
				className: "dba-lib",
				onClick: (event) => event.stopPropagation()
			}, (0, react.createElement)("h3", null, "片头动画设置"), (0, react.createElement)("p", null, "当前会播：", (0, react.createElement)("strong", null, activeName), state === null ? null : ` · 已播 ${String(state.runs)} 次 · 上次 ${formatWhen(state.ranAt)}`), (0, react.createElement)("div", { className: "dba-tabs" }, ...[
				["triggers", "什么时候播"],
				["playback", "怎么播"],
				["clips", "片子"]
			].map(([key, label]) => (0, react.createElement)("button", {
				key,
				type: "button",
				className: tab === key ? "dba-tab dba-on" : "dba-tab",
				onClick: () => setTab(key)
			}, label))), settings === null ? (0, react.createElement)("div", { className: "dba-item" }, (0, react.createElement)("span", { className: "dba-nm" }, "读取中…")) : null, settings !== null && tab === "triggers" ? (0, react.createElement)("div", null, (0, react.createElement)(Row, { label: "总开关" }, (0, react.createElement)(Toggle, {
				value: settings.enabled,
				onChange: (value) => {
					patch({ enabled: value }, value ? "已开启片头动画" : "已关闭片头动画");
				},
				label: settings.enabled ? "开启" : "关闭"
			})), (0, react.createElement)("h4", null, "触发时机（可多选）"), (0, react.createElement)("div", { className: "dba-grid" }, ...TRIGGERS.map((trigger) => (0, react.createElement)(Chip, {
				key: trigger,
				title: TRIGGER_LABEL[trigger].title,
				detail: TRIGGER_LABEL[trigger].detail,
				on: settings.triggers.includes(trigger),
				onClick: () => setTrigger(trigger, !settings.triggers.includes(trigger))
			}))), (0, react.createElement)("p", null, "「启动 DSH 时」只在应用真正启动的那一次播放；同一个应用会话里按 F5 刷新不算启动。"), (0, react.createElement)("h4", null, "播放频率"), (0, react.createElement)("div", { className: "dba-grid" }, ...FREQUENCIES.map((frequency) => {
				const meta = FREQUENCY_LABEL[frequency] ?? {
					title: frequency,
					detail: ""
				};
				return (0, react.createElement)(Chip, {
					key: frequency,
					title: meta.title,
					detail: meta.detail,
					on: settings.frequency === frequency,
					onClick: () => {
						patch({ frequency }, `频率：${meta.title}`);
					}
				});
			})), settings.frequency === "count" ? (0, react.createElement)(Row, { label: "播放次数上限" }, (0, react.createElement)(Slider, {
				limit: limits.playCount,
				value: settings.playCount,
				suffix: " 次",
				onCommit: (value) => void patch({ playCount: value })
			})) : null, (0, react.createElement)(Row, {
				label: "延迟开始",
				note: "给 DSH 一点启动时间再放片头；0 表示立刻开始。"
			}, (0, react.createElement)(Slider, {
				limit: limits.delayMs,
				value: settings.delayMs,
				suffix: " ms",
				onCommit: (value) => void patch({ delayMs: value })
			})), (0, react.createElement)(Row, { label: "互动即关闭" }, (0, react.createElement)(Toggle, {
				value: settings.dismissOnInteract,
				onChange: (value) => void patch({ dismissOnInteract: value }),
				label: "点击页面任意处即关闭片头（推荐：不挡住桌宠操作）"
			})), (0, react.createElement)("h4", null, "片头时长"), (0, react.createElement)(Row, {
				label: "最长播放",
				note: "0 表示播完为止；设置后到点自动关闭，循环播放也受它约束。"
			}, (0, react.createElement)(Slider, {
				limit: limits.maxSeconds,
				value: settings.maxSeconds,
				suffix: " 秒",
				onCommit: (value) => void patch({ maxSeconds: value })
			})), (0, react.createElement)(Row, { label: "倒计时进度条" }, (0, react.createElement)(Toggle, {
				value: settings.showCountdown,
				onChange: (value) => void patch({ showCountdown: value }),
				label: "在底部显示剩余时间"
			})), (0, react.createElement)(Row, { label: "看门狗超时" }, (0, react.createElement)(Slider, {
				limit: limits.stallTimeoutMs,
				value: settings.stallTimeoutMs,
				suffix: " ms",
				onCommit: (value) => void patch({ stallTimeoutMs: value })
			})), (0, react.createElement)("h4", null, "钉住的会话"), (0, react.createElement)("div", { className: "dba-row" }, (0, react.createElement)("span", { className: "dba-lab" }, "当前钉住"), (0, react.createElement)("span", { className: "dba-ctl" }, (0, react.createElement)("code", null, readPinned() ?? "（未钉住）"), (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn dba-panel",
				onClick: () => {
					onClose();
					window.alert("请在左侧边栏页脚的 🎞 图钉上设置要钉住的会话。");
				}
			}, "怎么设置？")))) : null, settings !== null && tab === "playback" ? (0, react.createElement)("div", null, (0, react.createElement)("h4", null, "画面"), (0, react.createElement)(Row, { label: "贴合方式" }, (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn dba-panel" + (settings.fit === "cover" ? " dba-btn-on" : ""),
				onClick: () => void patch({ fit: "cover" }, "已设为铺满屏幕")
			}, "铺满屏幕"), (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn dba-panel" + (settings.fit === "contain" ? " dba-btn-on" : ""),
				onClick: () => void patch({ fit: "contain" }, "已设为完整显示")
			}, "完整显示")), (0, react.createElement)(Row, {
				label: "叠加层级",
				note: "「盖住一切」用于纯粹的开机动画；「放在桌宠下面」让桌宠在片头播放时仍可点。"
			}, ...LAYERS.map((layer) => (0, react.createElement)("button", {
				key: layer,
				type: "button",
				className: "dba-btn dba-panel" + (settings.layer === layer ? " dba-btn-on" : ""),
				title: LAYER_LABEL[layer].detail,
				onClick: () => void patch({ layer }, `层级：${LAYER_LABEL[layer].title}`)
			}, LAYER_LABEL[layer].title))), (0, react.createElement)(Row, { label: "背景不透明度" }, (0, react.createElement)(Slider, {
				limit: limits.backdropOpacity,
				value: settings.backdropOpacity,
				suffix: "%",
				onCommit: (value) => void patch({ backdropOpacity: value })
			})), (0, react.createElement)(Row, { label: "视频不透明度" }, (0, react.createElement)(Slider, {
				limit: limits.videoOpacity,
				value: settings.videoOpacity,
				suffix: "%",
				onCommit: (value) => void patch({ videoOpacity: value })
			})), (0, react.createElement)(Row, {
				label: "堆叠层级 z-index",
				note: `0 = 用当前层级的默认值（现在解析为 ${String(resolvedZIndex(settings))}）。和别的插件打架时可以调这里。`
			}, (0, react.createElement)(Slider, {
				limit: limits.zIndex,
				value: settings.zIndex,
				onCommit: (value) => void patch({ zIndex: value })
			})), (0, react.createElement)("h4", null, "播放"), (0, react.createElement)(Row, { label: "播放速度" }, (0, react.createElement)(Slider, {
				limit: limits.playbackRate,
				value: settings.playbackRate,
				suffix: "×",
				onCommit: (value) => void patch({ playbackRate: value })
			})), (0, react.createElement)(Row, { label: "循环播放" }, (0, react.createElement)(Toggle, {
				value: settings.loop,
				onChange: (value) => void patch({ loop: value }),
				label: "播完从头再来（配合「最长播放」使用）"
			})), (0, react.createElement)("h4", null, "声音"), (0, react.createElement)(Row, { label: "默认有声" }, (0, react.createElement)(Toggle, {
				value: settings.sound,
				onChange: (value) => void patch({ sound: value }),
				label: "浏览器仍要求先点一次页面才会出声"
			})), (0, react.createElement)(Row, { label: "音量" }, (0, react.createElement)(Slider, {
				limit: limits.volume,
				value: settings.volume,
				suffix: "%",
				onCommit: (value) => void patch({ volume: value })
			})), (0, react.createElement)("h4", null, "关闭方式"), (0, react.createElement)(Row, { label: "跳过按钮" }, (0, react.createElement)(Toggle, {
				value: settings.showSkip,
				onChange: (value) => void patch({ showSkip: value }),
				label: "显示「" + settings.skipLabel + "」"
			})), (0, react.createElement)(Row, { label: "延迟出现跳过" }, (0, react.createElement)(Slider, {
				limit: limits.skipAfterMs,
				value: settings.skipAfterMs,
				suffix: " ms",
				onCommit: (value) => void patch({ skipAfterMs: value })
			})), (0, react.createElement)(Row, { label: "允许全屏" }, (0, react.createElement)(Toggle, {
				value: settings.allowFullscreen,
				onChange: (value) => void patch({ allowFullscreen: value }),
				label: "提供 ⛶ 按钮"
			}))) : null, settings !== null && tab === "clips" ? (0, react.createElement)("div", null, (0, react.createElement)("h4", null, "选一段作为片头"), ...clips.length === 0 ? [(0, react.createElement)("div", { className: "dba-item" }, (0, react.createElement)("span", { className: "dba-nm" }, "（还没找到任何视频）"))] : clips.map((clip) => (0, react.createElement)("div", {
				key: clip.id,
				className: "dba-item" + (clip.id === settings.clipId ? " dba-cur" : ""),
				title: clip.id,
				onClick: () => {
					if (!busy && clip.id !== settings.clipId) choose(clip);
				}
			}, (0, react.createElement)("span", { className: "dba-mark" }, clip.id === settings.clipId ? "✓" : ""), (0, react.createElement)("span", { className: "dba-nm" }, clip.name), (0, react.createElement)("span", { className: "dba-badge" }, SOURCE_LABEL[clip.source] ?? clip.source), (0, react.createElement)("span", { className: "dba-meta" }, formatBytes(clip.bytes)), (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn dba-panel",
				onClick: (event) => {
					event.stopPropagation();
					onPreview(clip.id);
				}
			}, "▶ 试播"))), (0, react.createElement)("h4", null, "按触发器分别指定（可选）"), (0, react.createElement)("p", null, "留空表示用上面选中的那一段。"), ...TRIGGERS.map((trigger) => (0, react.createElement)(Row, {
				key: trigger,
				label: TRIGGER_LABEL[trigger].title
			}, (0, react.createElement)("select", {
				value: settings.perTriggerClip[trigger] ?? "",
				style: {
					background: "transparent",
					color: "inherit",
					fontFamily: "inherit",
					fontSize: "12.5px",
					border: "1px solid rgba(127,127,127,.34)",
					borderRadius: "7px",
					padding: "4px 8px",
					flex: 1,
					minWidth: "120px"
				},
				onChange: (event) => {
					const value = event.target.value;
					const next = { ...settings.perTriggerClip };
					if (value === "") delete next[trigger];
					else next[trigger] = value;
					patch({ perTriggerClip: next }, `已更新「${TRIGGER_LABEL[trigger].title}」`);
				}
			}, (0, react.createElement)("option", { value: "" }, "（用全局选择）"), ...clips.map((clip) => (0, react.createElement)("option", {
				key: clip.id,
				value: clip.id
			}, clip.name))))), (0, react.createElement)("div", { className: "dba-dir" }, "想加自己的片子：把 mp4/webm 放进这个文件夹，再点「刷新」", (0, react.createElement)("br", null), (0, react.createElement)("code", null, config?.userDir ?? "…"), (0, react.createElement)("br", null), "设置文件：", (0, react.createElement)("code", null, config?.settingsFile ?? "…")), (0, react.createElement)("h4", null, "画面上的文字"), (0, react.createElement)(Row, { label: "标题" }, (0, react.createElement)(TextField, {
				value: settings.title,
				placeholder: "例如：欢迎回来",
				maxLength: limits.title.maxLength,
				onCommit: (value) => void patch({ title: value })
			})), (0, react.createElement)(Row, { label: "副标题" }, (0, react.createElement)(TextField, {
				value: settings.subtitle,
				placeholder: "例如：DeepSeek Harness",
				maxLength: limits.subtitle.maxLength,
				onCommit: (value) => void patch({ subtitle: value })
			})), (0, react.createElement)(Row, { label: "跳过按钮文字" }, (0, react.createElement)(TextField, {
				value: settings.skipLabel,
				maxLength: limits.skipLabel.maxLength,
				onCommit: (value) => void patch({ skipLabel: value })
			})), (0, react.createElement)(Row, { label: "底部提示文字" }, (0, react.createElement)(TextField, {
				value: settings.hintLabel,
				placeholder: "留空则不显示",
				maxLength: limits.hintLabel.maxLength,
				onCommit: (value) => void patch({ hintLabel: value })
			}))) : null, (0, react.createElement)("div", { className: "dba-bar" }, (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn dba-btn-preview",
				title: "立刻按当前设置播一次，不用等下一次启动",
				onClick: () => onPreview(null)
			}, "▶ 立即试播"), (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn dba-panel",
				title: "忘掉「哪些会话已经播过」与播放次数",
				onClick: () => {
					(async () => {
						forgetPlayedConversations();
						await resetState("state");
						await load();
						await refreshConfig();
						setMsg({
							text: "已重置播放记录",
							kind: "dba-ok"
						});
					})();
				}
			}, "重置播放记录"), (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn dba-panel",
				onClick: () => void load()
			}, "刷新"), (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn dba-panel",
				title: "把当前设置复制到剪贴板，便于排查",
				onClick: () => {
					const payload = {
						settings,
						state,
						active: config?.active ?? null,
						clips: clips.map((clip) => clip.id)
					};
					navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)).then(() => setMsg({
						text: "已复制诊断信息到剪贴板",
						kind: "dba-ok"
					}), () => setMsg({
						text: "复制失败（浏览器未授权剪贴板）",
						kind: "dba-err"
					}));
				}
			}, "复制诊断"), (0, react.createElement)("button", {
				type: "button",
				className: "dba-btn dba-panel",
				onClick: onClose
			}, "关闭")), (0, react.createElement)("div", { className: "dba-msg " + msg.kind }, msg.text)));
		}
		//#endregion
		//#region src/client/index.ts
		/** Slot service for the one sidebar seat. Everything else is plain DOM. */
		const inject = ["slots"];
		const VERSION = "0.3.0";
		/**
		* The current conversation, read from the store directly.
		*
		* Subscribed with the store's own `subscribe`/`getSnapshot`, not with a React
		* hook: the overlay lives outside React, so the trigger logic cannot be a hook.
		* A missing store is a supported state - the launch trigger does not need it.
		*/
		function watchSession(store) {
			if (store === null) return () => {};
			let last = null;
			const read = () => {
				let binding = null;
				try {
					binding = store.getSnapshot();
				} catch {
					return;
				}
				const sessionId = typeof binding?.props?.sessionId === "string" ? binding.props.sessionId : null;
				const isNew = binding?.hooks?.session?.blankBit === true;
				const entered = last !== sessionId;
				last = sessionId;
				noteSession(sessionId, isNew, entered);
			};
			read();
			return store.subscribe(read);
		}
		/** Resolve the current-conversation store, tolerating a host that has none. */
		function resolveStore(ctx) {
			try {
				const candidate = (ctx.get?.("uiSession"))?.adapter?.current;
				return candidate !== void 0 && typeof candidate.getSnapshot === "function" && typeof candidate.subscribe === "function" ? candidate : null;
			} catch {
				return null;
			}
		}
		function apply(ctx) {
			ensureStyle();
			installBridge(VERSION);
			const unwatch = watchSession(resolveStore(ctx));
			(async () => {
				await refreshConfig();
				window.requestAnimationFrame(() => {
					triggerLaunch();
				});
			})();
			const SidebarEntry = () => {
				const [panelOpen, setPanelOpen] = (0, react.useState)(false);
				if (panelOpen) return (0, react.createElement)(SettingsPanel, {
					onClose: () => setPanelOpen(false),
					onPreview: (clipId) => {
						setPanelOpen(false);
						window.setTimeout(() => {
							if (clipId === null) open("preview");
							else previewClipById(clipId);
						}, 80);
					}
				});
				return (0, react.createElement)("button", {
					type: "button",
					className: "dba-btn dba-panel dba-hit",
					style: {
						width: "28px",
						height: "28px",
						padding: "0",
						borderRadius: "8px",
						border: "0"
					},
					title: "片头动画：设置什么时候播、怎么播、播哪一段",
					"aria-label": "片头动画设置",
					onClick: () => setPanelOpen(true)
				}, "🎬");
			};
			const mount = () => {
				ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
					name: "sidebar.footer.action",
					id: "dsh-boot-animation-panel",
					order: 40,
					label: () => "片头动画"
				}, SidebarEntry));
			};
			if (typeof ctx.effect === "function") ctx.effect(() => {
				mount();
				return () => {
					unwatch();
				};
			}, "dsh-boot-animation: mounts");
			else mount();
		}
		/**
		* Play one clip by id, for a per-clip preview.
		*
		* The host exposes every clip at `/media/<id>` with its content key pinned, so a
		* preview plays the clip the user clicked without first having to save it as the
		* pick - which is the difference between "试播" and "设成片头再看一次".
		*/
		async function previewClipById(clipId) {
			let url = "/dsh-boot-animation/media/" + encodeURIComponent(clipId);
			try {
				const clip = (await fetchConfig()).clips.find((entry) => entry.id === clipId);
				if (clip !== void 0) url = clip.urls.media;
			} catch {}
			open("preview", url);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map