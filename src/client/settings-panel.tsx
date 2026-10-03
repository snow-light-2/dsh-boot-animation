/**
 * @dsh-external/dsh-boot-animation - the settings panel.
 *
 * One dialog, three tabs, mounted into the sidebar footer beside the pet and the
 * doctor. It replaced the old "library only" dialog because the plugin now has
 * decisions a library cannot express: is this an application-start animation or a
 * per-conversation one, how often, how long, with sound, and whether it may cover
 * a desktop pet.
 *
 * What this component is careful about:
 *
 *   - It never renders a component it did not import. A slot registration whose
 *     component resolved to `undefined` - the shape a missing injected package
 *     takes - is the failure that shows up as a React "element type is invalid"
 *     white screen. Everything here is a React intrinsic element plus this file's
 *     own imports.
 *   - Every write is a PATCH of the changed key only, so a panel left open while
 *     another surface changes a setting cannot clobber it.
 *   - Ranges come from the host (`limits`), so the UI cannot offer a value the
 *     server would clamp away.
 *   - A clip pick is written through both the settings route and the historical
 *     select route, so a rollback to the previous plugin version still sees it.
 */

import type { ReactElement } from 'react'
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'

import {
  FREQUENCIES,
  LAYERS,
  SETTINGS_LIMITS,
  TRIGGERS,
  resolvedZIndex,
} from '../shared/settings.js'
import type { BootSettings, BootState, NumericLimit, TriggerName } from '../shared/settings.js'
import {
  fetchConfig,
  resetState,
  saveSettings,
  selectClip as selectClipRoute,
  uploadVideo,
  type ClipEntry,
  type ConfigPayload,
} from './api.js'
import { forgetPlayedConversations, readPinned, refreshConfig } from './boot-overlay.js'
import { ensureStyle } from './styles.js'

/* ------------------------------------------------------------------ helpers */

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB'
  return (n / 1024 / 1024).toFixed(2) + ' MB'
}

function formatWhen(iso: string | null): string {
  if (iso === null) return '还没有播放过'
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return '记录不可读'
  const delta = Date.now() - at
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${String(Math.round(delta / 60_000))} 分钟前`
  if (delta < 86_400_000) return `${String(Math.round(delta / 3_600_000))} 小时前`
  return new Date(at).toLocaleString()
}

/** Where a clip comes from, as one word a user can act on. */
const SOURCE_LABEL: Record<string, string> = {
  yours: '你自己加的',
  embedded: '插件内置',
  env: '环境变量',
}

/**
 * Trigger copy.
 *
 * `appStart` is the headline: this plugin exists to play DeepSeek Harness's own
 * startup animation. `pageLoad` is spelled out separately because it is the F5
 * case, and a user who turns it on should know that is what they asked for.
 */
const TRIGGER_LABEL: Record<TriggerName, { title: string; detail: string }> = {
  appStart: { title: '启动 DSH 时', detail: '每次打开 DeepSeek Harness 播一次' },
  pageLoad: { title: '页面刷新时（F5）', detail: '应用没重启也算一次' },
  newConversation: { title: '新对话时', detail: '每个新对话一次' },
  pinnedConversation: { title: '钉住的会话', detail: '每次进入都播' },
  conversation: { title: '任意会话', detail: '每个会话首次进入' },
}

const FREQUENCY_LABEL: Record<string, { title: string; detail: string }> = {
  every: { title: '每次都播', detail: '符合触发器就播' },
  daily: { title: '每天一次', detail: '当天已播过就不再播' },
  once: { title: '只播一次', detail: '直到你点「重置播放记录」' },
  count: { title: '限制次数', detail: '播满设定次数为止' },
}

const LAYER_LABEL: Record<string, { title: string; detail: string }> = {
  overlay: { title: '盖住一切', detail: '片头在最上层，桌宠被遮住' },
  backdrop: { title: '放在桌宠下面', detail: '桌宠仍可点击，片头在其下播放' },
}

/* --------------------------------------------------------------- primitives */

type RowProps = { label: string; children?: unknown; note?: string }

function Row({ label, children, note }: RowProps): ReactElement {
  return h(
    'div',
    null,
    h(
      'div',
      { className: 'dba-row' },
      h('span', { className: 'dba-lab' }, label),
      h('span', { className: 'dba-ctl' }, children as never),
    ),
    note === undefined ? null : h('div', { className: 'dba-note' }, note),
  )
}

function Slider({
  limit,
  value,
  suffix,
  onCommit,
}: {
  limit: NumericLimit
  value: number
  suffix?: string
  onCommit: (value: number) => void
}): ReactElement {
  const [local, setLocal] = useState(value)
  // Keep in step when the panel reloads (or another writer changes the value),
  // without fighting the user mid-drag.
  const dragging = useRef(false)
  useEffect(() => {
    if (!dragging.current) setLocal(value)
  }, [value])
  return h(
    'span',
    { style: { display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: '160px' } },
    h('input', {
      type: 'range',
      min: limit.min,
      max: limit.max,
      step: limit.step,
      value: local,
      onPointerDown: () => {
        dragging.current = true
      },
      onChange: (event: { target: { value: string } }) => {
        setLocal(Number(event.target.value))
      },
      onPointerUp: () => {
        dragging.current = false
        onCommit(local)
      },
      onKeyUp: () => {
        onCommit(local)
      },
    }),
    h('span', { className: 'dba-val' }, `${String(local)}${suffix ?? ''}`),
  )
}

function Toggle({
  value,
  onChange,
  label,
}: {
  value: boolean
  onChange: (value: boolean) => void
  label?: string
}): ReactElement {
  return h(
    'label',
    { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', cursor: 'pointer' } },
    h('input', {
      type: 'checkbox',
      checked: value,
      onChange: (event: { target: { checked: boolean } }) => onChange(event.target.checked),
    }),
    label === undefined ? null : h('span', null, label),
  )
}

function TextField({
  value,
  placeholder,
  maxLength,
  onCommit,
}: {
  value: string
  placeholder?: string
  maxLength: number
  onCommit: (value: string) => void
}): ReactElement {
  const [local, setLocal] = useState(value)
  useEffect(() => {
    setLocal(value)
  }, [value])
  return h('input', {
    type: 'text',
    value: local,
    placeholder: placeholder ?? '',
    maxLength,
    onChange: (event: { target: { value: string } }) => setLocal(event.target.value),
    onBlur: () => onCommit(local),
    onKeyDown: (event: { key: string }) => {
      if (event.key === 'Enter') onCommit(local)
    },
  })
}

function Chip({
  title,
  detail,
  on,
  onClick,
}: {
  title: string
  detail: string
  on: boolean
  onClick: () => void
}): ReactElement {
  return h(
    'div',
    { className: on ? 'dba-chip dba-on' : 'dba-chip', onClick },
    h('span', { className: 'dba-chip-t' }, on ? '✓ ' + title : title),
    h('span', { className: 'dba-chip-d' }, detail),
  )
}

/* -------------------------------------------------------------- the dialog */

type Tab = 'triggers' | 'playback' | 'clips'

export function SettingsPanel({
  onClose,
  onPreview,
}: {
  onClose: () => void
  onPreview: (clipId: string | null) => void
}): ReactElement {
  ensureStyle()
  const [config, setConfig] = useState<ConfigPayload | null>(null)
  const [tab, setTab] = useState<Tab>('triggers')
  const [msg, setMsg] = useState<{ text: string; kind: string }>({ text: '', kind: '' })
  const [busy, setBusy] = useState(false)
  /** Which clip the panel's own player shows; null follows the current selection. */
  const [preview, setPreview] = useState<string | null>(null)
  /** Upload progress line; empty when nothing is in flight. */
  const [note, setNote] = useState('')
  const [dropHot, setDropHot] = useState(false)
  const fileInput = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async () => {
    try {
      const next = await fetchConfig()
      setConfig(next)
      setMsg({ text: '', kind: '' })
    } catch (error: unknown) {
      setMsg({ text: '读取设置失败：' + String(error), kind: 'dba-err' })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /**
   * Optimistic write: the local view updates first, then the host's answer replaces
   * it. A slider that waited for a round trip per step would feel broken on a slow
   * disk, and the host is the authority either way.
   */
  const patch = useCallback(async (change: Partial<BootSettings>, note?: string) => {
    setBusy(true)
    setConfig((current) =>
      current === null ? current : { ...current, settings: { ...current.settings, ...change } },
    )
    try {
      const answer = await saveSettings(change)
      if (answer.ok !== true) {
        setMsg({ text: '保存失败：' + String(answer.error ?? '未知错误'), kind: 'dba-err' })
      } else if (answer.settings !== undefined) {
        const saved = answer.settings
        setConfig((current) =>
          current === null
            ? current
            : {
                ...current,
                settings: saved,
                ...(answer.state === undefined ? {} : { state: answer.state }),
                ...(answer.clips === undefined ? {} : { clips: answer.clips }),
              },
        )
        if (note !== undefined) setMsg({ text: note, kind: 'dba-ok' })
      }
      // The overlay decides from its own cache of the plan, so it has to be told;
      // otherwise a change would only land on the next page load.
      await refreshConfig()
    } catch (error: unknown) {
      setMsg({ text: '保存失败：' + String(error), kind: 'dba-err' })
    } finally {
      setBusy(false)
    }
  }, [])

  const choose = useCallback(
    async (clip: ClipEntry) => {
      setBusy(true)
      try {
        const answer = await selectClipRoute(clip.id)
        if (answer.ok === true) {
          setMsg({ text: '已切换：' + String(answer.name ?? clip.id), kind: 'dba-ok' })
          await load()
          await refreshConfig()
        } else {
          setMsg({ text: '切换失败：' + String(answer.error ?? '未知错误'), kind: 'dba-err' })
        }
      } catch (error: unknown) {
        setMsg({ text: '操作失败：' + String(error), kind: 'dba-err' })
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  /**
   * Take one picked or dropped file.
   *
   * The size is checked here AND on the host: refusing a 2 GB mistake before
   * spending a minute uploading it is the difference between a hint and a hang.
   * The host stays the authority - it re-checks the cap, the extension and the
   * name, because a browser-side check is a convenience, not a boundary.
   */
  const acceptFile = useCallback(
    async (file: File | null | undefined) => {
      if (file === null || file === undefined) return
      const cap = config?.maxUploadBytes ?? 0
      if (cap > 0 && file.size > cap) {
        setMsg({ text: `文件太大：${formatBytes(file.size)}，上限 ${formatBytes(cap)}`, kind: 'dba-err' })
        return
      }
      setBusy(true)
      setNote('上传中 0%')
      try {
        const answer = await uploadVideo(file, (percent) => setNote(`上传中 ${String(percent)}%`))
        setNote('')
        if (answer.ok !== true) {
          setMsg({ text: '上传失败：' + String(answer.error ?? '未知错误'), kind: 'dba-err' })
          return
        }
        setMsg({
          text: `已加入视频库：${String(answer.name ?? answer.file ?? file.name)}`,
          kind: 'dba-ok',
        })
        await load()
        // Select what was just uploaded: the whole point of the picker is to use it.
        if (typeof answer.id === 'string' && answer.id !== '') {
          await selectClipRoute(answer.id)
          setPreview(answer.id)
          await load()
          await refreshConfig()
        }
      } catch (error: unknown) {
        setNote('')
        setMsg({ text: '上传失败：' + String(error), kind: 'dba-err' })
      } finally {
        setBusy(false)
      }
    },
    [config, load],
  )

  const settings = config?.settings ?? null
  const clips = config?.clips ?? []
  const state: BootState | null = config?.state ?? null
  const limits = config?.limits ?? SETTINGS_LIMITS

  /**
   * What the inline player shows: the last clip previewed, else the selected one,
   * else whatever the host resolved. Never an empty box, because "what does the
   * intro actually look like" is the question this panel exists to answer.
   */
  const previewClip: ClipEntry | null =
    clips.find((clip) => clip.id === preview) ??
    clips.find((clip) => clip.id === settings?.clipId) ??
    clips.find((clip) => clip.id === config?.active?.id) ??
    clips[0] ??
    null

  const activeName =
    config === null
      ? '…'
      : config.active === null
        ? '（没有可用的片子）'
        : `${config.active.name}（${config.active.how}）`

  const setTrigger = (trigger: TriggerName, on: boolean): void => {
    if (settings === null) return
    const next = on
      ? TRIGGERS.filter((t) => settings.triggers.includes(t) || t === trigger)
      : settings.triggers.filter((t) => t !== trigger)
    void patch(
      { triggers: [...next] },
      on ? `已开启：${TRIGGER_LABEL[trigger].title}` : `已关闭：${TRIGGER_LABEL[trigger].title}`,
    )
  }

  return h(
    'div',
    {
      className: 'dba-veil',
      onClick: (event: { target: unknown; currentTarget: unknown }) => {
        if (event.target === event.currentTarget) onClose()
      },
    },
    h(
      'div',
      {
        className: dropHot ? 'dba-lib dba-drop-hot' : 'dba-lib',
        onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
        // Drag and drop over the whole dialog: the file picker is for people who
        // want one, and dropping a file on the panel is what everyone tries first.
        onDragOver: (event: { preventDefault: () => void }) => {
          event.preventDefault()
          setDropHot(true)
        },
        onDragLeave: () => setDropHot(false),
        onDrop: (event: {
          preventDefault: () => void
          dataTransfer?: { files?: FileList } | null
        }) => {
          event.preventDefault()
          setDropHot(false)
          void acceptFile(event.dataTransfer?.files?.[0] ?? null)
        },
      },
      // 三段式布局的第一段：标题 + 当前会播 + 页签（固定，不随内容滚动）
      h(
        'div',
        { className: 'dba-head' },
        h('h3', null, '片头动画设置'),
      h(
        'p',
        null,
        '当前会播：',
        h('strong', null, activeName),
        state === null ? null : ` · 已播 ${String(state.runs)} 次 · 上次 ${formatWhen(state.ranAt)}`,
      ),

      h(
        'div',
        { className: 'dba-tabs' },
        ...[
          ['triggers', '什么时候播'],
          ['playback', '怎么播'],
          ['clips', '片子'],
        ].map(([key, label]) =>
          h(
            'button',
            {
              key,
              type: 'button',
              className: tab === key ? 'dba-tab dba-on' : 'dba-tab',
              onClick: () => setTab(key as Tab),
            },
            label,
          ),
        ),
        ),
      ),

      // 中间可滚动区：三个页签的全部内容都在这里（滚到底就是最后一项设置）
      h(
        'div',
        { className: 'dba-body' },

      settings === null
        ? h('div', { className: 'dba-item' }, h('span', { className: 'dba-nm' }, '读取中…'))
        : null,

      /* ------------------------------------------------------- triggers tab */
      settings !== null && tab === 'triggers'
        ? h(
            'div',
            null,
            h(
              Row,
              { label: '总开关' },
              h(Toggle, {
                value: settings.enabled,
                onChange: (value: boolean) => {
                  void patch({ enabled: value }, value ? '已开启片头动画' : '已关闭片头动画')
                },
                label: settings.enabled ? '开启' : '关闭',
              }),
            ),
            h('h4', null, '触发时机（可多选）'),
            h(
              'div',
              { className: 'dba-grid' },
              ...TRIGGERS.map((trigger) =>
                h(Chip, {
                  key: trigger,
                  title: TRIGGER_LABEL[trigger].title,
                  detail: TRIGGER_LABEL[trigger].detail,
                  on: settings.triggers.includes(trigger),
                  onClick: () => setTrigger(trigger, !settings.triggers.includes(trigger)),
                }),
              ),
            ),
            h(
              'p',
              null,
              '「启动 DSH 时」只在应用真正启动的那一次播放；同一个应用会话里按 F5 刷新不算启动。',
            ),
            h('h4', null, '播放频率'),
            h(
              'div',
              { className: 'dba-grid' },
              ...FREQUENCIES.map((frequency) => {
                const meta = FREQUENCY_LABEL[frequency] ?? { title: frequency, detail: '' }
                return h(Chip, {
                  key: frequency,
                  title: meta.title,
                  detail: meta.detail,
                  on: settings.frequency === frequency,
                  onClick: () => {
                    void patch({ frequency }, `频率：${meta.title}`)
                  },
                })
              }),
            ),
            settings.frequency === 'count'
              ? h(
                  Row,
                  { label: '播放次数上限' },
                  h(Slider, {
                    limit: limits.playCount,
                    value: settings.playCount,
                    suffix: ' 次',
                    onCommit: (value: number) => void patch({ playCount: value }),
                  }),
                )
              : null,
            h(
              Row,
              {
                label: '延迟开始',
                note: '给 DSH 一点启动时间再放片头；0 表示立刻开始。',
              },
              h(Slider, {
                limit: limits.delayMs,
                value: settings.delayMs,
                suffix: ' ms',
                onCommit: (value: number) => void patch({ delayMs: value }),
              }),
            ),
            h(
              Row,
              { label: '互动即关闭' },
              h(Toggle, {
                value: settings.dismissOnInteract,
                onChange: (value: boolean) => void patch({ dismissOnInteract: value }),
                label: '点击页面任意处即关闭片头（推荐：不挡住桌宠操作）',
              }),
            ),
            h('h4', null, '片头时长'),
            h(
              Row,
              {
                label: '最长播放',
                note: '0 表示播完为止；设置后到点自动关闭，循环播放也受它约束。',
              },
              h(Slider, {
                limit: limits.maxSeconds,
                value: settings.maxSeconds,
                suffix: ' 秒',
                onCommit: (value: number) => void patch({ maxSeconds: value }),
              }),
            ),
            h(
              Row,
              { label: '倒计时进度条' },
              h(Toggle, {
                value: settings.showCountdown,
                onChange: (value: boolean) => void patch({ showCountdown: value }),
                label: '在底部显示剩余时间',
              }),
            ),
            h(
              Row,
              { label: '看门狗超时' },
              h(Slider, {
                limit: limits.stallTimeoutMs,
                value: settings.stallTimeoutMs,
                suffix: ' ms',
                onCommit: (value: number) => void patch({ stallTimeoutMs: value }),
              }),
            ),
            h('h4', null, '钉住的会话'),
            h(
              'div',
              { className: 'dba-row' },
              h('span', { className: 'dba-lab' }, '当前钉住'),
              h(
                'span',
                { className: 'dba-ctl' },
                h('code', null, readPinned() ?? '（未钉住）'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dba-btn dba-panel',
                    onClick: () => {
                      // The pin is written by the sidebar button; here it is only
                      // readable, so this explains where to change it instead of
                      // offering a second, conflicting write path.
                      onClose()
                      window.alert('请在左侧边栏页脚的 🎞 图钉上设置要钉住的会话。')
                    },
                  },
                  '怎么设置？',
                ),
              ),
            ),
          )
        : null,

      /* ------------------------------------------------------- playback tab */
      settings !== null && tab === 'playback'
        ? h(
            'div',
            null,
            h('h4', null, '画面'),
            h(
              Row,
              { label: '贴合方式' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dba-btn dba-panel' + (settings.fit === 'cover' ? ' dba-btn-on' : ''),
                  onClick: () => void patch({ fit: 'cover' }, '已设为铺满屏幕'),
                },
                '铺满屏幕',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dba-btn dba-panel' + (settings.fit === 'contain' ? ' dba-btn-on' : ''),
                  onClick: () => void patch({ fit: 'contain' }, '已设为完整显示'),
                },
                '完整显示',
              ),
            ),
            h(
              Row,
              {
                label: '叠加层级',
                note: '「盖住一切」用于纯粹的开机动画；「放在桌宠下面」让桌宠在片头播放时仍可点。',
              },
              ...LAYERS.map((layer) =>
                h(
                  'button',
                  {
                    key: layer,
                    type: 'button',
                    className: 'dba-btn dba-panel' + (settings.layer === layer ? ' dba-btn-on' : ''),
                    title: LAYER_LABEL[layer].detail,
                    onClick: () => void patch({ layer }, `层级：${LAYER_LABEL[layer].title}`),
                  },
                  LAYER_LABEL[layer].title,
                ),
              ),
            ),
            h(
              Row,
              { label: '背景不透明度' },
              h(Slider, {
                limit: limits.backdropOpacity,
                value: settings.backdropOpacity,
                suffix: '%',
                onCommit: (value: number) => void patch({ backdropOpacity: value }),
              }),
            ),
            h(
              Row,
              { label: '视频不透明度' },
              h(Slider, {
                limit: limits.videoOpacity,
                value: settings.videoOpacity,
                suffix: '%',
                onCommit: (value: number) => void patch({ videoOpacity: value }),
              }),
            ),
            h(
              Row,
              {
                label: '堆叠层级 z-index',
                note: `0 = 用当前层级的默认值（现在解析为 ${String(resolvedZIndex(settings))}）。和别的插件打架时可以调这里。`,
              },
              h(Slider, {
                limit: limits.zIndex,
                value: settings.zIndex,
                onCommit: (value: number) => void patch({ zIndex: value }),
              }),
            ),
            h('h4', null, '播放'),
            h(
              Row,
              { label: '播放速度' },
              h(Slider, {
                limit: limits.playbackRate,
                value: settings.playbackRate,
                suffix: '×',
                onCommit: (value: number) => void patch({ playbackRate: value }),
              }),
            ),
            h(
              Row,
              { label: '循环播放' },
              h(Toggle, {
                value: settings.loop,
                onChange: (value: boolean) => void patch({ loop: value }),
                label: '播完从头再来（配合「最长播放」使用）',
              }),
            ),
            h('h4', null, '声音'),
            h(
              Row,
              { label: '默认有声' },
              h(Toggle, {
                value: settings.sound,
                onChange: (value: boolean) => void patch({ sound: value }),
                label: '浏览器仍要求先点一次页面才会出声',
              }),
            ),
            h(
              Row,
              { label: '音量' },
              h(Slider, {
                limit: limits.volume,
                value: settings.volume,
                suffix: '%',
                onCommit: (value: number) => void patch({ volume: value }),
              }),
            ),
            h('h4', null, '关闭方式'),
            h(
              Row,
              { label: '跳过按钮' },
              h(Toggle, {
                value: settings.showSkip,
                onChange: (value: boolean) => void patch({ showSkip: value }),
                label: '显示「' + settings.skipLabel + '」',
              }),
            ),
            h(
              Row,
              { label: '延迟出现跳过' },
              h(Slider, {
                limit: limits.skipAfterMs,
                value: settings.skipAfterMs,
                suffix: ' ms',
                onCommit: (value: number) => void patch({ skipAfterMs: value }),
              }),
            ),
            h(
              Row,
              { label: '允许全屏' },
              h(Toggle, {
                value: settings.allowFullscreen,
                onChange: (value: boolean) => void patch({ allowFullscreen: value }),
                label: '提供 ⛶ 按钮',
              }),
            ),
          )
        : null,

      /* ---------------------------------------------------------- clips tab */
      settings !== null && tab === 'clips'
        ? h(
            'div',
            null,
            h('h4', null, '选一段作为片头'),
            h(
              'div',
              { className: 'dba-upload' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dba-btn dba-panel dba-btn-preview',
                  disabled: busy,
                  onClick: () => fileInput.current?.click(),
                },
                '＋ 选择视频…',
              ),
              h(
                'span',
                { className: 'dba-meta' },
                `或把文件拖进这个窗口 · 单个上限 ${formatBytes(config?.maxUploadBytes ?? 0)} · ${(config?.accepts ?? []).join(' ')}`,
              ),
              h('input', {
                ref: fileInput,
                type: 'file',
                accept: (config?.accepts ?? []).join(','),
                style: { display: 'none' },
                onChange: (event: { target: { files?: FileList; value?: string } }) => {
                  void acceptFile(event.target.files?.[0] ?? null)
                  // Clear it, or picking the same file twice in a row does nothing.
                  if (event.target.value !== undefined) event.target.value = ''
                },
              }),
            ),
            note === '' ? null : h('div', { className: 'dba-msg dba-ok' }, note),
            // The player, not the full-screen trial: choosing a clip is a compare
            // step, and an intro that covers the whole app cannot be compared.
            previewClip === null
              ? null
              : h(
                  'div',
                  null,
                  h('video', {
                    key: previewClip.urls.media,
                    className: 'dba-preview',
                    src: previewClip.urls.media,
                    controls: true,
                    playsInline: true,
                    preload: 'metadata',
                  }),
                  h(
                    'div',
                    { className: 'dba-meta dba-preview-cap' },
                    `正在预览：${previewClip.name} · ${formatBytes(previewClip.bytes)}`,
                    previewClip.faststart === false
                      ? h(
                          'span',
                          { className: 'dba-badge dba-b-warn', title: '索引不在文件开头，首帧可能要等一下' },
                          '建议 faststart',
                        )
                      : null,
                  ),
                ),
            ...(clips.length === 0
              ? [
                  h(
                    'div',
                    { className: 'dba-item' },
                    h('span', { className: 'dba-nm' }, '（还没找到任何视频）'),
                  ),
                ]
              : clips.map((clip) =>
                  h(
                    'div',
                    {
                      key: clip.id,
                      className: 'dba-item' + (clip.id === settings.clipId ? ' dba-cur' : ''),
                      title: clip.id,
                      onClick: () => {
                        if (!busy && clip.id !== settings.clipId) void choose(clip)
                      },
                    },
                    h('span', { className: 'dba-mark' }, clip.id === settings.clipId ? '✓' : ''),
                    h('span', { className: 'dba-nm' }, clip.name),
                    h('span', { className: 'dba-badge' }, SOURCE_LABEL[clip.source] ?? clip.source),
                    h('span', { className: 'dba-meta' }, formatBytes(clip.bytes)),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dba-btn dba-panel',
                        onClick: (event: { stopPropagation: () => void }) => {
                          event.stopPropagation()
                          setPreview(clip.id)
                        },
                      },
                      '预览',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dba-btn dba-panel',
                        onClick: (event: { stopPropagation: () => void }) => {
                          event.stopPropagation()
                          onPreview(clip.id)
                        },
                      },
                      '▶ 试播',
                    ),
                  ),
                )),
            h('h4', null, '按触发器分别指定（可选）'),
            h('p', null, '留空表示用上面选中的那一段。'),
            ...TRIGGERS.map((trigger) =>
              h(
                Row,
                { key: trigger, label: TRIGGER_LABEL[trigger].title },
                h(
                  'select',
                  {
                    value: settings.perTriggerClip[trigger] ?? '',
                    style: {
                      background: 'transparent',
                      color: 'inherit',
                      fontFamily: 'inherit',
                      fontSize: '12.5px',
                      border: '1px solid rgba(127,127,127,.34)',
                      borderRadius: '7px',
                      padding: '4px 8px',
                      flex: 1,
                      minWidth: '120px',
                    },
                    onChange: (event: { target: { value: string } }) => {
                      const value = event.target.value
                      const next: Partial<Record<TriggerName, string>> = { ...settings.perTriggerClip }
                      if (value === '') delete next[trigger]
                      else next[trigger] = value
                      void patch({ perTriggerClip: next }, `已更新「${TRIGGER_LABEL[trigger].title}」`)
                    },
                  },
                  h('option', { value: '' }, '（用全局选择）'),
                  ...clips.map((clip) => h('option', { key: clip.id, value: clip.id }, clip.name)),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dba-dir' },
              '想加自己的片子：把 mp4/webm 放进这个文件夹，再点「刷新」',
              h('br', null),
              h('code', null, config?.userDir ?? '…'),
              h('br', null),
              '设置文件：',
              h('code', null, config?.settingsFile ?? '…'),
            ),
            h('h4', null, '画面上的文字'),
            h(
              Row,
              { label: '标题' },
              h(TextField, {
                value: settings.title,
                placeholder: '例如：欢迎回来',
                maxLength: limits.title.maxLength,
                onCommit: (value: string) => void patch({ title: value }),
              }),
            ),
            h(
              Row,
              { label: '副标题' },
              h(TextField, {
                value: settings.subtitle,
                placeholder: '例如：DeepSeek Harness',
                maxLength: limits.subtitle.maxLength,
                onCommit: (value: string) => void patch({ subtitle: value }),
              }),
            ),
            h(
              Row,
              { label: '跳过按钮文字' },
              h(TextField, {
                value: settings.skipLabel,
                maxLength: limits.skipLabel.maxLength,
                onCommit: (value: string) => void patch({ skipLabel: value }),
              }),
            ),
            h(
              Row,
              { label: '底部提示文字' },
              h(TextField, {
                value: settings.hintLabel,
                placeholder: '留空则不显示',
                maxLength: limits.hintLabel.maxLength,
                onCommit: (value: string) => void patch({ hintLabel: value }),
              }),
            ),
          )
        : null,

      ),

      // 第三段：固定底栏（试播/重置/刷新/复制诊断/关闭 + 提示文字）永远可见
      h(
        'div',
        { className: 'dba-foot' },
      h(
        'div',
        { className: 'dba-bar' },
        h(
          'button',
          {
            type: 'button',
            className: 'dba-btn dba-btn-preview',
            title: '立刻按当前设置播一次，不用等下一次启动',
            onClick: () => onPreview(null),
          },
          '▶ 立即试播',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dba-btn dba-panel',
            title: '忘掉「哪些会话已经播过」与播放次数',
            onClick: () => {
              void (async () => {
                forgetPlayedConversations()
                await resetState('state')
                await load()
                await refreshConfig()
                setMsg({ text: '已重置播放记录', kind: 'dba-ok' })
              })()
            },
          },
          '重置播放记录',
        ),
        h(
          'button',
          { type: 'button', className: 'dba-btn dba-panel', onClick: () => void load() },
          '刷新',
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dba-btn dba-panel',
            title: '把当前设置复制到剪贴板，便于排查',
            onClick: () => {
              const payload = {
                settings,
                state,
                active: config?.active ?? null,
                clips: clips.map((clip) => clip.id),
              }
              void navigator.clipboard?.writeText(JSON.stringify(payload, null, 2)).then(
                () => setMsg({ text: '已复制诊断信息到剪贴板', kind: 'dba-ok' }),
                () => setMsg({ text: '复制失败（浏览器未授权剪贴板）', kind: 'dba-err' }),
              )
            },
          },
          '复制诊断',
        ),
        h('button', { type: 'button', className: 'dba-btn dba-panel', onClick: onClose }, '关闭'),
      ),
        h('div', { className: 'dba-msg ' + msg.kind }, msg.text),
      ),
    ),
  )
}
