---
name: codelocator
description: CodeLocator Android 调试工具的双向能力——既能解析已抓取的 .codeLocator 文件并反查 Android 源码（layout/Activity/Fragment/click handler/view chain），也能直接通过 ADB 驱动设备 SDK 实时抓帧、发 schema、查最近真实触摸命中的 view chain。触发条件：(1) 消息含 .codeLocator / .cl 文件路径，或 ~/.codeLocator_main/ / historyFile/ 路径片段；(2) 用户说 CodeLocator / 抓取数据 / 抓取文件 / 历史抓取 / grab；(3) 用户给 Android 截图问「这个按钮 / View / Fragment / Activity 在哪个源码」；(4) 用户要从 UI 截图反查 layout xml / ViewBinding / ViewHolder / Adapter；(5) 消息含 codelocator://view? URI；(6) 用户问「这俩 view 离多远 / 对齐了吗」；(7) 反向操作触发——「抓一帧 com.xxx.yyy」「看看屏幕现在是什么 Activity」「发个 schema 跳一下：xxx://yyy」「我刚才点的 view 是什么」「查最近的触摸链」；(8) 用户说「列出抓取 / 最近抓了什么 / 历史文件」时未指定目录，直接用默认目录 ~/.codeLocator_main/historyFile/，不要反问。
---

# CodeLocator skill

CodeLocator 是 Android 调试工具（IDE 插件 + 设备端 SDK）。本 skill 提供两类能力：

- **读侧**：解析 `.codeLocator` 文件，反查 layout / Activity / Fragment / 源码行号
- **反向**：通过 ADB 驱动设备 SDK 实时抓帧 / 发 schema / 查触摸链，不依赖 IDE 进程

所有脚本位于 `~/.claude/skills/codelocator/scripts/`，反向操作可通过 `cli.ts` 统一入口或各子命令独立跑。`.codeLocator` 默认落盘 `~/.codeLocator_main/historyFile/`，文件名 `<package>YYYY_MM_DD_HH_MM_SS.codeLocator`。**用户提到"列出 / 最近 / 历史"等未指定目录时直接用默认目录，不要反问。**

## 第一步分支

按用户意图分发到对应章节：

| 用户意图 | 走 |
| --- | --- |
| 给了 `.codeLocator` 文件 / 要解析已有抓取 | 「解析 .codeLocator」 |
| 实时抓 / 发 schema / 查触摸链 | 「反向操作」 |
| 列出有哪些抓取文件 | 「列出历史抓取」 |
| 元素距离 / 对齐 | 「元素距离测量」 |
| `codelocator://view?` URI | 「ViewLink URI 解析」 |

## 反向操作（grab / schema / find-click）

统一入口 `node ~/.claude/skills/codelocator/scripts/cli.ts <sub>`；各子命令也可独立跑（`node ~/.claude/skills/codelocator/scripts/<sub>.ts`），行为一致。

### 命令清单（以 `--help` 为准）

| 子命令 | 用途 | 核心参数 |
| --- | --- | --- |
| `grab` | 抓当前前台 App 的 View 树 + 截图，落盘到历史目录 | `--device <serial>`、`--package <pkg>`、`--output-dir <dir>`、`--no-foreground-check`（跳过前台校验）、`--need-color`、`--pretty` |
| `schema` | 发 deep link：先 `am start -d` 试，失败回落 `ACTION_PROCESS_SCHEMA` 广播 | 位置参数 `<url>` 或 `--schema '<uri>'`、`--device <s>` / `-s`、`--no-fallback`、`--save-to-file` |
| `find-click` | 拿最近一次真实触摸命中的 view chain memAddr；可联动 `.codeLocator` 反查 className/idStr/bounds | `--serial <s>` / `--device <s>`（别名）、`--codelocator <file>` 或自动取 mtime 最新、`--pretty` |

> ⚠ 参数别名差异：`grab` 用 `--device`，`find-click` 接受 `--serial` 或 `--device`，`schema` 接受 `--device` 或 `-s`。**无脑用 `--device` 三个子命令都正确**。

所有命令的 stdout 都是 JSON。成功 `{ status: "ok", ... }`，失败 `{ status: "error", error: { code, message, ... } }`——**按 code 排查，不要硬试**。

### 工作流：抓一帧 + 反查源码

```bash
# 1. 抓一帧
node ~/.claude/skills/codelocator/scripts/cli.ts grab --pretty
# stdout 含 historyFile 绝对路径

# 2. 拿 historyFile 走解析（与读侧一致）
node ~/.claude/skills/codelocator/scripts/cli.ts parse <historyFile> <out-dir> --src <android-project-root>
```

### find-click 工作流

1. **让用户先在设备屏幕上点一下**（SDK 读 `ViewGroup.mFirstTouchTarget`，必须有真实触摸）
2. `node ~/.claude/skills/codelocator/scripts/cli.ts find-click --pretty`
3. 返回 `addresses: string[]`；同包近期 `.codeLocator` 存在时还有 `resolved: [{className, idStr, bounds, path}]`
4. 空 addresses = 没点过 / Activity 切换 / 框架已 reset，提示用户**重新点一下**再跑

### schema 工作流

```bash
node ~/.claude/skills/codelocator/scripts/cli.ts schema --schema 'snssdk1128://feed?tab_id=1'
# 关闭广播兜底：cli.ts schema 'aweme://discover' --no-fallback
```

先 `am start -d`；失败时（路由不命中等）自动回落 `ACTION_PROCESS_SCHEMA` 广播。`--no-fallback` 仅试 am start。

## 列出历史抓取

```bash
node ~/.claude/skills/codelocator/scripts/cli.ts list-history [--dir <d>] [--package <pkg>] [--limit N] [--pretty]
```

默认扫 `~/.codeLocator_main/historyFile/`，输出 JSON manifest（按 grabTime 倒序，含 path / package / grabTime / sizeBytes）。用户没指定目录时直接跑，不要反问。仅当用户明确说"扫某个非默认目录"时才传 `--dir`。

## 解析 .codeLocator 文件

```bash
node ~/.claude/skills/codelocator/scripts/cli.ts parse <file.codeLocator> <output-dir> --src <android-project-root>
```

### 产物文件（按打开优先级）

| 文件 | 何时读 | 备注 |
| --- | --- | --- |
| `*.summary.md` | "这是哪个 Activity / Fragment / 用哪个 layout" | 首选，80% 场景够用 |
| `*.xml_to_source.md` | "这个 layout 在哪个类里 inflate" | 改源码前必看（需 `--src`） |
| `*.screenshot.png` | 按位置/视觉判断点的是哪个区域 | Read 工具支持 PNG |
| `*.normalized.json` | summary 没覆盖的 view / 完整树 | 字段去缩写的中层数据 |
| `*.raw.json` | 要 SDK 原始字段 | 大文件，精确 grep |
| `*.metadata.json` | 解析出错排查 | 调试用 |

### 定位 View 优先级

1. 截图坐标或用户描述 → 过滤 `bounds/drawBounds`、`text`、`idStr`
2. `tags.xmlTag / findViewByIdTag / clickTag / touchTag / drawableTag / viewHolderTag / adapterTag`
3. `fragmentClassName`（来自 `WFragment.viewMemAddr` 与 `WView.memAddr` 匹配，只说明 Fragment 直接持有该 root view）
4. **找 layout 持有类（Fragment / Adapter / ViewHolder）→ 优先 `*.xml_to_source.md` 按 xmlTag 直接查；找不到再全仓 grep**

### 定位源码优先级

1. XML：`xmlTag` + `idStr`，打开 layout 搜 `@+id/<id>` 或 `@android:id/<id>`
2. Java/Kotlin 行号：`clickTag / touchTag / findViewByIdTag / startInfo` 解析出的 `fileName:line`
3. ViewBinding / ButterKnife：tag 含 `id/...` 或 `bind_id/...`，按 id 搜索
4. RecyclerView：`viewHolderTag` / `adapterTag` 先定位 holder/adapter，再结合 `idStr/text/树路径`
5. 兜底：`className/idStr/text/path` 全仓检索

## ViewLink URI 解析

用户消息含 `codelocator://view?...` 时：

1. URL decode querystring，提取：`file` / `path` / `memAddr` / `class` / `id` / `xml`
2. 用 `file` 跑 `cli.ts parse` 生成 normalized.json
3. 在 `flatViews[]` 按 `path` **精确匹配**（脚本生成的 path 与 link 同格式 `decorViews/0/...`）
4. fallback：`path` 失败 → `memAddr` 匹配 → `class+id` 模糊匹配
5. 校验：URI 的 `class+id` 与命中节点字段比对，不一致时提示 URI 可能过期

**快速路径**：link 含 `xml` 字段（来自 `view.xmlJumpInfo.fileName`）时，可直接 `find <android-project-root> -name "<xml>" -not -path "*/build/*"` 找到 layout 位置，跳过 parse 脚本。

> 跨抓取时 `memAddr` 会变，因此 `path` 优先于 `memAddr`。

## 元素距离测量

用户问"这俩 view 离多远"、"对齐了吗"、"为什么没对齐"时：

```bash
node ~/.claude/skills/codelocator/scripts/cli.ts measure-distance <file.normalized.json> \
  --a <selector> --b <selector> [--use draw|bounds] [--tol 1] [--md] [--pretty]
```

Selector 格式 `key=value`，多条件用 `,` 连接（AND）：

| key | 含义 | 示例 |
| --- | --- | --- |
| `path` | flatViews[].path 精确 | `path=decorViews/0/2/1` |
| `idstr` | idStr 完全 | `idstr=app:btnOk` |
| `id` | idStr 中 id 部分（自动剥 `app:` / `android:` / `id/`） | `id=btnOk` |
| `text` | text 完全 | `text=确定` |
| `mem` | memAddr 完全 | `mem=091ba14e` |
| `class` | 短类名或全类名后缀 | `class=ImageView` |
| `index` | 多命中时取第 N 个（0-based） | `index=0` |

**默认 `--use draw`（屏幕绝对坐标）**；只有同父子节点之间才适合 `--use bounds`。

输出（JSON 或 `--md` markdown）含：
- `a` / `b`：命中节点的 path、idStr、bounds、size（px/dp）、center
- `distance.horizontalGap / verticalGap`（正数为间距，负数为重叠）
- `distance.centerDx / centerDy / centerDistance`
- `distance.edges`（四方向边到边）
- `distance.alignment`（left/right/top/bottom/centerX/centerY 是否在容差内对齐，默认 1px，`--tol` 可调）
- `distance.relation`（`contains` / `containedBy` / `equal` / `intersects` / `disjoint` / `edgeAligned`）
- `distance.summary`（人类可读中文）

歧义：
- `status=ambiguous` → 看 `candidates`，selector 追加 `path=/mem=/index=N`
- `status=not_found` → 换更宽松条件，或先 grep `normalized.json` 的 flatViews

## 按任务类型查表

| 用户问什么 | 第一步 | 第二步 |
| --- | --- | --- |
| "这个按钮点了跳到哪？" | `summary.md`（找 text/idStr） | `xml_to_source.md`（找持有类） |
| "这个 layout 被谁用？" | `xml_to_source.md` | - |
| "列出最近的抓取" | `cli.ts list-history` 看 stdout JSON | - |
| "为什么 xmlTag 是 `-`？" | 「限制」段 | - |
| "想看完整 view 树深结构" | `normalized.json` 的 `activity.decorViews` | - |
| "按像素位置反查 view" | `screenshot.png`（视觉） | `summary.md`（按 bounds 过滤） |
| "脚本解析失败了" | `metadata.json` | - |
| "这俩 view 离多远 / 对齐了吗" | `cli.ts measure-distance` | 默认 `--use draw` |
| "抓一帧 / 抓一下当前界面" | `cli.ts grab --pretty` | stdout 拿 `historyFile` 后走「解析」 |
| "发个 schema 跳一下：xxx://yyy" | `cli.ts schema --schema '<uri>'` | 失败自动回落广播 |
| "我刚才点的 view 是什么" | 让用户先点屏，再 `cli.ts find-click --pretty` | 反查需要近期 `.codeLocator`（自动取或 `--codelocator <file>`） |

## 限制

**读侧**：
- `.codeLocator` 是抓取时刻快照，运行时对象地址只适合同快照内关联，不可跨抓取比对
- 未接入 SDK 或 Lancet 关时，`xmlTag/clickTag/touchTag/findViewByIdTag` 可能为空——依赖 dump fallback、类名、id、文本、坐标
- raw JSON 用 `@SerializedName` 短字段名；优先读 normalized JSON

**反向操作**：
- 设备必须连接（`adb devices` 可见），多设备时必须 `--device <serial>`
- App 必须集成 CodeLocator SDK（含 `CodeLocatorProvider` + `CodeLocatorReceiver`）
- App 必须在前台（`grab` / `find-click`）；后台时 SDK 会 `unregisterReceiver`
- mock 触点（按坐标主动模拟点击）**不在 V1**：SDK 内置 IntentFilter 未注册 `ACTION_MOCK_TOUCH_VIEW`，需业务方扩展 SDK
- memAddr 跨进程失效：进程重启 / GC 后 `identityHashCode` 变化，需重新 grab

## 测试

```bash
cd ~/.claude/skills/codelocator/scripts

# 单元测试（无真机也能跑，零依赖，Node 18+）
node --test --experimental-strip-types __tests__/unit/*.test.ts

# 端到端（需真机 + 集成 SDK 的 App 在前台，否则自动 skip）
node --test --experimental-strip-types __tests__/e2e/*.e2e.ts
```

## 参考资料（按需读）

- `references/01-capture-and-storage-flow.md` — 抓取 / 传输 / 历史保存原理
- `references/02-codeLocator-file-format.md` — `.codeLocator` 二进制格式（自己解析时读）
- `references/03-ui-data-model-and-source-location.md` — `xmlTag/clickTag` 等字段语义 + 源码定位规则
- `references/04-agent-workflow.md` — agent 第一次接触本 skill 时按此走一遍
