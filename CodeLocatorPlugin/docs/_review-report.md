# `_review-report.md` · 8 篇调研文档核对报告

> 核对人：senior（cl-mastery-39215）
> 核对范围：`CodeLocatorPlugin/docs/01-08-*.md`
> 核对方法：Read 工具实际打开源码逐条比对（含 `CodeLocatorApp/CodeLocatorCore/CodeLocatorModel` 跨模块）
> 核对策略：全部 8 篇逐条核对引用真实性 + 5 ACTION + 5 EditType + 7 外部 adb 样例 + mermaid 语法 + 跨文档一致性 + MVP Top 3 合理性 + 9 处 ❓ 澄清
>
> 总体评价：**整体质量很高**，对源码理解准确，命令样例可执行。问题集中在两块：(1) **设备端文件落盘路径在 API 30+ vs <30 的判断方向写反了**（贯穿 03/04/06 文档），(2) **ViewLink 协议名称错写为 `viewlink`，实为 `view`**（贯穿 01/07）。其余多数为行号微小偏移、漏列若干常量等次要瑕疵。

---

## 0. 一句话结论

| 文档 | 引用准确率 | 重大事实错误 | 备注 |
|------|-----------|-------------|------|
| 01-插件功能总览.md | 高 | 1 处（ViewLink 协议名） | 行号引用全部对得上 |
| 02-整体架构与通信模型.md | 高 | 0 | mermaid 语法 OK，行号都对 |
| 03-ADB命令与BroadcastAction协议.md | 高 | 2 处（API 30+ 路径方向反，ACTION_MOCK_TOUCH_VIEW 未注册未提及） | 协议常量名/值 100% 正确 |
| 04-抓取流程详解.md | 高 | 1 处（设备端 API 30+/<30 路径方向写反） | 行号、流程图都对 |
| 05-数据文件格式.md | 高 | 0 | 二进制布局描述正确 |
| 06-设备端SDK约定.md | 高 | 2 处（同上：路径方向反 + MOCK_TOUCH_VIEW 未注册没明示） | 9 个内置 action 数量对得上 |
| 07-IDE端Action与扩展点清单.md | 高 | 1 处（ViewLink 协议名）+ 1 处描述错（RemoveSourceCodeAction） | 54 Action 文件数对得上 |
| 08-反向操作可行性矩阵.md | 高 | 1 处（3.6 节命令实际不会被接收） | MVP Top 3 推理合理 |

---

## 1. 必须修正清单（实质性事实错误）

> 这些必须修正才能让 skill 反向操作脚本跑通。

### MUST-1 · 设备端文件落盘路径方向反了（贯穿 03 / 04 / 06）

**源码事实**（`CodeLocatorApp/CodeLocatorCore/.../FileUtils.java:143-150`）：

```java
public static File getFile(Context context, String fileName) {
    File fileStreamPath = new File(context.getExternalCacheDir(),
        CodeLocatorConstants.BASE_DIR_NAME + File.separator + fileName);
    if (Build.VERSION.SDK_INT >= CodeLocatorConstants.USE_TRANS_FILE_SDK_VERSION) {
        verifyStoragePermissions(CodeLocator.getCurrentActivity());
        fileStreamPath = new File(codeLocatorTmpDir, fileName);   // ←= BASE_DIR_PATH
    }
    return fileStreamPath;
}
```

也就是说：
- **API ≥ 30**：写到 `codeLocatorTmpDir = /sdcard/codeLocator/<fileName>`（`BASE_DIR_PATH`）。
- **API < 30**：写到 `context.getExternalCacheDir()/codeLocator/<fileName>` = `/sdcard/Android/data/<pkg>/cache/codeLocator/<fileName>`。

**文档现状（错）**：

| 出处 | 错误描述 |
|------|---------|
| `03 §6` 第 4 条 | 说 "API 30+ 把 codeLocator_data.txt 写在 `<ExternalCacheDir>/codeLocator/`" |
| `03 §4.1` 注释 | 样例路径写 `/sdcard/Android/data/<pkg>/cache/codeLocator/codeLocator_data.txt` 并标注 "API 30+" |
| `04 §6` 表格 | API≥30 写 ExternalCacheDir、API<30 写 `/sdcard/Download/`，方向完全反 |
| `04 §6` 文字 | "API 30+ 必须 `KEY_SAVE_TO_FILE=true`，否则 broadcast 把整个压缩串塞进 `data=`" 这句结论本身没错，但路径示例错 |
| `06 §5` 表 / `06 §11.2 ❓` | 说 "API 30+ 用 ExternalCacheDir，API < 30 走 `/sdcard/Download/` 或 BASE_DIR_PATH" |

**统一应改成**：
> SDK 端 `FileUtils.getFile(context, fileName)` 实现：
> - **API ≥ 30**：`/sdcard/codeLocator/<fileName>`（`BASE_DIR_PATH`）+ 调 `verifyStoragePermissions` 申请旧 SDcard 写权限
> - **API < 30**：`<ExternalCacheDir>/codeLocator/<fileName>` = `/sdcard/Android/data/<pkg>/cache/codeLocator/<fileName>`
>
> 因此反向 skill 一定要从 broadcast `data="FP:<path>"` 字段拿实际路径，不要按 API 等级硬编码。

> 注：旧 `/sdcard/Download/codeLocator_data.txt`（`TMP_TRANS_DATA_FILE_PATH`）只在 `getScreenCapByFile` 这种 IDE 主动指定路径的场景下使用，不是 SDK `sendResult` 的落盘位置。

### MUST-2 · `ACTION_MOCK_TOUCH_VIEW` 实际不会被 SDK Receiver 接收

**源码事实**：
- `CodeLocator.java:397-405` 的 IntentFilter **只** addAction 了 9 个内置 action，**没有** `ACTION_MOCK_TOUCH_VIEW`。
- `CodeLocatorReceiver.onReceive` (`CodeLocatorReceiver.java:133`) 的 switch 写了 `case ACTION_MOCK_TOUCH_VIEW`，但因为 IntentFilter 不匹配，永远到不了这个 case。

**影响**：
- `03 §2.2` 把 `ACTION_MOCK_TOUCH_VIEW` 列为 SDK 监听 action — 错。
- `03 §4.3`、`08 §3.6` 给出的样例命令实际不会被任何 receiver 处理（除非业务方通过 `ICodeLocatorProcessor.providerRegisterAction` 把它加进 filter）。
- `08 §5 V2.4` 把 "模拟点击" 列为 V2 候选 — 必须先修 SDK / 提供 Processor。

**建议改动**：
- `03 §2.2` 给 `ACTION_MOCK_TOUCH_VIEW` 加一行 ⚠ 备注 "Receiver 写了 case 但 IntentFilter 未注册（CodeLocator.java:397-405），实测发不出去；需业务方自行通过 ICodeLocatorProcessor 注册"。
- `03 §4.3` 改样例为可选展示，并加注释 "需 SDK 端先注册 IntentFilter"。
- `08 §3.6` 同上加 ⚠。

### MUST-3 · `CopyViewLinkAction` 协议名写错（贯穿 01 / 07）

**源码事实**（`action/CopyViewLinkAction.kt:41`）：

```kotlin
val builder = StringBuilder("codelocator://view?")
```

**文档现状（错）**：
- `01 §7` 第 2 行："`Copy View Link ← CopyViewLinkAction（本仓库新增，生成 codelocator://viewlink?...）`"
- `07 §2` `CopyViewLinkAction.kt` 行：`生成 codelocator://viewlink?file=...&view=...`

**应改为**：
- 协议名为 `codelocator://view?`
- 实际 query 字段：`file`、`path`（不是 `view`）、`memAddr`、`class`、`id`、`xml`

### MUST-4 · `07 §2` 表中 `RemoveSourceCodeAction.kt` 描述写成 "反向操作"

文档把 `RemoveSourceCodeAction.kt` 的功能误标为 "反向操作"（line 71）。源码逻辑是 "撤销/移除 AddSourceCodeAction 加进来的源码索引模块"。

**应改为**："移除上一项加进来的源码索引模块"。

### MUST-5 · `07 §2` `InstallApkMenuAction.kt` 在表里出现两次

第 42 行和第 77 行重复列了 `InstallApkMenuAction.kt`。建议合并保留一行。

---

## 2. 可选修正清单（行号微偏移 / 小笔误 / 优化）

> 这些不影响 skill 工作，但纠正后文档更精确。

### O-1 · 行号微偏移（差 1-2 行的引用）

| 出处 | 引用 | 实际 |
|------|------|------|
| 02 §3 | `BroadcastAction.java:95-115` | 实际 `94-115`（`@Override` 在 94） |
| 02 §2 | `DeviceManager.java:553-635` | 实际 553 是方法签名，但 doc 列的 "553-635" 包含整段 ✓ 可保留 |
| 03 §2.4 注 | `EditModel.kt:39` | 实际是 `EditViewBuilder` 的 `editItemId` 定义在 39 ✓ |
| 04 入口 | `GrabViewAction.kt:35-37` | `Mob.mob(...)` 在 38，建议改成 `:35-38` 或 `:35` |
| 04 §3 表 | `getScreenCapByFile :2130-2179` | ✓ 完全正确 |
| 04 §3 表 | `historyFile save :826-828` | 实际是 `if (...!isWindowMode())` 块在 826-828 ✓ |
| 05 §3 | `CodeLocatorInfo.java:50-77` | 方法实际 50-78 / 包含 `} catch` 78、`return null` 76 — `50-78` 更精确 |
| 06 §1 | `CodeLocator.java:106` 调 `registerReceiver()` | ✓ |
| 06 §6 | `CodeLocatorProvider.java:32-41` query | ✓ |

### O-2 · 03 §2.4 EditType 表条目数

实际 `CodeLocatorConstants.EditType` 含 **33 个** 常量（含 `IGNORE / FECTH_URL / ASYNC_BROADCAST / GET_CLASS_INFO`），文档列 30+，可改成 "33 个"。

### O-3 · 02 §6 关键代码地图行号未给

只列了 "文件 / 入口"，没给具体行号；如果想严格做 codebase navigation，可补 `DeviceManager.java:553 / 381` 等。

### O-4 · 04 §10 反向 MVP 脚本里的 `<pkg>` 占位符没说明

读者看到 `/sdcard/Android/data/<pkg>/cache/codeLocator/...` 容易误以为是 API 30+ 路径（实际是 < 30）。在 MUST-1 修完后此行示例最好删掉、统一改用 "从 broadcast `FP:` 字段动态取"。

### O-5 · 05 §2 二进制布局描述 `int32 big-endian, Java DataOutput`

精确：DataOutputStream.writeInt 是 **big-endian**（network byte order）。✓ 无需修。但可加一句 "skill 端 Node.js 用 `buf.readUInt32BE` 解"。

### O-6 · 06 §2 表注 "SDK 监听的 Broadcast Action 列表"

实际 IntentFilter 注册了 9 个内置 action，表里却列了 10（含 MOCK_TOUCH_VIEW）。配合 MUST-2 修复时把这个标注一下。

### O-7 · `03 §4.4` 改 View 示例里的 `EDIT_B64` 行未使用

```bash
EDIT_B64=$(echo -n "$EDIT_CMD" | jq -aRs '.' | tail -c +2 | head -c -2) # 实际只要把 EDIT_CMD 作为 KEY_CHANGE_VIEW 值
```

这一行实际计算的 `EDIT_B64` 在后续命令里没用到（注释也写了"实际只要"）。容易让读者困惑，建议直接删掉。

### O-8 · `03 §1.1` 中 `DeleteFileAction` 标 `❓需要核对`

实测（见 ❓1 澄清）：`DeleteFileAction(filePath)` 调用 `super(ACTION.DELETE_FILE, filePath)`，对应命令 `rm <path>`（**不是 `rm -f`**）。可去掉 ❓。

### O-9 · `03 §1.1` 中 `UnInstallApkAction` 标 `❓需要核对参数`

实测：`UnInstallApkAction(pkgName)` 调用 `super(ACTION.INSTALL, pkgName)`（**注意：实际写的是 INSTALL 而非 UNINSTALL**），这是一个潜在源码 bug，但当前代码中没有调用方实例化它（grep 结果为 0），所以是**死代码**。如果未来要启用 `adb uninstall`，需修改 SDK 端：`super(ACTION.UNINSTALL, pkgName)`。

### O-10 · `04 §3` mermaid 颜色背景超长可读性差

`rect rgb(...)` 区块嵌套了多行 `note over + arrow + alt`，可读性 OK，但若有人想转 SVG/PNG，部分 mermaid 渲染器对中文+rect 联用支持不佳。如果导出图片再嵌入文档，最好先把 `rect rgb()` 改成阶段 note 即可。

---

## 3. mermaid 语法核对

逐图过了一遍，**没有明确语法错误**：

- 02 §1 `flowchart LR` + `subgraph IDE["…"]` ✓
- 02 §4 `sequenceDiagram` + `autonumber` + `alt … else … end` ✓
- 04 §3 `sequenceDiagram` + `rect rgb(…)` 嵌套 `note + arrow` ✓
- 06 §1 `flowchart TB` + `subgraph + edge label` ✓

边缘风险点（不算错误）：
- 04 §3 的 `rect rgb(245,245,220)`、`rect rgb(220,230,245)`、`rect rgb(220,245,220)` 不是所有 mermaid live editor 默认主题都好看，但语法是合法的（v8.13+ 支持）。

---

## 4. 协议字段抽样回源（5 ACTION + 5 EditType）

### 5 ACTION 抽样

| Action 常量 | 文档值 | 源码值（CodeLocatorConstants.java:26-46） | 结果 |
|------------|--------|--------------------------------------------|------|
| `ACTION_DEBUG_LAYOUT_INFO` | `com.bytedance.tools.codelocator.action_debug_layout_info` | 同 | ✅ |
| `ACTION_CHANGE_VIEW_INFO` | `...action_change_view_info` | 同 | ✅ |
| `ACTION_PROCESS_SCHEMA` | `...action_process_schema` | 同 | ✅ |
| `ACTION_PROCESS_CONFIG_LIST` | `...action_process_config_list` | 同 | ✅ |
| `ACTION_USE_TOOLS_INFO` | `...action_use_tools_info` | 同 | ✅ |

### 5 EditType 抽样

| EditType | 文档值 | 源码 | 结果 |
|----------|--------|------|------|
| `TEXT` | `T` | line 162 `String TEXT = "T";` | ✅ |
| `VIEW_FLAG` | `VF` | line 150 `String VIEW_FLAG = "VF";` | ✅ |
| `MARGIN` | `M` | line 146 | ✅ |
| `VIEW_BITMAP` | `VB` | line 182 | ✅ |
| `INVOKE` | `IK` | line 200 | ✅ |

### 16 个 KEY 抽样

`CodeLocatorConstants.java:50-96` 实际定义 **17 个** `KEY_*` 常量（含 `KEY_SHELL_ARGS`、`KEY_CHANGE_VIEW` … `KEY_TOOLS_COMMAND`）。文档 03 §2.3 表里全列出了（17 条），与源码一致 ✅。

### 14 ACTION 计数

`CodeLocatorConstants.java` 实际定义 **11 个** `ACTION_*` 常量；加上 2 个 helper APK 用的字面量字符串（`codeLocator_action_get_clipboard / set_clipboard`），共 13 个。文档 03 §2.2 表列了 12 行（漏掉 `codeLocator_action_set_clipboard` 或合并表述），核对一遍后整体齐全 ✅。

> 注：leader 提示的 "14 个 ACTION" 含 mock_touch（写在 IDE 端常量里）+ clipboard 等，与 SDK 实际注册数不一致，详见 MUST-2。

---

## 5. 7 个外部 adb 命令样例核对

| 文档章节 | Action 名 | KEY 名 | JSON 字段名 | 结果 |
|----------|----------|--------|-------------|------|
| 03 §4.1 抓取 | `action_debug_layout_info` ✅ | `codeLocator_save_to_file / need_color` ✅ | 直接复制可跑 | ✅ |
| 03 §4.2 点击链路 | `action_get_touch_view` ✅ | `codeLocator_save_to_file` ✅ | ✅ |
| 03 §4.3 模拟点击 | `action_mock_touch_view` ⚠ | `mock_click_x/y / save_to_file` ✅ | **但 SDK 未注册 filter，命令发不出去** |
| 03 §4.4 改文本 | `action_change_view_info` ✅ | `change_view + save_to_file` ✅ | itemId 示例 305419896 = 0x12345678 ✅ |
| 03 §4.5 Schema | `action_process_schema` ✅ | `schema + save_to_file` ✅ | ✅ |
| 03 §4.6 布局边界 | `action_use_tools_info` ✅ | `tools_command` + `command_update_activity` ✅ | ✅ |
| 03 §4.7 Provider 查询 | `content://<pkg>.CodeLocatorProvider` ✅ | 列名 `CodeLocatorVersion / AsyncBroadcast / AsyncResult` 与 `CodeLocatorProvider.java:33` 一致 ✅ | ✅ |

> 唯一问题集中在 §4.3 模拟点击，详见 MUST-2。

---

## 6. 跨文档一致性核对

| 校对点 | 04 | 06 | 08 | 结果 |
|--------|-----|-----|-----|------|
| 设备落盘 API≥30/<30 路径 | 4 §6 错（方向反） | 6 §5 错（方向反） | 8 §7.6 仅说"从 FP 拿，不要硬编码"，描述正确 | **不一致**，按 MUST-1 统一 |
| `data="FP:<path>"` 字段语义 | 4 §3、§10 | 6 §4、§12 | 8 §7、§8 | ✅ 三处一致 |
| `memAddr` 失效时机 | 04 §9 fallback / mention | 06 §11 ❓ "进程重启或 GC 后失效" | 08 §3.5、§7.1 强调 "每次 grab 前重新拿" | ✅ 一致 |
| `KEY_SAVE_TO_FILE` 强制落盘 | 4 §10 mvp | 6 §4 sendResult | 8 §7.4 总结 | ✅ |

---

## 7. MVP Top 3 合理性核对（08 §5）

| 候选 | 文档判定 | 实际依赖 | 评价 |
|------|---------|---------|------|
| 🥇 Grab View | 无状态、不依赖 memAddr、不依赖 IDE PSI、100-200 LOC | ✅ 完全成立。最大依赖只有 App 在前台 + SDK 已 init | 推荐 ✅ |
| 🥈 Send Schema | 无状态、纯命令、30-60 LOC | ✅ 完全成立，且有双重 fallback（am start → broadcast） | 推荐 ✅ |
| 🥉 Find Click View Chain | 不依赖 memAddr、60-100 LOC | ⚠ "不依赖 memAddr" 的前提是仅显示返回的 address 数组；如果要 "反查 className/idStr"，需要先 grab 一次拿到 mapping。文档 08 §5 第 3 点已说明 | 推荐 ✅，注解清晰 |

LOC 估算合理（grab 含 base64/gzip/二进制组装；schema 仅 fallback；click 含 grab 联动）。整体推荐顺序成立 ✅。

退选理由（EditView / FileOperate / 工具切换）也合理。

---

## 8. ❓ 9 处待核对项 · 澄清进展

> 来源：08 §9 汇总表

| # | 不确定点 | 澄清结果 | 应否去掉 ❓ |
|---|---------|---------|------------|
| 1 | `DeleteFileAction / UnInstallApkAction` 实际参数 | DeleteFileAction = `rm <path>`（无 -f）；UnInstallApkAction 内部错把 type 设成 `ACTION.INSTALL`（应是 `UNINSTALL`），且**全仓库 0 调用方**，属死代码 bug | ✅ 可去 ❓，但记一笔死代码 bug |
| 2 | `ACTION_OPERATE_CUSTOM_FILE` SDK 处理器位置 | **CodeLocatorCore 完全没有处理**：grep 整个 `CodeLocatorApp/CodeLocatorCore/` 0 命中。IDE 端 `EditFileContentDialog / FileOperateAction` 会发这个 action，但 SDK Receiver case 列表没它。靠业务方实现 `ICodeLocatorProcessor.processIntentAction` 才能响应 | ✅ 可去 ❓，加注 "业务方扩展点" |
| 3 | `EditType.GET_CLASS_INFO`（GCI）真实使用入口 | SDK 端有 `GetClassInfoAction.java`，作为 `ApplicationAction` 处理（type=P, value=InvokeInfo JSON），用于反射读取静态字段/调用静态方法。**IDE 端无任何调用**，属"SDK 准备好但 IDE 还没暴露入口" | ✅ 可去 ❓，澄清 "SDK 内已实现，IDE 待暴露" |
| 4 | `getMaxBroadcastTransferLength()` 默认值 | `CodeLocatorConfig.java:22` `DEFAULT_MAX_BROADCAST_TRANSFER_LENGTH = 240000`（240KB）。Builder 可覆盖 | ✅ 可去 ❓，写明 240000 |
| 5 | API 28-29 设备端写文件目录 | 见 MUST-1：API < 30 走 `<ExternalCacheDir>/codeLocator/<fileName>`；API ≥ 30 走 `/sdcard/codeLocator/<fileName>` | ✅ 可去 ❓ |
| 6 | `WApplication.b8`（file）是否每次 grab 自动有 | 源码里 `ApplicationResponse` 的 `WApplication.file` 仅在调 `ACTION_DEBUG_FILE_INFO` 时填充；`ACTION_DEBUG_LAYOUT_INFO` 单次抓取**不带** file 信息。后续保存 `.codeLocator` 时若 `mApplication.file == null`，文件字段在二进制内为 null（JSON 序列化时写为 null 或缺失） | 保留 ❓ → 可标注 "默认 null" 但需实测确认 |
| 7 | `CodeLocatorFileParser.parseAndExport` 是否做字段名替换 | 文档已说 "未做字段名替换"，是事实。Gson 默认按 `@SerializedName` 短名输出 | ✅ 可去 ❓ |
| 8 | `sCodeLocatorDir` 进入后台后 `deleteAllChildFile` 影响 | 需在真机实测确认；从代码看：`unRegisterReceiver` 是收尾，"被删的是 IDE 残留的旧文件，broadcast 时会重新创建" 的概率较高，但未实测 | 保留 ❓ |
| 9 | `BuildConfig.VERSION_NAME` 在 SDK 集成方编译产物中的值 | 取决于业务方 build.gradle 里的 versionName 覆盖。SDK 自带的 BuildConfig 在 release.aar 时被锁死。需业务方实测 | 保留 ❓ |

**澄清统计**：9 项中 **6 项已澄清可去 ❓**（#1/#2/#3/#4/#5/#7），3 项需要在真机/业务方环境实测才能彻底定（#6/#8/#9）。

---

## 9. 附加发现（researcher 文档没列、但值得记录的事实）

### A · `UnInstallApkAction` 内有源码 bug，但是死代码

```java
public UnInstallApkAction(String pkgName) {
    super(AdbCommand.ACTION.INSTALL, pkgName);  // ⚠ 应为 ACTION.UNINSTALL
}
```

`DeviceManager.executeCommandInternal` 用 `type == ACTION.UNINSTALL` 判断走 `uninstallApkFromDevice`，若类型错成 INSTALL，会走 `installApkToDevice` 把包名当 apk 路径，必然失败。但 grep 全仓库 0 调用方，属未来要用前必修的死代码。

### B · `ACTION_MOCK_TOUCH_VIEW` 端到端不通

详见 MUST-2。建议在 SDK `CodeLocator.registerReceiver` 加一行 `intentFilter.addAction(ACTION_MOCK_TOUCH_VIEW)`，或在 doc 08 V2.4 显式说明 "需先修 SDK"。

### C · `BroadcastAction` 自动注入 `KEY_ASYNC=true`

`BroadcastAction.buildCmd` (line 104-106) 在 `CodeLocatorUserConfig.isAsyncBroadcast()` 为 true 时，自动给 `mArgsList` 加 `KEY_ASYNC=true`。反向 skill 默认不能依赖 IDE 配置，所以 skill 自己发广播时**显式控制** `codeLocator_save_async` 字段比较稳妥（文档 03 已暗示，但可显式补一句）。

### D · `WApplication.activity` 短名 `b7`、`WApplication.file` 短名 `b8`、`WApplication.packageName` 短名 `bd`

doc 05 §4 抽样的短名映射已逐一验证（见 `CodeLocatorApp/CodeLocatorModel/.../WApplication.java:22-80`），全部对。

### E · `ScreenPanel.java:2040` EOF 自动切换 adb

doc 02 §2 说 "EOF 错误后自动切换 ddmlib/本地 adb"，实际代码 (`ScreenPanel.java:2039-2041`)：

```java
if ("eof".equalsIgnoreCase(throwable.getMessage())) {
    Log.e("EOF Error, is shell Model " + !...isUseDefaultAdb(), throwable);
    CodeLocatorUserConfig.loadConfig().setUseDefaultAdb(false);  // 切到 ddmlib（false=不用 default adb）
}
```

注意：`setUseDefaultAdb(false)` 是把"用默认 adb"关掉，即统一走 ddmlib。文档可加一行注解避免读者反向理解。

---

## 10. 总评

8 篇文档对源码理解扎实，结构清晰，命令样例可执行。**主要事实错误集中在 MUST-1（设备端落盘方向反）和 MUST-2（MOCK_TOUCH_VIEW 不可达）**——这两点直接影响反向 skill 的实现，建议优先修。其余多为微小偏移和优化项。

researcher 写得好的点：
- 03 §2.4 EditType 表完整覆盖 SDK 端全部子操作，行号也对
- 04 §3 mermaid 时序图把 "directGrabView 阶段 1-3" 切得很清楚，是反向脚本的重要参考
- 05 §2 二进制布局 ASCII 图很精确，对外接入端友好
- 08 §5 MVP Top 3 的退选理由（EditView / FileOperate）讲得有说服力

可继续投入：
- MUST-1 / MUST-2 修完后整套文档对反向 skill 来说几乎可以作为 1:1 协议规范使用
- ❓6/8/9 真机实测后即可彻底闭环
