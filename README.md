# dsh-session-delete-cascade

**给 DeepSeek Harness 补上「删除会话」：点会话旁的 `⋯` → 删除，连子会话一起清干净。**

npm 包名与仓库名都是 `dsh-session-delete-cascade`。

DeepSeek Harness 出于设计考虑**只提供归档，不提供删除**——会话可以隐藏，但永远不会被移除，日志会一直堆在磁盘上。这个插件把删除能力补回来，作为一个可随时卸载的 bundle，不动官方任何代码。

---

## 功能

- **侧栏菜单项**：会话行的 `⋯` 菜单里新增「删除会话」，排在「归档会话」之后
- **确认弹窗**：删之前告诉你到底会删掉什么，并**列出将被连带删除的子会话**
- **递归删除**：连同该会话的全部子代理子孙（孙代理也删），fork 会话不受影响
- **彻底清理**：对话日志、投影缓存、搜索索引、工作区记账，一处不留
- **安全护栏**：有任务在跑时拒绝删除并指明是哪个会话，不会删一半

## 安装

包已发布到 npm：**<https://www.npmjs.com/package/dsh-session-delete-cascade>**

### 桌面端（DeepSeek Harness App）

**设置 → 插件 → 添加插件**，输入包名：

```
dsh-session-delete-cascade
```

也可以直接粘贴仓库地址 `https://github.com/Changqin1024/dsh-session-delete-cascade`。

装完**完全退出并重开 App**，侧栏会话的 `⋯` 菜单里就会出现「删除会话」。

> ⚠️ **桌面端的 profile 不能用 CLI 安装。** DSH 对 `desktop` profile 做了排他保护：
> `error: profile "desktop" is managed exclusively by the Electron application`。
> 桌面端请走上面的「设置 → 插件」。

### Web / CLI profile

```sh
dsh plugin --profile <profile> add dsh-session-delete-cascade
```

例如 `dsh plugin --profile web add dsh-session-delete-cascade`。装完重启该 profile。

从 GitHub 安装也可以（npm 之外的备选路径，会锁定到具体 commit）：

```sh
dsh plugin --profile <profile> add github:Changqin1024/dsh-session-delete-cascade
```

### 卸载

桌面端：**设置 → 插件**，找到本插件点卸载。

CLI：`dsh plugin --profile <profile> remove dsh-session-delete-cascade`。

### 版本说明

`engines.dsh` 声明为 `>=0.2.0-rc.2`。本插件用到的
`ctx.connection.fetch.register` 在 DSH `0.2.0-rc.2` 上验证通过。

## 删除范围

在弹窗里点确认后，以下内容会被移除（针对目标会话**及其子代理血缘**）：

| 内容 | 位置 | 处理方式 |
|---|---|---|
| 对话历史 | `~/.dsh/sessions/<项目>/<会话ID>/`（append-only JSONL 日志） | 逐个删除目录 |
| 投影缓存（空会话标记、最后提问时间、标题等） | `session_projcache` 存储域 | 逐行删除 |
| 搜索索引行 | 会话搜索 SQLite 索引 | 日志消失后自动对账清除（索引观测的是持久化列表） |
| 工作区记账 | 每个工作区记录的 `sessionIds`，以及全局归档集、置顶集 | 逐项移除 |

**不删的东西**：按会话 ID 无法寻址的缓存，例如附件请求图缓存（`~/.dsh/cache/attachments/request-images/`）。清它需要先读日志拿内容哈希，代价不成比例；会话删掉后它也不会再出现在任何界面，后续按需重新生成。

## 血缘规则：什么算「子会话」

**子代理**（`origin: 'subagent'`）会被递归删除，包括子代理的子代理。

**fork 不算子会话。** fork 出来的会话虽然带 `parentSession` 字段，但没有 `subagent` 来源，它是独立对话，**会保留**。这条规则跟 DSH 自带归档门禁判定会话归属的规则完全一致。

- 弹窗会预览血缘：按标题列出子会话及数量
- toast 会汇报连带删除了几个
- 删子会话只删它自己的子树，父会话和兄弟会话不动

## 执行顺序与安全

删除严格按以下顺序，保证任何中间状态都不是撕裂的：

1. **收集血缘** — 从持久化 header 读，而不是从运行时的 Subagent catalog 读。这样即使中间某个会话读不出来，血缘依然完整。
2. **拒绝检查** — 只要血缘里**任何一个**会话还有工作在跑（进行中的回合、运行中的子代理、后台任务、定时提醒），就以 `session/delete-active` 拒绝，并在详情里列出**每一个**出问题的会话 ID 和它的活动类型。拒绝时不会删除任何东西。
3. **释放 Agent** — 深度优先（先子后父）。子会话的 loop 先排空，父会话的日志才会消失，避免迟到的结算打到已经不存在的父级。
4. 清**投影缓存**行
5. 删**日志目录**
6. 从**工作区记账**中移除

第 3～6 步都是**容错**的（失败只记日志、不抛错），避免某个派生存储卡死导致日志残留——日志才是侧栏会一直显示的那个东西。

## 实现说明

插件分 Host / Client 两半，通过 **Connection 上的 HTTP 路由**通信：

| 文件 | 职责 |
|---|---|
| `lib/index.js` | Host 半边：注册 `POST /api/session-delete.delete`，血缘遍历与有序删除 |
| `lib/client.js` | 浏览器半边：菜单行、带血缘预览的确认弹窗、结果提示（控件全部内联，无 Harness 包依赖） |
| `cordis.patch.yml` | 插入唯一一条 Host 插件行 |
| `package.json` | bundle 清单：`dsh.bundle.patch` + web 端 `dsh.client` 配置 |
| `icon.svg`、`locale/*.json` | 插件管理页卡片元数据 |

## 验证清单

1. 侧栏悬停任一有内容的会话行，打开 `⋯` 菜单：**删除会话**是最后一项
2. 在一个有子代理的会话上点它：弹窗会写明保留边界，并列出将一并删除的子会话
3. 确认后：血缘里每一行都从侧栏消失，对应的 `~/.dsh/sessions/<项目>/<会话ID>/` 目录都不在了
4. 同一父会话 fork 出来的会话仍在侧栏
5. 侧栏搜索只存在于已删会话里的文字：无结果

## 已知边界

- 附件请求图缓存不清理，理由见上
- 血缘按持久化 header 遍历，因此**只覆盖已经落盘的会话**；纯内存中尚未 materialize 的子会话若不在 `session.list()` 里，不会被遍历到（实际使用中子会话总是先落盘）
- 删除是"整条血缘全或无"：任何一个后代在跑，整条都删不了。这是刻意的，半删会留下指向不存在父级的孤儿
- 客户端界面控件是内联实现而非复用宿主组件库。若 DSH 未来改动这些控件的视觉规范，插件需要跟进；代价换来的是不受宿主包变动影响

## 许可

MIT

## 相关

- DeepSeek Harness：https://www.deepseek.com/harness/
- 本插件未修改 DSH 任何文件，仅通过官方插件机制接入
