# CodeLocator 抓取数据读取与 Android 源码定位

## 插件背景知识

CodeLocator IDE 插件抓取的所有 `.codeLocator` 文件**默认落盘在**：

```
~/.codeLocator_main/historyFile/
```

文件名规则：`<package>YYYY_MM_DD_HH_MM_SS.codeLocator`
例：`com.netease.gl2026_05_21_14_50_18.codeLocator` → package=`com.netease.gl`，抓取时间=`2026-05-21 14:50:18`

**重要约定**：
- 用户提到「抓取历史」「最近抓的」「有哪些 codeLocator」**但没指定目录**时，**直接用默认目录**调 `list-history.ts`，**不要反问用户**「目录在哪里」。
- 仅当用户明确说"扫某个非默认目录"时才传 `--dir <dir>`。

## 触发场景

**自动触发条件**（命中任一即应使用本 skill）：

- 用户消息里出现 `.codeLocator` / `.cl` 后缀的文件路径
- 用户消息里出现 `CodeLocator`、`抓取数据`、`抓取文件`、`历史抓取`、`grab` 字样
- 路径包含 `~/.codeLocator_main/` 或 `historyFile/` 字样
- 用户给出 Android 应用截图并问「这个界面 / 按钮 / 点击 / View / Fragment / Activity 在哪个源码」
- 用户要求从 UI 截图反查 layout xml、ViewBinding、ViewHolder、Adapter
- 用户要求把 CodeLocator 抓取数据和某个 Android 项目的源码对应起来
- 用户提到「列出抓取」、「抓取历史」、「最近的抓取」、「有哪些 .codeLocator」、「历史文件」
- 用户提到 `~/.codeLocator_main/historyFile/` 目录（即使没给具体文件）
- 用户说「列出抓取」「最近抓了什么」**但没指定目录**时，**直接用默认目录** `~/.codeLocator_main/historyFile/` 跑 `list-history.ts`，不要反问目录

**典型 prompt 模式**（看到类似就触发）：

- "这个 .codeLocator 文件对应的源码在哪"
- "解析一下这个抓取文件"
- "这个按钮点的代码在哪里"（同时给了 .codeLocator）
- "/path/to/xxx.codeLocator /path/to/android-project 这个界面对应的项目源码在这里"

触发后第一步永远是调用 `scripts/parse-codelocator-file.ts`，按 stdout 的 JSON manifest 的 `next_steps` 引导走。

## 列出历史抓取

**触发**：用户说「列出抓取」「最近抓了什么」「有哪些 .codeLocator」等，**无论是否指定目录**。

**第一动作**（用户没指定目录时直接跑，不要反问）：

```bash
node /Volumes/SourceCode/Users/hangox/OtherProjects/CodeLocator/.claude/skills/codelocator/scripts/list-history.ts
```

默认扫 `~/.codeLocator_main/historyFile/`（见「插件背景知识」段），输出 JSON manifest（含 path / package / grabTime / sizeBytes，按时间倒序）。

可选 flag：
- `--dir <dir>`：覆盖默认目录（仅当用户明确说要扫别处）
- `--package <pkg>`：按包名前缀过滤
- `--limit N`：截断前 N 条（默认 50）
- `--pretty`：缩进 JSON（默认 compact）

拿到结果后由用户挑一条，再走「快速流程」用 `parse-codelocator-file.ts` 解析。

## ViewLink URI 解析

当用户消息中包含 `codelocator://view?...` 形式的 URI 时，按以下步骤定位目标 View：

1. URL decode 解析 querystring，提取参数：
   - `file`：抓取文件绝对路径
   - `path`：View 在树中的路径，如 `decorViews/0/2/1/0/5/0`
   - `memAddr`：View 内存地址，如 `091ba14e`
   - `class`：完整类名
   - `id`：View idStr，如 `app:ivAdGame`
   - `xml`：（可选）关联的 layout xml 文件名（如 `item_recommend_game_list.xml`），由插件「跳转 XML」功能同源字段。link 带这个时优先用它直接定位 layout 文件，可省去跑 parse 脚本

2. 用 `file` 跑解析脚本生成 normalized.json：
   ```bash
   node .claude/skills/codelocator/scripts/parse-codelocator-file.ts <file> <out-dir> --src <android-project-root>
   ```

3. 在 `normalized.json` 的 `flatViews[]` 中按 `path` 字段**精确匹配**命中目标节点（path 格式天然对齐：脚本生成的 path 也是 `decorViews/0/...` 格式）。

   **快速路径**：若 link 里含 `xml` 字段（来自 `view.xmlJumpInfo.fileName`），可直接 `find <android-project-root> -name "<xml>" -not -path "*/build/*"` 找到 layout 文件位置，跳过 parse 脚本，前提是用户问的就是「这个 view 关联的 layout 在哪」。

4. Fallback 策略：
   - **path 失败** → 用 `memAddr` 匹配 `flatViews[*].memAddr`
   - **path + memAddr 都失败** → 用 `class` + `id` 模糊匹配（可能多命中，需结合上下文判断）

5. 二次校验：命中后用 URI 中的 `class` + `id` 与节点字段比对，不一致时提示用户 URI 可能过期。

> URI 是同一份抓取文件内的稳定定位。跨抓取时 `memAddr` 会变，因此 `path` 优先于 `memAddr`。

## 快速流程

1. 解析文件：
   ```bash
   node .claude/skills/codelocator/scripts/parse-codelocator-file.ts <file.codeLocator> <output-dir> --src <android-project-root>
   ```
   输出包括 `*.raw.json`、`*.normalized.json`、`*.summary.md`、`*.xml_to_source.md`（仅 `--src` 时生成）、`*.screenshot.png` 和 `*.metadata.json`。
2. 先看 `summary.md`：
   - 优先用摘要确认 Activity / Fragment / 文本 View / XML / View Tree，再按需回看 `normalized.json`。
3. 再看 `normalized.json`：
   - `application.activity.className` 判断当前 Activity。
   - `application.activity.fragments[*].className/viewMemAddr` 判断 Fragment 与根 View 的关系。
   - `flatViews[*]` 按 `path/zIndex/className/idStr/text/bounds/tags` 检索目标 UI。
4. 定位 View：
   - 先用截图坐标或用户描述过滤 `bounds/drawBounds`、`text`、`idStr`。
   - 再看 `tags.xmlTag/findViewByIdTag/clickTag/touchTag/drawableTag/viewHolderTag/adapterTag`。
   - `fragmentClassName` 来自 `WFragment.viewMemAddr` 与 `WView.memAddr` 的匹配，只能说明该 Fragment 直接持有这个 root view。
   - **定位 layout 的持有类（Fragment/Adapter/ViewHolder）→ 优先看 `*.xml_to_source.md`，按 xmlTag 直接查；找不到再回退到全仓 grep。**
5. 定位源码优先级：
   - XML：`xmlTag` + `idStr`，打开对应 layout XML 并搜索 `@+id/<id>` 或 `@android:id/<id>`。
   - Java/Kotlin 行号：`clickTag/touchTag/findViewByIdTag/startInfo` 解析出的 `fileName:line`。
   - ViewBinding/ButterKnife：tag 中的 `id/...` 或 `bind_id/...`，按 id 搜索。
   - RecyclerView：`viewHolderTag`、`adapterTag` 先定位 holder/adapter，再结合 `idStr/text/树路径`。
   - 兜底：`className/idStr/text/path` 全仓检索。

## 产物文件速查（按打开优先级）

| 文件 | 你想知道什么 → 打开 | 备注 |
| --- | --- | --- |
| `*.summary.md` | 「这是哪个 Activity / Fragment / 用哪个 layout」 | 首选，80% 场景够用 |
| `*.xml_to_source.md` | 「这个 layout 在哪个类里被 inflate」 | 改源码前必看（需 `--src`） |
| `*.screenshot.png` | 「按位置/视觉判断点的是哪个区域」 | Read 工具直接支持 PNG |
| `*.normalized.json` | 「summary 没覆盖的 view / 完整 view 树」 | 字段去缩写的中层数据 |
| `*.raw.json` | 「normalized 也不够，要 SDK 原始字段」 | 大文件，只精确 grep |
| `*.metadata.json` | 「解析出错排查」 | 调试用 |

## 按任务类型查表

| 用户问什么 | 第一步 Read | 第二步 |
| --- | --- | --- |
| "这个按钮点了跳到哪？" | `summary.md`（找 text/idStr） | `xml_to_source.md`（找持有类） |
| "这个 layout 文件被谁用？" | `xml_to_source.md` | - |
| "列出最近的抓取 / 有哪些历史文件" | 调 `list-history.ts` 看 stdout JSON | - |
| "为什么 xmlTag 是 `-`？" | SKILL.md「限制」段 | - |
| "想看完整 view 树深结构" | `normalized.json` 的 `activity.decorViews` | - |
| "按像素位置反查 view" | `screenshot.png`（视觉） | `summary.md`（按 bounds 过滤） |
| "脚本解析失败了" | `metadata.json` | - |

## 参考资料（按需读）

- `references/01-capture-and-storage-flow.md` — 想了解抓取/传输/历史保存原理时读
- `references/02-codeLocator-file-format.md` — 想自己解析 `.codeLocator` 二进制格式时读
- `references/03-ui-data-model-and-source-location.md` — 想了解 xmlTag/clickTag 等字段的语义和源码定位规则时读
- `references/04-agent-workflow.md` — AI agent 第一次接触本 skill 时按此走一遍

## 限制

- `.codeLocator` 历史文件保存的是抓取时刻快照，运行时对象地址只适合在同一快照内关联，不适合跨抓取比对。
- 未接入 SDK 或 Lancet 信息关闭时，`xmlTag/clickTag/touchTag/findViewByIdTag` 可能为空，只能依赖 dump fallback、类名、id、文本和坐标。
- raw JSON 使用 `@SerializedName` 短字段名；优先读脚本导出的 normalized JSON。
