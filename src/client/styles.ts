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

export const STYLE_ID = 'dsh-boot-animation-style'

export const CSS = `
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
/* 面板由 index.ts 挂到 document.body（React root），所以这里的 position:fixed 真的以
   视口为参照：放进侧栏插槽时，外壳的 overflow/transform 会把它裁掉，实测表现为
   "右边没变暗、底部设置跑到屏幕外"。
   高度用百分比而不是 vh：系统缩放较大时 vh 与实际可视高度不一致（面板会被顶出屏幕）。 */
.dba-veil{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.46);
  display:flex;align-items:center;justify-content:center;padding:min(4vh,28px) 16px;
  pointer-events:auto;overflow:hidden}
.dba-lib{width:min(980px,100%);max-height:100%;display:flex;flex-direction:column;
  overflow:hidden;
  background:var(--dsw-alias-bg-elevated,#fff);color:var(--dsw-alias-text-primary,#191919);
  border:1px solid rgba(127,127,127,.28);border-radius:14px;padding:0;
  box-shadow:0 18px 60px rgba(0,0,0,.34);font-family:inherit;
  font-size:13px;line-height:1.55}
/* 三段式：头（标题/当前会播/页签）与底（操作按钮/提示）固定，只有中间滚动 ——
   这样无论窗口多小，"片头时长/看门狗超时"这些都能滚到，按钮也始终点得到。 */
.dba-head{flex:0 0 auto;padding:18px 18px 0;border-bottom:1px solid rgba(127,127,127,.18)}
.dba-body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;
  padding:0 18px 8px}
.dba-foot{flex:0 0 auto;padding:0 18px 12px;border-top:1px solid rgba(127,127,127,.18);
  background:var(--dsw-alias-bg-elevated,#fff)}
@media (max-width:820px){ .dba-tabs{flex-wrap:wrap} .dba-note{margin-left:0} }
@media (max-height:560px){ .dba-head{padding-top:12px} .dba-lib{font-size:12.5px} }
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
/* --- upload + inline preview (0.3.2) ------------------------------------- */
/* The player is why this panel exists: comparing clips used to mean playing each
   one full screen, which is the one view in which a clip cannot be compared. */
.dba-upload{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 10px}
.dba-preview{width:100%;max-height:min(46vh,420px);background:#000;border-radius:10px;
  border:1px solid rgba(127,127,127,.28);margin:6px 0 4px;display:block}
.dba-preview-cap{display:flex;align-items:center;gap:8px;margin:0 0 8px}
/* Whole-dialog drop target: the drop hint has to be unmissable, because a file
   dropped outside the modal is opened by the browser instead of uploaded. */
.dba-lib.dba-drop-hot{outline:2px dashed rgba(7,193,96,.75);outline-offset:-6px;
  background:rgba(7,193,96,.06)}
.dba-btn:disabled{opacity:.5;cursor:not-allowed}
`

/** Inject the sheet once. Idempotent, so a second call is free. */
export function ensureStyle(): void {
  if (document.getElementById(STYLE_ID) !== null) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = CSS
  document.head.appendChild(style)
}
