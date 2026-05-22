# 04 AI 实际读取流程

## 1. 解析文件

在仓库根目录运行：

```bash
node .agents/skills/codelocator/scripts/parse-codelocator-file.ts /path/to/file.codeLocator /tmp/codelocator-out
```

输出：

- `*.raw.json`：`.codeLocator` 内原始 `WApplication` JSON。
- `*.normalized.json`：常用字段还原后的结构，包含 `flatViews`。
- `*.screenshot.png`：历史截图。
- `*.metadata.json`：tag、插件版本、JSON/PNG 长度。

脚本本身不依赖第三方库，当前仓库环境的 Node 24 可直接执行 `.ts` 文件；不要下载依赖。

## 2. 先做全局判断

读取 `normalized.json` 的这些字段：

- `application.packageName`
- `application.className`
- `application.activity.className`
- `application.fromSdk`
- `application.hasSDK`
- `application.grabTime`
- `application.screen`

结论里要区分：

- SDK 抓取：tag 和 Fragment 关联更可信。
- dump fallback：可能只有基础 View 树，缺少源码 tag。
- 历史快照：只能反映抓取时刻 UI。

## 3. 找目标 UI

优先在 `application.flatViews` 检索：

```bash
rg -n "目标文案|app:目标id|目标类名" /tmp/codelocator-out/*.normalized.json
```

人工筛选时看：

- `text`
- `idStr`
- `className`
- `bounds` / `drawBounds`
- `path`
- `fragmentClassName`
- `tags`

如果用户给截图坐标，筛选包含坐标的 `drawBounds`，同一区域选择更小、更具体、可见的节点。

## 4. 生成源码定位结论

对候选 View 按以下格式组织：

```text
UI 归属：
- Activity: ...
- Fragment: ...（如果有 viewMemAddr 匹配）
- View: className=..., idStr=..., text=..., path=...

源码线索：
- XML: ...
- clickTag: ...
- touchTag: ...
- findViewByIdTag: ...
- ViewHolder/Adapter: ...
- 兜底检索词: ...

定位结论：
- 精确行号 / XML id / 候选类，并说明证据字段。
```

有多个候选时，按证据强度排序：行号 tag > XML + id > Fragment root + id/text > className/path。

## 5. 在源码仓库中检索

常用检索：

```bash
rg -n "class TargetActivity|class TargetFragment|@+id/view_id|@id/view_id|view_id|目标文案" CodeLocatorApp CodeLocatorPlugin
```

如果 tag 是 `com.foo.Bar.kt:123`：

- 先按文件名找：`rg --files | rg 'Bar\\.(kt|java)$'`
- 再核对 package 或路径是否匹配 `com.foo`。
- 行号是 1-based，来自运行时 stack trace。

如果 tag 是 `SomeBinding.kt:bind_id/title:45`：

- 优先搜索 `title` 的 binding id 或 XML id。
- 找不到再跳到 line 45 附近。

## 6. 输出时的边界

必须明确哪些是源码证据、哪些是推断：

- “`clickTag` 指向 ...” 是强证据。
- “`text/idStr/className` 匹配 ...” 是候选证据。
- “没有 `xmlTag/clickTag`” 表示不能精确说明创建/点击代码行。

不要把 `memAddr` 当作稳定 ID 跨文件比对；它只适合同一个 `.codeLocator` 快照内关联 Fragment 和 View。
