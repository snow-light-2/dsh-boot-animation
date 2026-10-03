# dsh-boot-animation

给 **DeepSeek Harness** 加一段**开机动画**：应用启动时，视频铺满整个窗口播放。

这是这个插件存在的理由 —— 「开机」指的是 **DSH 这个应用启动**，不是打开网页、也不是点开某个对话。
（新对话、钉住的会话这两个触发仍然保留，可以在设置面板里单独开关。）

- **应用启动就播** —— 每次打开 DeepSeek Harness 播一次；同一个应用会话里按 F5 **不算**启动
- **触发时机可自选**：启动应用 / 页面刷新 / 新对话 / 钉住的会话 / 任意会话
- **频率可自选**：每次 / 每天一次 / 只播一次 / 限播 N 次
- **一段片头可分别指定**：启动时放长片、新对话放短片
- **时长、速度、循环、静音、音量、跳过按钮、全屏、文字标题** 都能调
- **不挡桌宠**：可以选择片头压在桌宠上面，也可以让桌宠在片头播放时照常可点
- 一个侧边栏按钮 🎬 打开全部设置

> English: [README.en.md](README.en.md)

## 安装

```sh
dsh plugin --profile desktop add link:/path/to/dsh-boot-animation
# 或者从 GitHub：
dsh plugin --profile desktop add github:snow-light-2/dsh-boot-animation
```

> 仓库里已经提交了构建产物 `lib/`，也没有 `prepare` 生命周期脚本，
> 所以这条命令**不编译任何东西**，不会触发 pnpm 的 `allowBuilds` 构建授权。

装完**必须重启一次 DSH** 才生效（bundle 层是在启动时装配的）。重启后**第一件事**就是看片头有没有播：
如果有，说明「应用启动」这条链路是通的。

### 装完看不到效果？先做这件事

DSH 的客户端 bundle 响应带 `cache-control: max-age=31536000, immutable`，
而 URL 上的 `rev` 是**进程 nonce**、不会随内容变化。所以浏览器会一直用**第一次抓到的副本**。

装好或升级后请在新窗口里按 **Ctrl+Shift+R（硬刷新）**。普通 F5 不够。

## 什么时候播（这是本次最大的改动）

| 触发时机 | 含义 | 默认 |
|---|---|---|
| **启动 DSH 时** | DeepSeek Harness 这个**应用**启动后第一次加载页面 | ✅ 开 |
| 页面刷新时（F5） | 应用没重启，只是页面被重新加载 | 关 |
| 新对话时 | 每个还没说过话的对话，播一次 | ✅ 开 |
| 钉住的会话 | 你指定的那个会话，每次进入都播 | ✅ 开 |
| 任意会话 | 每个会话首次进入时播 | 关 |

### 「应用启动」和「按 F5」是怎么区分开的

从浏览器里看，这两件事**长得一模一样**。所以区分它们不能靠页面自己：

1. host 半侧在**进程启动时**生成一个随机 `bootId`（一个 DSH 进程 = 一次应用启动）
2. 页面把见过的 `bootId` 记在 `localStorage`
3. 下次加载时：
   - 看到**没见过的 id** → 应用刚启动 → 这就是开机动画
   - 看到**同一个 id** → 应用还在跑，只是页面被重新加载 → 不是启动

所以 **F5 不会重播开机动画**，但**关掉 DSH 再打开会**。想要 F5 也播，就在设置面板里
把「页面刷新时（F5）」打开。

### 频率

跟触发时机是**两个独立维度**：触发决定「这个事件发生了」，频率决定「现在允许播吗」。

| 频率 | 行为 |
|---|---|
| 每次都播 | 符合触发条件就播 |
| 每天一次 | 当天已经播过就不再播（按**本地时间**算一天） |
| 只播一次 | 直到你点设置里的「重置播放记录」 |
| 限制次数 | 播满设定次数为止 |

播放次数由 **host 记录**（时间戳取自服务器时钟）。客户端改不了它 —— 否则把系统时间
往回拨就能让片头无限重播。

## 设置面板

侧边栏页脚的 **🎬** 打开，三个标签页：

| 标签 | 内容 |
|---|---|
| **什么时候播** | 总开关、触发时机、频率、延迟开始、互动即关闭、最长播放、倒计时、看门狗超时、钉住的会话 |
| **怎么播** | 贴合方式、叠加层级、背景/视频不透明度、z-index、播放速度、循环、声音、音量、跳过按钮、全屏 |
| **片子** | 选片、按触发器分别指定、试播、画面标题/副标题/按钮文字、设置文件位置 |

面板底部有 **▶ 立即试播**、**重置播放记录**、**刷新**、**复制诊断**。

设置存在 `~/.dsh/boot-animation/settings.json`，改完**立刻生效**（下一次触发就用新设置），
不需要重启 DSH。

## 换自己的视频

### 最省事的方式

1. 把 mp4 丢进 `~/.dsh/boot-animation/videos/`（Windows：`C:\Users\<你>\.dsh\boot-animation\videos\`）
2. 打开 🎬 面板 →「片子」→ 点「刷新」
3. 点一下你想播的那一条（出现 ✓ 表示已选中）

`settings.json` 里的 `clipId` 会被更新；同时也会镜像写一份到历史文件
`selection.json`，这样万一回退到旧版本，选择还在。

### 插件自带四段片头（内嵌在代码里）

| 片库里的名字 | 来源 | 大小 |
|---|---|---|
| `DeepSeek 品牌片头` | 内嵌 `lib/clips.data.js` | 1.2 MB |
| `DeepSeek 赛博朋克片头` | 内嵌 `lib/clips.data.js` | 1.8 MB |
| `DeepSeek 数字角色苏醒` | 内嵌 `lib/clips.data.js` | 2.5 MB |
| `DeepSeek 启动问题` | 内嵌 `lib/clips.data.js` | 3.2 MB |

**这些片段没有落盘的 mp4 文件** —— 它们以 base64 存在 `lib/clips.data.js` 里，host 在
第一次被请求时才 import。这样不会再有 `files` 字段漏写、安装副本过期、或者随包发出一个
没做 faststart 的容器这些事。

四段都是 **faststart** 过的（`moov` 在文件头），可以边下边播。

### 手动方式（仍然有效）

host 半侧按这个顺序解析，**每次请求都重新解析**（换片子不用重启）：

| 顺序 | 位置 |
|---|---|
| 1 | `settings.json` 里的 `clipId`（面板写的） |
| 2 | 环境变量 `DSH_BOOT_ANIMATION` 指向的文件 |
| 3 | `~/.dsh/boot-animation/intro.mp4`（历史落点，仍优先于片库里的其他文件） |
| 4 | `~/.dsh/boot-animation/videos/` 里最新修改的那个 |
| 5 | **内嵌的四段** —— 永远兜得住，因为它在代码里 |

最保险的手动换法：

```sh
mkdir -p ~/.dsh/boot-animation
cp 我的片子.mp4 ~/.dsh/boot-animation/intro.mp4
```

查看当前状态：

```sh
curl http://127.0.0.1:19387/dsh-boot-animation/status.json
curl http://127.0.0.1:19387/dsh-boot-animation/plan.json
```

### 播放时怎么贴合窗口（黑边问题）

| 模式 | CSS | 效果 |
|---|---|---|
| **铺满屏幕**（默认） | `object-fit: cover` | 填满窗口，**没有黑边**，超出部分被裁掉 |
| 完整显示 | `object-fit: contain` | 整帧都在，长宽比不匹配时**留黑边** |

在「怎么播」页切换，**下次播放生效**。

> 如果黑边来自**视频本身烧进去的边框**（导出时带上的），改 CSS 没用，要用
> ffmpeg 裁掉：`ffmpeg -i in.mp4 -vf "crop=W:H:X:Y" -c:a copy out.mp4`。

### 支持的格式

`.mp4` `.m4v` `.webm` `.mov` `.mkv` —— 但**能不能播取决于浏览器解码**。
H.264 + AAC 的 mp4 最稳；HEVC(H.265)、ProRes、部分 mkv 大概率只有声或黑屏。

### 视频是黑的 / 放着放着没了

**多半是容器没做 faststart。** 如果 mp4 的索引表 `moov` 在文件末尾，浏览器必须
**整段下完**才能解码，中间一直黑屏；看门狗超时会自己把覆盖层关掉 —— 症状就是
「点开什么都没有」。

用 ffmpeg 重排一下容器（**无损**，不重新编码）：

```sh
ffmpeg -i 原片.mp4 -c copy -movflags +faststart 修好的.mp4
```

验证 moov 是否前置：

```sh
ffprobe -v trace 修好的.mp4 2>&1 | grep -m1 moov   # 偏移应该很小
```

## 浏览器的两条硬性策略

自动播放**带声音**、以及 Fullscreen API，**都要求用户手势**，任何网页都绕不过。所以：

1. 动画以**静音**自动开始（视觉上已经是全屏）
2. 右上角的 **🔊** 按钮开声音、**⛶** 按钮进真全屏 —— 这两下点击就是那个手势
3. 万一连静音自动播放也被拒，会显示「**播放**」按钮而不是黑屏

### 为什么片头不再吞掉整个页面的点击

片头的根元素是 `pointer-events: none`：**只有**右上角那几个按钮（和跳过）收点击，
其余部分点下去会**穿透到下面的界面**（包括桌宠）。这是和桌宠这类浮层插件共处的关键 ——
早先的版本给整个全屏层加了 `pointer-events: auto`，结果是片头播放期间桌宠**看得见却点不到**。

另外，播放期间**点页面任意处会直接关掉片头**（`dismissOnInteract`，默认开）：既然你已经
去操作别的界面了，说明这段片头你不想看了。这个开关可以关掉。

## 和别的插件冲突？看这一节

### 和桌宠（dsh-pet）的层级关系

桌宠把自己的右键菜单画在 `document.body` 上、`z-index: 2147483000`（聊天 3001、分数弹窗 3002），
**不在任何 slot 里** —— 所以 slot 的 `order` 管不到它。本插件提供两种层级：

| 层级 | z-index | 效果 |
|---|---|---|
| **盖住一切**（默认） | 2147483600 | 片头在最上面，桌宠被挡住（适合纯粹的「开机动画」） |
| **放在桌宠下面** | 2147482980 | 桌宠在片头之上，播放期间照常可点、可见 |

早先的版本用的是 **2147483000**，和桌宠菜单**完全相等** —— 于是桌宠菜单会盖在片头上。
现在这两个值都不相等，而且可以在「怎么播」里手工填任意 `z-index`。

> 想让别的插件知道片头在不在播，读 `window.__dshBootAnimation`：
> `playing`（是否在播）、`onPlayingChange(fn)`（订阅变化）、`play()` / `close()`。
> 桌宠或皮肤插件可以用它主动让位，而不是互相抢像素。

### 装插件时可能遇到的「冲突」

| 现象 | 原因 | 处理 |
|---|---|---|
| 市场拒绝安装，说版本不兼容 | 插件的 `dsh.engines.dsh` 高于你的宿主版本 | 本仓库 fork 已把下限降到 **`>=0.1.2-rc.1`**；若仍被拒，说明你的宿主比这更旧 |
| 装上后白屏 / `React error #130` | 某个插件把**注入包里不存在的组件**渲染成了 `undefined` | 本插件只注入 `slots` 一个服务，而且**不注册任何 `shell.overlay` 席位**（那个 list 槽位留给桌宠），因此不会挤掉别人；面板里的每个组件都是本仓库自己的 import |
| 侧边栏页脚多出一堆按钮 | `sidebar.footer.action` 是 `kind: "list"`，每个插件各占一格 | 这是设计如此；本插件只占 **1 格**（🎬），旧版本占 2 格 |
| 重启 DSH 后没看到片头 | 浏览器缓存，或触发时机没开 | 硬刷新；打开 🎬 面板确认「启动 DSH 时」是勾上的 |

### 本插件注册了什么（就这些）

- `sidebar.footer.action`：**1 个**按钮
- 9 条 host 路由，全部在 `/dsh-boot-animation/` 前缀下
- 1 个 `<style id="dsh-boot-animation-style">`，所有类名以 `dba-` 开头、所有 CSS 变量以 `--dba-` 开头
- 4 个 `localStorage` 键，全部以 `dsh-boot-animation:` 开头
- `window.__dshBootAnimation` 一个全局句柄（只读信息 + 两个命令）

它**不**注册 `shell.overlay`，**不**改 `:root` 或 `body` 的样式，**不**常驻全局键盘/鼠标监听
（只在片头播放期间装 `pointerdown`/`keydown`，关闭时立刻摘掉）。

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 完全没出现 | ① 硬刷新 **Ctrl+Shift+R**；② 打开 🎬 面板确认总开关和「启动 DSH 时」是开的；③ 如果只是按了 F5，那是**预期行为**（F5 不算应用启动）—— 想要 F5 也播就把「页面刷新时（F5）」打开 |
| 黑屏无画面 | 先看 moov 是否前置（见上）；再访问 `/dsh-boot-animation/plan.json` 看解析到哪个片段；最后看浏览器控制台有没有 `[dsh-boot-animation]` 日志 |
| 换了片没生效 | 「片子」页里点完要有 ✓；确认文件在 `videos/` 里并点了「刷新」 |
| 播到一半自己没了 | 看门狗超时（默认 25 秒，可在「什么时候播」里调）—— 通常还是 faststart 或解码太慢 |
| 播完不关 | 你开了「循环播放」；关掉它，或设一个「最长播放」秒数 |
| 桌宠被挡住了 | 把「叠加层级」改成「放在桌宠下面」 |
| 想看清楚插件在干什么 | 把 `src/client/boot-overlay.ts` 顶部的 `DEBUG` 改成 `true` 重新构建，控制台会打印每次决策（第一次画面、错误码、看门狗放弃、关闭原因） |

## 实现速记（给维护者）

### 代码结构

| 文件 | 作用 | 产物 |
|---|---|---|
| `src/host.js` | host 半侧：片库、设置、播放状态、9 条路由 | 逐字复制为 `lib/index.js` |
| `src/shared/settings.ts` | 设置词汇表：默认值、范围、校验、频率判定 | 由 tsdown 打进 client，并转译成 `lib/settings.shared.mjs` 给 host 用 |
| `src/client/api.ts` | 全部 host 路由的 typed 封装 | client bundle |
| `src/client/boot-overlay.ts` | 覆盖层本体 + 触发判定 + `bootId` 逻辑 + 全局句柄 | client bundle |
| `src/client/settings-panel.tsx` | 三标签设置面板 | client bundle |
| `src/client/styles.ts` | 唯一的样式表（`dba-` 命名空间） | client bundle |
| `src/client/index.ts` | 入口：注册 1 个 slot 席位、启动触发链路 | client bundle |

`npm run build`（= `scripts/build.mjs`）按固定顺序生成四件产物，并**逐件校验存在**；
`lib/` 是提交进仓库的，所以改完源码**必须重新构建**，否则发出去的是旧代码。

### 关键设计决定

- **不占 `shell.overlay`**。那个 list 槽位留给桌宠之类的浮层插件；本插件的覆盖层是
  `document.body` 上的普通 DOM，由 `apply()` 直接挂。这样既不用抢槽位，也**能盖住
  外壳自己的「Loading plugins…」画面** —— 那正是开机动画应该覆盖的时刻
- **`bootId` 区分应用启动和 F5**。host 进程启动时生成一次（`randomUUID()`），页面记在
  `localStorage`。看不见新 id 就不播 —— 这是"开机动画"这个概念在浏览器里唯一的可靠依据
- **`slots` 是唯一注入的服务**，会话 store 用 `ctx.get('uiSession')` 在 `apply` 体里取。
  取不到也照样跑启动动画 —— 声明式注入一个不存在的东西会让整个入口停摆，
  而"渲染了 `undefined` 组件"正是白屏（React #130）的来源
- **`pointer-events` 分层**：根层 `none`，只有控制按钮 `.dba-hit` 收事件；
  因此片头不会吞掉给桌宠的点击
- **z-index 不与桌宠相等**：2147483600（盖住一切）/ 2147482980（在桌宠下面）
- **hook 只在组件里调**：`apply()` 是插件加载器调的，不是 React 调的，所以状态住在
  `SidebarEntry` 组件内；面板以**元素**形式渲染，绝不直接当函数调用
- **当前会话来自 `ctx.uiSession.adapter.current`**。**它的快照不是会话记录**，而是解析后的
  描述符产物 `{ key, hooks, keyedHooks, props }` —— 会话 id 在 `props.sessionId`，
  会话快照在 `hooks.session`；「这是个全新对话」的字段是 **`blankBit`**
  （`session.blank` 属于别的包的投影对象，不在这个快照上）
- **路由**：`plan.json`（启动决策用）、`settings.json`（GET 面板数据 / POST 合并补丁）、
  `videos.json`（列）、`media/<id>`（按 id 流）、`select`（POST 写选择）、
  `state`（POST 记一次播放）、`reset`（POST 清记录）、`status.json`（诊断）、
  `boot.mp4`（老路由，服务当前生效的那条，向后兼容）
- **设置写入是合并 + 夹取**，不是替换：面板只发改动过的键，所以一个陈旧的对话框不会
  抹掉它没渲染过的字段；越界数值被夹到范围内，未知键被丢掉（`mergeSettings`）
- **播放次数由 host 记账**：时间戳取自服务器时钟。让客户端提供时间即可被系统时间倒拨绕过
- **视频路由支持 Range**（浏览器对媒体会发 Range；该给 206 却给 200 时有些播放器会拒绝播放）
- **媒体响应是 `no-cache` + ETag，不是 `no-store`**：`no-store` 让浏览器一个字节都不能留，
  于是每次开片头都要重下整段，加载期间就是黑屏。`no-cache` 表示"留着但要先问"，
  配合 ETag：没换片子 → 304 直接用本地副本（秒开）；换了片子 → ETag 不同 → 重新下发
- **内嵌片段的 id 是 `builtin:<name>`**，与路径派生的 id 不会撞；它们的 ETag 用自身
  内容哈希（`"embedded-<sha256前16位>"`），所以重校验是精确的、不依赖 stat
- **同一个视频在多个位置时按内容去重**（sha256；文件侧按 size+mtime 缓存哈希结果），
  内嵌那份优先胜出 —— 它不可能被删掉，所以指向它的选择永远解析得到
- **prefix 路由不能带尾部斜杠**：webserver 用
  `pathname !== prefix && !pathname.startsWith(prefix + '/')` 匹配，注册
  `.../media/` 会被当成 `.../media//`，永远匹配不上（曾导致 `/media/<id>` 全 404）

## 验证脚本（改完跑一遍）

| 命令 | 作用 |
|---|---|
| `npm run check` | 下面三个 + CSS 模板反引号检查，一次跑完 |
| `npm run verify:routes` | 用**服务器自己的匹配规则**驱动真实 host handler：路由、设置合并/夹取、播放记账、重置语义 |
| `npm run verify:boot` | 用 DOM 替身驱动**已构建的 `lib/client.js`**：启动 vs F5、频率、总开关、层级 z-index、按触发器选片、指针事件分层 |
| `npm run verify:boot-resilience` | host 全程不可用时的行为，**独立进程**跑（模块状态是每页一次的，同一进程里测不出"从未收到应答"） |
| `npm run verify:letterbox` | 用 CDP 驱动本机 Edge，量出所选贴合方式实际留多少黑边 |
| `npm run typecheck` | `tsc --noEmit` |

这些脚本都是被真实 bug 逼出来的，而且**都真的抓到过 bug**：

- `verify-routes` 复刻服务器自己的匹配规则，而不是"看起来差不多"的 `startsWith`
- `verify-boot` 抓到过一个真实缺陷：`plan.json` 早期只带**当前生效那一段**的 URL，
  于是「按触发器分别指定片段」会悄悄回退到错误的那一段 —— 现在是 `clipUrls` 全量映射
- `verify-boot-resilience` 最初写在 `verify-boot` 里，结果它断言的是**上一次成功加载**
  留下的模块状态；拆成独立进程后才真的在测故障路径

> 客户端构建有一个坑：整个 CSS 是一段模板字符串，注释里写一个反引号就会提前把它
> 结束掉，而报错是 **TypeScript 的 parse error 指向某行 CSS**，同时 `lib/client.js`
> 保持不变 —— 看起来像改成功了其实没生效。`scripts/check-css-template.mjs` 专门
> 拦这个，已接进 `build:client`。

> 客户端构建有一个坑：整个 CSS 是一段模板字符串，注释里写一个反引号就会提前把它
> 结束掉，而报错是 **TypeScript 的 parse error 指向某行 CSS**，同时 `lib/client.js`
> 保持不变 —— 看起来像改成功了其实没生效。`scripts/check-css-template.mjs` 专门
> 拦这个，已接进 `build:client`。

## 许可

BSD-3-Clause，见 [LICENSE](LICENSE)。包内的 `assets/boot.mp4` 与 `videos/` 下的
默认片源以相同条款分发。

## Fork 说明

本仓库是 [NativeDog1/dsh-boot-animation](https://github.com/NativeDog1/dsh-boot-animation)
的 fork（上游 0.2.2），由 snow-light-2 维护。改动清单、原因与取舍见
[FORK-NOTES.md](FORK-NOTES.md)。
