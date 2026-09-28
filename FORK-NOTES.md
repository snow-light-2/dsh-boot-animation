# dsh-boot-animation — 本机定制分支（fork）

上游：[`NativeDog1/dsh-boot-animation`](https://github.com/NativeDog1/dsh-boot-animation)
分支维护者：`snow-light-2`
基线版本：`0.2.2`

这个仓库**不是**重新实现，而是上游 0.2.2 的完整副本 + 少量适配改动。
上游的 README（[`README.md`](README.md)）依然是最准确的用法文档，请以它为准。

---

## 为什么要有这个 fork

上游 `package.json` 里声明：

```json
"dsh": { "engines": { "dsh": ">=0.1.5-rc.1" } }
```

而本机 DSH Desktop 的宿主内核是 **`0.1.2-rc.1`**。DSH 插件市场在安装/更新前会校验这个区间，
不满足就直接拒绝（日志里长这样）：

```
update-compat: dsh-boot-animation declares >=0.1.5-rc.1; this host is 0.1.2-rc.1 — refused before installing
```

结果就是：**这个插件在本机永远装不上、也永远更新不了**，只能靠手工 `link:` 目录硬塞进去。
一旦那个目录丢了或者被覆盖，插件就没了，而且没有任何升级路径。

## 改了什么

只有两处，都是让它在 `0.1.2-rc.1` 上能被正常安装：

| 文件 | 改动 | 原因 |
|---|---|---|
| `package.json` → `version` | `0.2.2` → `0.2.2-fork.1` | 让本分支的版本号与上游区分开，便于日后比对 |
| `package.json` → `dsh.engines.dsh` | `">=0.1.5-rc.1"` → `">=0.1.2-rc.1"` | 放开版本闸门，让市场肯安装 |

**源码（`src/`、`lib/`）一个字节都没改。** 上游的构建产物 `lib/` 是随包提交的，
所以这个仓库**不需要编译**：`dsh plugin add github:...` 直接把 `lib/` 拿走用。

### 为什么敢放开闸门

插件真正依赖的两个宿主能力，在 `0.1.2-rc.1` 上都实测存在：

| 插件用到的东西 | 宿主提供方 | 本机实测 |
|---|---|---|
| `ctx.uiSession` / `adapter.current` | `@deepseek-ai/dsh-client-ui-session` | ✅ `lib/client.js:99` `super(ctx, "uiSession")`、`:103` `this.adapter = {...}` |
| `shell.overlay` 槽位 | `@deepseek-ai/dsh-client-ui-layout` | ✅ `lib/client.js:263` `renderSlot("shell.overlay", {})`、`:455` 槽声明 |
| `sidebar.footer.action` 槽位 | `@deepseek-ai/dsh-client-ui-sidebar` | ✅ `lib/client.js:249`、`:324` |
| `hooks.session.blankBit` | `@deepseek-ai/dsh-api-session-controller` | ✅ `lib/client.js:799` `blankBit = true`（公开类字段） |

也就是说 `>=0.1.5-rc.1` 这个下界在本机是**过严**的，不是真的缺能力。

> ⚠️ 老实说：这是基于**接口存在 + 实际能跑**的判断，不是上游作者的背书。
> 如果哪天你升级 DSH 内核后片头不播了，先怀疑这里。

---

## 怎么用

### 安装（首次）

```sh
dsh plugin --profile web add github:snow-light-2/dsh-boot-animation
```

装完**必须重启一次 DSH**（bundle 层在启动时装配），然后在新窗口里按 **Ctrl+Shift+R** 硬刷新
（客户端 bundle 的缓存是 `max-age=31536000, immutable`，普通 F5 不够）。

### 换成你自己的片子（不用改代码）

插件本身就是个**片库**，换片的最省事方式：

1. 把 mp4 丢进 `C:\Users\<你>\.dsh\boot-animation\videos\`
2. 在侧边栏页脚点 **🎛**，打开「片头片库」
3. 点一下你想播的那一条

片子建议先做 **faststart**（索引表 `moov` 在文件头），否则浏览器要整段下完才出画面，
叠加客户端 25 秒看门狗，表现就是「片头全黑」：

```sh
ffmpeg -i 原片.mp4 -c copy -movflags +faststart 修好的.mp4
```

### 把片子内嵌进包（可选，重一点）

想让某段片子跟着仓库走、装到哪都在，把它放进 `media/` 并改 `scripts/embed-clips.mjs` 的清单，
然后：

```sh
npm run embed-clips
```

脚本会拒绝任何 `moov` 不在文件头的输入，并重写 `lib/clips.meta.js` 与 `lib/clips.data.js`。
注意这会生成一个约 12 MB 的 `lib/clips.data.js`，提交前想清楚要不要。

### 触发时机

- **新对话**：只播一次
- **钉住的会话**：每次打开都播（点侧边栏页脚的 🎞 图钉，图标变绿 🎬 = 已钉住）
- 想立刻确认换片生效：片库面板里的 **▶ 预览当前**

---

## 与上游同步

上游仍然可以加进来做参考：

```sh
git remote add upstream https://github.com/NativeDog1/dsh-boot-animation.git
git fetch upstream
git log --oneline upstream/main -10
```

因为本仓库的基线是「上游 0.2.2 的完整文件树」而不是上游的 git 历史，
**不要**直接 `git merge upstream/main`（没有共同祖先）。上游出了新版时的做法是：

1. `git fetch upstream`
2. 比对上游新版的 `lib/` 与 `src/`
3. 把上游的改动手工搬过来，然后只重做 `package.json` 里那两行

## 许可

继承上游：**BSD-3-Clause**，见 [`LICENSE`](LICENSE)。本分支的改动同样以 BSD-3-Clause 分发。
包内 `media/` 下的默认片源与内嵌片段沿用同一许可。
