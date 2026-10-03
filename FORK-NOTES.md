# dsh-boot-animation — 本机定制分支（fork）

上游：[`NativeDog1/dsh-boot-animation`](https://github.com/NativeDog1/dsh-boot-animation)
分支维护者：`snow-light-2`
基线版本：`0.2.2`　当前版本：**`0.3.2`**

这个仓库的起点是上游 0.2.2 的完整副本。0.2.2-fork.1 只改了两行 `package.json`
（放开版本闸门）；**0.3.0 是真正的功能改造**：把片头从「进对话时播」变成
「**DeepSeek Harness 启动时播**」，并解决与桌宠等浮层插件的冲突。
0.3.1 修掉 0.3.0 引入的堆叠层级回归；0.3.2 让面板能直接看片、直接换片（见下）。

---

## 0.3.2 改了什么

### 面板里能直接看、直接换片

这两件事在 0.3.1 之前都不好用：

- **看**：选片页只有一份清单，想知道某一段长什么样，只能点「▶ 试播」让它全屏盖住整个界面
  播一次 —— 而全屏恰恰是最没法把两段片子放在一起比较的视图。
- **换**：自定义视频只能靠自己找到 `$DSH_HOME/boot-animation/videos` 把文件拷进去；
  面板只把这个路径当**纯文本**显示出来，连「打开文件夹」都没有。

改动：

- **内嵌预览播放器**：选片页顶部多了一个 `<video controls>`，播放当前选中（或上次预览）的那一段；
  清单里每行新增「预览」按钮，可以把任意一段装进播放器里对比，不必再全屏试播。
- **面板内上传**：新增「＋ 选择视频…」按钮 + **整个对话框可拖放**；文件经新路由
  `POST /dsh-boot-animation/upload?name=<文件名>`（原始字节日志体）写入视频库，
  完成后自动刷新清单并**选中刚上传的那一段**。
- **上传路由的边界**（每条都有断言在 `scripts/verify-routes.mjs`）：
  - 只接受 POST（GET → 405）；
  - **只接受同源请求**（看 `sec-fetch-site` 与 `origin`，跨站 403）：DSH 的 web 服务监听
    127.0.0.1，浏览器里任何页面都够得到它，没有这条任意网站都能往用户的片子库里塞文件；
  - 文件名先消毒（丢弃目录分隔符、控制字符、前导点，句干截断到 80 字符），扩展名必须是
    可服务的视频后缀，否则 415 —— 这条路由不能变成通用文件投放口
    （`../../escape.mp4` 这类名字会被压平成 `escape.mp4`）；
  - 先写 `<目标>.part`、完成后再 rename 落位：中途断开不会在库里留下一个"半截文件"
    被列表选中、播放时才失败；
  - 单文件上限 **256 MB**（超出 → 413，并删掉 .part）；面板会先用 `maxUploadBytes`
    做一次本地预检，避免白传一分钟。
- `ClipEntry` 带上 `faststart`：对索引不在文件开头的片子，面板给出「建议 faststart」提示
  （它照样能播，只是首帧可能要等 —— overlay 有 25 秒看门狗兜底）。

---

## 0.3.1 改了什么

### 修掉「启动时其实播了，但被界面盖住看不见」

**症状**：应用启动后宿主确实记录了一次播放（`$DSH_HOME/boot-animation/state.json`
里 `runs` +1、`ranAt` 是启动时刻），但屏幕上什么都看不到。

**根因**：`BootSettings.zIndex` 的语义是「`0` = 用层级默认值」，但
`SETTINGS_LIMITS.zIndex` 的下限写成了 `1`。`mergeSettings` 里
`pick('zIndex')` 在字段缺省时返回默认值 `0`（一个有限数），紧接着被
`clampNumber` 按 `min: 1` 夹成 `1` —— 于是 `resolvedZIndex()` 永远返回自定义值
`1`，而不是 `overlay` 层的 `2147483600`，片头被排在应用界面**下面**（桌面端界面
的层级远高于 1），表现为"播了但看不见"。

**改法**：

- `src/shared/settings.ts`：`zIndex` 下限改回 `0`（哨兵值必须能穿过校验，
  否则「自动」这个档位等于不存在）；
- `scripts/verify-routes.mjs`：新增回归断言 —— 默认设置必须保持 `zIndex: 0`
  且 `resolvedZIndex` 高于桌宠的 `2147483000`。这条断言在旧代码下会失败。

---

## 0.3.0 改了什么（本次）

### ① 触发时机：新增「应用启动」

**问题**：上游只在两种时机播 —— 进入新对话（每个会话一次）、进入你钉住的会话。
而"开机动画"这个名字承诺的是**应用启动**，上游根本没有这个触发路径。

**改法**：新增 `appStart` 触发（默认开），并且区分「应用启动」和「按 F5」。
这个区分不能靠页面自己判断（两者在浏览器里完全一样），所以：

1. `src/host.js` 在**进程启动时**生成一次 `BOOT_ID = randomUUID()`
   —— 一个 DSH 进程 = 一次应用启动
2. `/plan.json` 把它报给页面
3. 页面把它记在 `localStorage['dsh-boot-animation:bootId']`
4. 下次加载时：**没见过的 id** → 应用刚启动 → 播；**同一个 id** → 只是页面被重新加载 → 不播

触发时机因此变成 5 个可多选的开关：`appStart` / `pageLoad` / `newConversation` /
`pinnedConversation` / `conversation`；频率独立为 4 档：`every` / `daily` / `once` / `count`。

### ② 冲突：不再抢槽位、不再吞点击、不再与桌宠撞层级

三个具体缺陷，都是从代码里读出来的，不是猜的：

| 缺陷 | 证据 | 修法 |
|---|---|---|
| 覆盖层挂在 `shell.overlay`，只能在外壳渲染完成后出现 | 上游 `src/client/index.ts:884` | 覆盖层改为 `document.body` 上的普通 DOM，由 `apply()` 直接挂 —— 于是它**能盖住外壳自己的「Loading plugins…」画面**，那正是开机动画该覆盖的时刻 |
| 根元素 `pointer-events: auto` + 全屏，播放期间**吞掉所有点击** | 上游 `dba-root` 样式 | 根层 `pointer-events: none`，只有控制按钮 `.dba-hit` 收事件；点击**穿透**到桌宠和界面 |
| `z-index: 2147483000` 与桌宠右键菜单**完全相等** | 桌宠 `shared/menu.ts:95` 也是 `2147483000` | 改为 2147483600（盖住一切）/ 2147482980（在桌宠下面），并提供「叠加层级」开关和任意 `z-index` 输入 |

另外：覆盖层播放期间**点页面任意处即关闭**（`dismissOnInteract`，默认开），
所以即使层级选了「盖住一切」，用户一点桌宠，片头就让开。

### ③ 个性化：从「只能选片」到完整设置面板

上游能改的只有：放哪些文件、选哪一段、全局 cover/contain、试播。
0.3.0 新增（全部落在 `$DSH_HOME/boot-animation/settings.json`，改完立即生效）：

| 类别 | 新增项 |
|---|---|
| 时机 | 5 个触发开关、4 档频率、`count` 的次数上限、延迟开始（0–10s） |
| 时长 | 最长播放秒数（0=播完为止）、循环播放、看门狗超时 |
| 画面 | 叠加层级、背景不透明度、视频不透明度、任意 z-index |
| 声音 | 默认有声、音量（另加一个运行时的 🔊 开关） |
| 交互 | 跳过按钮开关、跳过按钮延迟出现、允许全屏、互动即关闭 |
| 内容 | 画面标题、副标题、跳过按钮文字、底部提示文字、倒计时进度条 |
| 片段 | **按触发器分别指定片段**（启动放长片、新对话放短片） |
| 运维 | 重置播放记录、立即试播、复制诊断、显示设置文件路径 |

设置写入是**合并 + 夹取**（`mergeSettings`），不是替换：面板只发改动过的键，
越界数值被夹到合法范围，未知键被丢弃。播放次数由 **host 记账**（时间戳取服务器时钟），
客户端改不了 —— 否则把系统时间往回拨就能让片头无限重播。

### ④ 抗冲突：少一个注入、少一个槽位

- 注入服务从 `['slots', 'uiSession']` 缩到 **`['slots']`**；会话 store 改用
  `ctx.get('uiSession')` 在 `apply` 体里取，取不到也**照样跑启动动画**。
  声明式注入一个宿主没有的东西会让整个入口停摆，而"渲染了 `undefined` 组件"
  正是白屏（React #130）的来源 —— 本机的 `dsh-better-sidebar` 就是这么白屏的。
- 侧边栏席位从 **2 格减到 1 格**（一个 🎬 打开面板；钉住会话的按钮移进面板第一页）。
- 不注册 `shell.overlay` —— 那个 list 槽位留给桌宠这类浮层插件。

### ⑤ 工程：构建、类型、验证

| 项 | 变化 |
|---|---|
| 构建 | `scripts/build.mjs`（Node，跨平台）按固定顺序生成四件产物并**逐件校验存在**；`build.sh` 委托给它 |
| 共享词汇表 | `src/shared/settings.ts` 一份源码：client 由 tsdown 打进 bundle，host 由 `tsc` 转译成 `lib/settings.shared.mjs` |
| 类型 | `npm run typecheck`（`tsc --noEmit`）；`tsconfig.json` 加了 DOM lib、`allowJs` |
| 测试 | `verify-routes` 扩到设置/播放状态/重置的全部语义（且改用**临时 `DSH_HOME`**，不再动用户的真实设置）；新增 `verify-boot`（DOM 替身驱动**已构建的** `lib/client.js`）与 `verify-boot-resilience`（host 全程不可用，独立进程） |

`verify-boot` 第一次跑就抓到一个真实缺陷：`/plan.json` 早期只带**当前生效那一段**的
URL，导致「按触发器分别指定片段」会悄悄回退到错误的那一段。现在是 `clipUrls` 全量映射，
并有一条回归用例盯着它。

---

## 0.2.2-fork.1 改了什么（历史）

上游 `package.json` 声明 `dsh.engines.dsh = ">=0.1.5-rc.1"`，而某些本机宿主内核是
`0.1.2-rc.1`。DSH 插件市场在安装/更新前会校验这个区间，不满足就直接拒绝：

```
update-compat: dsh-boot-animation declares >=0.1.5-rc.1; this host is 0.1.2-rc.1 — refused before installing
```

所以那一版只做了两处改动：

| 文件 | 改动 | 原因 |
|---|---|---|
| `package.json` → `version` | `0.2.2` → `0.2.2-fork.1` | 版本号与上游区分开 |
| `package.json` → `dsh.engines.dsh` | `">=0.1.5-rc.1"` → `">=0.1.2-rc.1"` | 放开版本闸门，让市场肯安装 |

### 为什么敢放开闸门

插件真正依赖的宿主能力在更旧的宿主上也存在（0.2.2 时期实测）：

| 插件用到的东西 | 宿主提供方 | 实测 |
|---|---|---|
| `ctx.uiSession` / `adapter.current` | `@deepseek-ai/dsh-client-ui-session` | ✅ `lib/client.js:99` `super(ctx, "uiSession")`、`:103` `this.adapter = {...}` |
| `sidebar.footer.action` 槽位 | `@deepseek-ai/dsh-client-ui-sidebar` | ✅ `lib/client.js:249`、`:324` |
| `hooks.session.blankBit` | `@deepseek-ai/dsh-api-session-controller` | ✅ `lib/client.js:799` |

0.3.0 进一步**主动减少**了对宿主版本的依赖：不再注入 `uiSession`，也不再使用
`shell.overlay`，所以 `dsh.engines.dsh` 的下界维持在 `>=0.1.2-rc.1` 是安全的。

> ⚠️ 老实说：这是基于**接口存在 + 实际能跑**的判断，不是上游作者的背书。
> 如果哪天你升级 DSH 内核后片头不播了，先怀疑这里。

---

## 怎么用

### 安装（首次）

```sh
dsh plugin --profile desktop add github:snow-light-2/dsh-boot-animation
```

profile 名按你的安装而定：本机官方版 DSH Desktop 用的是 **`desktop`**
（`lib/main.js` 里 `profile: join(dshHome, "profiles", "desktop")`）。

装完**必须重启一次 DSH**（bundle 层在启动时装配），然后在新窗口里按 **Ctrl+Shift+R** 硬刷新
（客户端 bundle 的缓存是 `max-age=31536000, immutable`，普通 F5 不够）。

### 触发时机（0.3.0 之后）

- **启动 DSH 时**：默认开。应用启动后第一次加载页面播一次；**F5 不算**
- **页面刷新时（F5）**：默认关。想要每次刷新都播就打开它
- **新对话时**：只播一次
- **钉住的会话**：每次进入都播（面板第一页显示当前钉住的是哪个会话）
- 想立刻确认换片生效：面板底部 **▶ 立即试播**，或某个片段的 **▶ 试播**

### 换成你自己的片子（不用改代码）

1. 把 mp4 丢进 `C:\Users\<你>\.dsh\boot-animation\videos\`
2. 打开 🎬 面板 →「片子」→ 点「刷新」
3. 点一下你想播的那一条（出现 ✓ 表示已选中）

片子建议先做 **faststart**（索引表 `moov` 在文件头），否则浏览器要整段下完才出画面：

```sh
ffmpeg -i 原片.mp4 -c copy -movflags +faststart 修好的.mp4
```

### 把片子内嵌进包（可选，重一点）

把片子放进 `media/`、改 `scripts/embed-clips.mjs` 的清单，然后 `npm run build`。
脚本会拒绝任何 `moov` 不在文件头的输入，并重写 `lib/clips.meta.js` 与
`lib/clips.data.js`（约 12 MB，提交前想清楚要不要）。

### 改代码

```sh
npm install          # 装上 tsdown / typescript / react 类型
npm run typecheck    # tsc --noEmit
npm run build        # 生成 lib/ 四件产物并校验
npm run check        # CSS + 三套回归测试
```

**`lib/` 是提交进仓库的**（安装时不需要编译），所以改完 `src/` 一定要重新
`npm run build`，否则发出去的是旧代码。

---

## 与上游同步

```sh
git remote add upstream https://github.com/NativeDog1/dsh-boot-animation.git
git fetch upstream
git log --oneline upstream/main -10
```

本仓库的基线是「上游 0.2.2 的完整文件树」而不是上游的 git 历史，
**不要**直接 `git merge upstream/main`（没有共同祖先）。上游出了新版时的做法是：
比对上游新版的 `src/` 与 `lib/`，把改动手工搬过来 —— 注意 0.3.0 之后
`src/client/` 已经是多文件结构，`src/host.js` 与 `src/shared/settings.ts` 都是本分支的，
上游的单文件 `src/client/index.ts` 需要按模块拆开搬。

## 许可

继承上游：**BSD-3-Clause**，见 [`LICENSE`](LICENSE)。本分支的改动同样以 BSD-3-Clause 分发。
包内 `media/` 下的默认片源与内嵌片段沿用同一许可。
