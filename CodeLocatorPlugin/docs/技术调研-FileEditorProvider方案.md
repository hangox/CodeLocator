# 技术调研：FileEditorProvider 方案

## 1. 摘要

结论：**方案一可行，且首版应优先走“复用现有 `CodeLocatorWindow`/`RootPanel`/`MainPanel` 视图体系 + 新增 `FileType`/`AsyncFileEditorProvider`/`FileEditor` 外壳”的最小改造路线**。当前 `.codeLocator` 的文件解析入口已经完整存在于 `CodeLocatorInfo.fromCodeLocatorInfo()`，窗口模式下的只读快照展示链路也已经存在，因此首版不需要重写主 UI，只需要把“打开入口”从 `JDialog` 再补一条到 IDE Editor Tab。

我建议的实现策略：

1. 用 `com.intellij.fileType` 注册 `.codeLocator` 文件类型，**不要再引入 `FileTypeFactory`**。
2. 用 `com.intellij.fileEditorProvider` 注册一个 **`AsyncFileEditorProvider + DumbAware`** 实现。
3. `accept()` 先判扩展名，再用最小字节读取做 **magic header** 校验，避免误拦截普通二进制文件。
4. `createEditorAsync()` 在后台线程完整解析 `CodeLocatorInfo`，`build()` 阶段只在 EDT 中组装 UI。
5. `FileEditor` 内部直接包一层 `CodeLocatorWindow(project, isWindowMode = true, codelocatorInfo = parsedInfo)`，首版返回 `FileEditorState.INSTANCE`，**先不做树展开/选中态持久化**。
6. 现有工具窗口拖拽、历史记录、菜单“加载文件”入口先保留；但 `.codeLocator` 打开成功后，后续应逐步统一到 **`FileEditorManager.openFile()`**，减少“同一份快照在对话框和 Editor Tab 两套入口并存”的分裂。

首版最大的技术风险**不在 UI 复用本身**，而在当前代码里已有的**项目级/进程级共享状态**：

- `CodeLocatorWindow.codeLocatorMap`：`CodeLocatorWindow.kt:59-66, 669-678`
- `DataUtils.sCurrentProjectName / sCurrentApkName / sCurrentSDKVersion`：`utils/DataUtils.java:35-42, 72-103`
- `CodeLocatorUserConfig.sCodeLocatorConfig`：`model/CodeLocatorUserConfig.java:17, 456-487`
- `FileUtils.sProjectConfig`：`utils/FileUtils.java:194-218`
- `ScreenPanel` 的静态提示/点击计数：`panels/ScreenPanel.java:101-103, 832-883`

这意味着**多编辑器实例可以并存，但并不是真正完全隔离**；焦点切换时谁最后更新全局状态，谁就会“赢”。

---

## 2. 现有代码可复用清单（A）

### 2.1 原样复用

#### 2.1.1 `.codeLocator` 解析链路

1. **`CodeLocatorInfo` 直接复用**
   - 序列化格式定义在 `model/CodeLocatorInfo.java:19-23, 50-78`
   - 反序列化逻辑在 `model/CodeLocatorInfo.java:80-126`
   - `fromCodeLocatorInfo()` 已经完成：
     - magic tag 校验：`91-94`
     - 版本串读取：`96-102`
     - `WApplication` JSON 反序列化：`103-112`
     - PNG 截图恢复：`114-121`

2. **`WApplication.restoreAllStructInfo()` 与 `DataUtils.restoreAllStructInfo()` 直接复用**
   - `WApplication` 自身恢复 Activity / View / File / Extra 运行时结构：`CodeLocatorApp/CodeLocatorModel/.../WApplication.java:432-504`
   - 插件侧补充排序、跳转信息恢复、当前包名写入：`utils/DataUtils.java:105-133`

> 这部分已经是完整的“文件 → 运行时模型”管线，不需要重写。

#### 2.1.2 主展示 UI 绝大多数可直接复用

`CodeLocatorWindow` 在 `isWindowMode = true` 且传入 `codelocatorInfo` 时，会在初始化阶段直接把快照喂给 `ScreenPanel`：

- `panels/CodeLocatorWindow.kt:225-239`
- `panels/ScreenPanel.java:1788-1799`

这条链路已经证明：**当前对话框模式展示的快照，本质上就是一个“可嵌入的离线快照查看器”**。

可直接复用的核心视图如下：

- `RootPanel`：容器与默认空态绘制，`panels/RootPanel.kt:20-24, 41-65, 67-100`
- `MainPanel`：左右/上下布局、自适应横竖屏、事件桥接，`panels/MainPanel.kt:28-35, 64-152, 159-259, 263-274`
- `ScreenPanel`：截图渲染、点击选中、过滤、高亮、文件树刷新、快照接收，`panels/ScreenPanel.java:48-159, 781-804, 1788-1932`
- `TabContainerPanel`：View/Activity/File/AppInfo + Extra tabs 组装，`panels/TabContainerPanel.kt:17-57, 81-110, 117-127, 162-279`
- `ViewTreePanel`：视图树 + 搜索 + 键盘导航，`panels/ViewTreePanel.kt:23-48, 73-115, 165-315`
- `ActivityTreePanel`：Activity/Fragment 树，`panels/ActivityTreePanel.kt:23-69, 125-214`
- `FileTreePanel`：文件树 + 搜索 + 排序 + 右键操作，`panels/FileTreePanel.kt:29-68, 69-202`
- `AppInfoTablePanel`：`panels/AppInfoTablePanel.kt:17-29, 88-117`
- `ViewInfoTablePanel`：`panels/ViewInfoTablePanel.kt:34-82, 164-260, 284-300`
- `FragmentInfoTablePanel`：`panels/FragmentInfoTablePanel.kt:26-40, 88-152`
- `FileInfoTablePanel`：`panels/FileInfoTablePanel.kt:19-38, 145-157`
- `ExtraSplitPane` / `ExtraTreePanel` / `ExtraInfoTablePanel`：`panels/ExtraSplitPane.java:13-60`，`panels/ExtraTreePanel.kt:30-51, 121-122, 181-188, 239-274`，`panels/ExtraInfoTablePanel.kt:20-34, 98-170`

这些类的共同特点是：**状态主要挂在实例字段上，而不是静态字段上**。`MainPanel`/`RootPanel` 本身没有发现类似 `sCodeLocatorInfo` 的静态单例状态。

#### 2.1.3 保存能力可直接复用

`SaveWindowAction` 直接把当前 `currentApplication + screenCapImage` 重新打包为 `.codeLocator`：

- `action/SaveWindowAction.kt:59-78`

这意味着 File Editor 打开离线快照后，若仍保留该 toolbar action，理论上可以继续“另存为”新的 `.codeLocator` 文件，不需要新增保存格式。

---

### 2.2 轻量改造

#### 2.2.1 `CodeLocatorWindow`：建议继续复用，但应引入更明确的“编辑器模式”语义

当前 `CodeLocatorWindow` 已经区分：

- 工具窗口模式：`isWindowMode = false`
- 对话框快照模式：`isWindowMode = true`

相关行为：

- 工具窗口模式才会启用更新检查与拖拽：`panels/CodeLocatorWindow.kt:232-235`
- `isWindowMode = true` 时会直接加载 `codelocatorInfo`：`236-239`
- 某些 toolbar action 仅在工具窗口模式下添加：`461-477, 512-545, 550-575`
- 但 `SaveWindowAction`、`TraceShowAction`、`CopyImageAction`、`ReportJumpWrongAction` 仍然会出现在窗口模式下：`517-521, 547-556`

这已经足够支持首版 Editor 复用。

建议的轻量改造点：

1. 新增 `viewerMode: TOOL_WINDOW / DIALOG / FILE_EDITOR`，不要继续用 `isWindowMode` 同时表达“非工具窗口的一切”。
2. 在 `FILE_EDITOR` 模式下，明确关闭或弱化：
   - 对话框联动列表：`dialogCodeLocatorWindowList` / `mainCodeLocatorWindow`，`189-191`
   - 仅对话框才有意义的展示埋点区分
   - 一些明显偏“临时弹窗”语义的 action
3. 让 `CodeLocatorWindow` 提供一个更语义化的工厂方法，例如 `createSnapshotViewer(project, info, ViewerMode.FILE_EDITOR)`，降低后续多入口分叉成本。

#### 2.2.2 `CodeLocatorDropTargetAdapter`：建议保留，但 `.codeLocator` 分支改为“打开文件到 Editor”

当前拖拽入口同时处理三类文件：

- `.apk`：安装 APK，`tools/CodeLocatorDropTargetAdapter.kt:33-37`
- `dependencies*`：导入源码依赖，`37-43`
- 其它小文件：尝试按 `.codeLocator` 解析并弹对话框，`44-58`

这里不建议移除拖拽，因为它不只是 `.codeLocator` 打开入口。

但建议把 `.codeLocator` 分支从：

- `CodeLocatorWindow.showCodeLocatorDialog(...)`：`57`

改成：

- `LocalFileSystem.findFileByIoFile(file)` + `FileEditorManager.openFile(vFile, true)`

这样拖进工具窗口时，IDE 行为会与“双击文件”“Project 视图打开”“历史记录打开”统一。

额外注意：当前拖拽限制是 **10MB**：`44`

#### 2.2.3 `LoadWindowAction`：建议保留，但后续改为打开 VirtualFile

当前逻辑：

- 直接弹文件选择器：`action/LoadWindowAction.kt:39-41`
- 大于 **20MB** 拒绝：`52-59`
- 解析成功后直接弹对话框：`61-75`

建议后续调整为：

- 文件选择器仍可保留；
- 解析前先定位 `VirtualFile`；
- 成功后调用 `FileEditorManager.openFile()`。

这样可以统一所有离线快照入口。

额外注意：这里的大小限制是 **20MB**，与拖拽入口的 **10MB** 不一致：

- `LoadWindowAction.kt:52`
- `CodeLocatorDropTargetAdapter.kt:44`

建议抽统一常量，例如 `MAX_CODELOCATOR_FILE_SIZE_BYTES`。

#### 2.2.4 `ShowGrabHistoryAction` / `ShowHistoryDialog`：建议保留，但点击历史项也应逐步切到 Editor 打开

当前历史列表逻辑：

- 扫描历史目录下所有 `.codeLocator`：`action/ShowGrabHistoryAction.kt:27-33`
- 历史项点击后解析字节并弹对话框：`dialog/ShowHistoryDialog.kt:181-194`

保留理由：

- 历史记录功能本身与 File Editor 不冲突；
- 只是“打开结果”的载体应逐渐统一。

建议改法同上：历史项点击后改成 `openFile(vFile, true)`。

#### 2.2.5 `CodeLocatorFileParser`：不建议直接复用到 Editor 打开链路

`CodeLocatorFileParser` 的目标是“解析并导出 JSON + PNG”，不是“在 IDE 中展示”：

- 读取文件后调用 `CodeLocatorInfo.fromCodeLocatorInfo()`：`utils/CodeLocatorFileParser.java:33-41`
- 然后写出 JSON / PNG 到磁盘：`43-64, 74-103`

这意味着它带有明显的磁盘副作用，不适合作为 File Editor 打开流程的核心实现。

建议：

- **只复用它依赖的 `CodeLocatorInfo.fromCodeLocatorInfo()`**；
- 不在 File Editor 中直接调用 `parseAndExport()`。

---

### 2.3 必须新写

1. **`CodeLocatorFileType`**
   - 提供扩展名、图标、二进制属性。
2. **`CodeLocatorFileEditorProvider`**
   - `accept()`：扩展名 + magic header
   - `createEditorAsync()`：后台读取与解析
   - `getPolicy()`：建议 `HIDE_DEFAULT_EDITOR`
3. **`CodeLocatorFileEditor`**
   - `FileEditor` 包装层
   - 内部持有一个独立的 `CodeLocatorWindow`
4. **可选：`CodeLocatorFileSniffer` / `CodeLocatorFileLoader`**
   - 不是必须单独建类，但建议抽成私有 helper，把“最小 header 校验”和“完整解析”分开。
5. **可选：`FileIconProvider`**
   - 首版不是必需；`FileType.getIcon()` 已足够支撑 Project 视图和 editor tab 图标。

---

## 3. IntelliJ Platform API 选型（B）

### 3.1 `FileType` 注册方式

推荐：**`plugin.xml` 中注册 `com.intellij.fileType` 扩展点**。

原因：

1. JetBrains 官方文档已把 `com.intellij.fileType` 作为标准方式：
   - <https://plugins.jetbrains.com/docs/intellij/registering-file-type.html>
2. 扩展点列表里 `com.intellij.fileTypeFactory` 已标记为 **Deprecated / Non-Dynamic**，而 `com.intellij.fileType` 是当前主路径：
   - <https://plugins.jetbrains.com/docs/intellij/intellij-platform-extension-point-list.html>
3. Marketplace 推荐提取器同时支持两种方式，但 `com.intellij.fileType` 明确写了 **available in 2019.2+**：
   - <https://plugins.jetbrains.com/docs/marketplace/intellij-plugin-recommendations.html>

结合本项目目标范围：

- `build.gradle` 里实际构建范围是 `sinceBuild = "232"`、`untilBuild = "263.*"`：`build.gradle:24-27, 65-75`
- 因此**没有任何兼容性理由继续使用 `FileTypeFactory`**。

### 3.2 `FileType` 建议实现形态

`.codeLocator` 是**自定义二进制快照文件**，并不是一种需要 PSI / ParserDefinition / Syntax Highlighting 的语言文件。

因此建议：

- 实现普通 `FileType`（或 `UserBinaryFileType` 风格的二进制类型）
- `isBinary()` 返回 `true`
- 图标直接由 `getIcon()` 提供

不建议首版引入：

- `LanguageFileType`
- `ParserDefinition`
- `FileViewProviderFactory`

因为当前需求只是**自定义 Viewer**，不是源码语言支持。

### 3.3 `FileEditorProvider` 实现要点

#### 3.3.1 `accept(Project, VirtualFile)`

推荐逻辑：

1. 先判文件扩展名是否为 `.codeLocator`
2. 再做最小 header 校验：
   - 前 4 字节读取 tag 长度（`int`）
   - 再读 tag 字符串
   - 必须等于 `CodeLocator`

理由：

- 当前真实格式约束来自 `CodeLocatorInfo.fromCodeLocatorInfo()`：`model/CodeLocatorInfo.java:84-94`
- 只靠扩展名会误判重命名文件；
- 只靠完整解析会把 `accept()` 做得过重。

建议**不要在 `accept()` 中完整反序列化 JSON / PNG**，避免文件切换、索引扫描、预览判定时频繁做重活。

#### 3.3.2 `createEditor()` / `createEditorAsync()` 返回什么

推荐返回：**一个自定义 `FileEditor`，其 `getComponent()` 直接返回复用的 `CodeLocatorWindow` 组件**。

推荐结构：

- `CodeLocatorFileEditorProvider` 负责解析文件
- `CodeLocatorFileEditor` 负责生命周期与 `FileEditor` 协议
- `CodeLocatorFileEditor` 内部持有 `CodeLocatorWindow(project, isWindowMode = true, codelocatorInfo = info)`

这样做的好处：

1. 最大化复用现有 UI。
2. 不需要再单独拼 toolbar / content / selection sync。
3. 与现有对话框快照模式行为基本一致，调试成本低。

#### 3.3.3 `getEditorTypeId()` 命名规范

建议使用**稳定、全局唯一、插件 ID 风格的字符串**，例如：

- `com.bytedance.tools.codelocator.snapshotEditor`

理由：

- 该值会参与 editor 选中态/历史恢复；
- 不宜使用随实现变化的短名，例如 `CodeLocatorEditor`。

#### 3.3.4 与 `TextEditor` 的并存策略

推荐：**`FileEditorPolicy.HIDE_DEFAULT_EDITOR`**。

理由：

1. `.codeLocator` 是二进制快照，普通文本页签基本没有阅读价值。
2. 当前产品目标是“像图片/PDF 一样打开专用 viewer”，不是“文本 + 预览双页签”。
3. 若保留默认文本编辑器，会带来：
   - 额外的 editor tab 噪音
   - 用户误以为文件可以直接编辑
   - provider 顺序、tab 标题、一致性等额外问题

`PLACE_AFTER_DEFAULT_EDITOR` / `PLACE_BEFORE_DEFAULT_EDITOR` 仅适合以下场景：

- 需要同时保留原始文本页签进行调试；
- 文件本身是“文本为主，预览为辅”的格式（例如 Markdown、资源文件等）。

本方案不属于这一类。

#### 3.3.5 是否实现 `DumbAware`

推荐：**实现 `DumbAware`**。

依据：

- `com.intellij.fileEditorProvider` 在官方扩展点列表中被标注为 **DumbAware** 扩展点：
  - <https://plugins.jetbrains.com/docs/intellij/intellij-platform-extension-point-list.html>
- `.codeLocator` 打开流程本身不依赖索引；
- 即使内部某些跳转 action 依赖源码索引，也不应阻塞整个 viewer 打开。

因此推荐策略是：

- **Provider 层 DumbAware**，允许索引期打开文件；
- 具体依赖索引的 action 继续由自身 `update()` / 执行时失败提示兜底。

### 3.4 `FileEditorState` 是否要持久化

结论：**首版不建议做视图树展开/选中节点持久化**。

原因：

1. 当前 UI 没有现成的“稳定可序列化路径模型”。
2. 选中状态至少涉及：
   - 当前 tab
   - `ViewTreePanel` 选中节点
   - `ActivityTreePanel` 当前 Fragment
   - `FileTreePanel` 展开与排序状态
   - 各 `ExtraTreePanel` 的定位状态
3. 这些状态目前都散落在组件实例字段中，例如：
   - `ViewTreePanel.currentViewList/currentViewStack/currentSelectViewIndex`：`panels/ViewTreePanel.kt:39-45`
   - `ActivityTreePanel.mLastSelectFragment`：`panels/ActivityTreePanel.kt:31-35, 125-140`
   - `FileTreePanel.currentFileList/currentFileStack/currentSelectFileIndex/mSortFileByName`：`panels/FileTreePanel.kt:45-63`

而 `FileEditor` 协议只要求能够返回一个 `FileEditorState`，并不强制必须保存复杂 UI 状态：

- `FileEditor.getState()/setState()`：`turn17search0` 官方源码摘要
- `FileEditorState` 文档说明其用于重启后恢复 editor state：`turn8search1`

首版建议：

- 直接返回 `FileEditorState.INSTANCE`
- `setState()` 空实现

如果后续确实要补，建议**只持久化最小状态**：

- 当前 tab index
- 当前选中 View 的 `memAddr`

树展开状态建议放二期，不要首版就做。

### 3.5 大文件 / 慢解析：`AsyncFileEditorProvider` vs 手动 `SwingWorker`

推荐：**首版优先 `AsyncFileEditorProvider`**。

依据：

- 官方接口定义就是“后台做耗时准备，EDT 只 build UI”：
  - `AsyncFileEditorProvider.createEditorAsync()`：`turn6view0:26-35`
- 当前 `.codeLocator` 打开成本主要是：
  - 整文件字节读取
  - `WApplication` JSON 反序列化
  - PNG 解码
- 这些都是“打开前一次性准备数据”的典型后台任务。

为什么**不建议首版手写 `SwingWorker`**：

1. 会把线程切换、取消、异常展示、重复打开去重都散落到业务代码里。
2. 现有 UI 只有在 `CodeLocatorInfo` 准备好后才有真正意义，先显示半成品价值不大。
3. `AsyncFileEditorProvider` 已经和 FileEditorManager 的打开流程天然对齐。

若后续实测仍觉得打开感知偏慢，可二期再在 `FileEditor` 内部补：

- `LoadingDecorator` 占位
- 图片懒加载 / 部分信息延迟刷新

官方 UI FAQ 也明确给出了 `LoadingDecorator` 作为 loading placeholder：

- <https://plugins.jetbrains.com/docs/intellij/ui-faq.html>

### 3.6 与现有 `CodeLocatorWindow` 工具窗口的关系

推荐：**Editor 实例与工具窗口实例完全独立，不共享 `RootPanel` / `MainPanel` / `ScreenPanel` 实例**。

理由：

1. Swing 组件本身不能同时挂到多个父容器。
2. 当前 `CodeLocatorWindow` 已经假设“一个 viewer 对应一整套组件树”：
   - `rootPanel`：`CodeLocatorWindow.kt:197`
   - `RootPanel.mainPanel`：`RootPanel.kt:22`
3. 对话框模式已有现成“每开一个快照就新建一个 `CodeLocatorWindow`”的实践：
   - `CodeLocatorWindow.showCodeLocatorDialog()`：`CodeLocatorWindow.kt:66-131`

可复用的应该是**类与初始化逻辑**，不是**组件实例**。

### 3.7 `plugin.xml` 需要注册的扩展点

首版必须：

1. `com.intellij.fileType`
2. `com.intellij.fileEditorProvider`

可选：

3. `com.intellij.fileIconProvider`
   - 仅当 `FileType.getIcon()` 不足以覆盖需要的图标表现时使用。
   - 官方 UI FAQ 对应说明：<https://plugins.jetbrains.com/docs/intellij/ui-faq.html>

本方案**不需要**：

- `com.intellij.fileType.fileViewProviderFactory`
- `ParserDefinition`
- `Language` / `LanguageFileType`

### 3.8 since-build 232 / until-build 263 兼容性影响

结论：**该方案对 232~263 范围总体友好，没有明显 API 阻断点**。

原因：

1. `com.intellij.fileType` 在 2019.2+ 就可用：`turn16search1`
2. `AsyncFileEditorProvider`、`FileEditorProvider` 都是老牌稳定 API：`turn6view0`, `turn17search0`
3. 本项目已经用 IntelliJ Platform Gradle Plugin 2.x，Java/Kotlin 目标 17：`build.gradle:5-21`
4. JetBrains 官方兼容性说明中，2022.3+ 使用 Java 17，2024.2+ 平台转向 Java 21，但**插件字节码保持 Java 17 并不构成使用这些 API 的障碍**：
   - <https://plugins.jetbrains.com/docs/intellij/api-changes-list-2026.html>

需要注意的只有两点：

1. `plugin.xml` 中仍写着旧的 `since-build="191.0"`：`src/main/resources/META-INF/plugin.xml:3`
2. 但 `build.gradle` 的 `intellijPlatform.pluginConfiguration.ideaVersion` 已声明 `232~263.*`：`build.gradle:24-27, 69-72`

这里应以 **Gradle 构建期 patch 后的产物** 为准。调研结论是：**新增 FileEditorProvider 方案本身不需要额外修改兼容区间**。

---

## 4. 文件关联机制（C）

### 4.1 IDE 内部关联

只要插件正确注册 `com.intellij.fileType` 并声明 `extensions="codeLocator"`，IDE 内部就会把 `.codeLocator` 自动识别为该文件类型。

官方依据：

- <https://plugins.jetbrains.com/docs/intellij/registering-file-type.html>
- <https://www.jetbrains.com/help/idea/creating-and-registering-file-types.html>

这意味着：

- Project 视图双击
- Recent Files 打开
- 在 IDE 中从磁盘打开
- IDE 启动时恢复上次会话中的 `.codeLocator`

都会走同一条 FileEditorProvider 流程。

### 4.2 macOS / Windows / Linux 系统级双击的工作机制

系统级双击与插件本身不是同一层面的事情：

1. **操作系统先决定“哪个应用”打开 `.codeLocator`**
2. **IDE 再根据已安装插件里的 `FileType + FileEditorProvider` 决定“用哪个编辑器页签”打开**

也就是说：

- **插件负责 IDE 内部识别与展示**
- **OS 默认应用负责 Finder / Explorer / 文件管理器层面的“把文件交给 IDE”**

### 4.3 macOS

JetBrains 官方用户文档支持在 IDE 内部把某些扩展关联到 IntelliJ IDEA：

- Settings / Editor / File Types / `Associate File Types with IntelliJ IDEA`
- 且官方特别说明：**macOS 需要重启电脑后生效**
  - <https://www.jetbrains.com/help/idea/creating-and-registering-file-types.html>

机制上可理解为：

- IDE/系统把 `.codeLocator` 注册到 Launch Services
- Finder 双击后把文件 open-event 发送给 IDE
- IDE 收到文件后创建 `VirtualFile`，然后走 `FileEditorProvider`

### 4.4 Windows

机制上对应的是 Windows 文件关联 / 注册表：

- 扩展名 `.codeLocator` → ProgID
- ProgID → 打开命令（某个 IntelliJ IDEA / Android Studio 可执行文件）

用户既可以：

- 在系统“默认应用”里设置
- 也可能通过 IDE 的文件关联能力写入关联

最终效果都是：Explorer 双击把文件路径交给 IDE，IDE 内部再走 FileEditorProvider。

### 4.5 Linux

Linux 一般依赖：

- MIME 类型映射
- `.desktop` 启动项
- 桌面环境的 `mimeapps.list`

本质仍然是：

- 文件管理器决定交给哪个 IDE 进程
- IDE 内部再按 `FileType + FileEditorProvider` 打开

### 4.6 `OSFileIdeAssociation`

JetBrains 官方从 2020.3 起提供了 `OSFileIdeAssociation`，用于“控制文件类型与 IDE 在操作系统层面的关联能力”：

- <https://plugins.jetbrains.com/docs/intellij/registering-file-type.html>
- <https://plugins.jetbrains.com/docs/intellij/api-notable-list-2020.html>

建议判断：

- **首版不是必须项**。
- 只要用户已经把 IDEA/AS 设为 `.codeLocator` 默认应用，系统级双击就能工作。
- 如果后续想把“安装插件后更容易在 OS 层设置默认打开方式”做得更顺滑，再单独调研 `OSFileIdeAssociation`。

> TBD：Android Studio 2025.1.1.14 的品牌化发行包在 macOS / Windows / Linux 三端对 `OSFileIdeAssociation` 的最终用户体验是否完全一致，建议后续真机验证一次。

---

## 5. 风险与边界（D）

### 5.1 现有 drag-drop 路径要不要保留

建议：**保留，但仅把 `.codeLocator` 分支改造成“打开到 Editor”**。

理由：

1. 它还承担 APK 安装和 dependencies 导入，不只是快照打开：`tools/CodeLocatorDropTargetAdapter.kt:33-43`
2. 用户把快照拖进工具窗口是符合直觉的；
3. 真正该统一的是“打开结果载体”，不是拖拽能力本身。

### 5.2 多个 `.codeLocator` 同时打开时的状态冲突

#### 5.2.1 `MainPanel` / `RootPanel` 本身没有发现致命静态单例

- `MainPanel` 的状态主要是实例字段：`screenPanel`, `tabContainerPanel`, `fromOutSide`，`panels/MainPanel.kt:28-35`
- `RootPanel` 也是实例字段：`mainPanel`, `powerImage`, `powerStr`, `adLabel`，`panels/RootPanel.kt:22-30`

所以**不是这两层在阻止多实例**。

#### 5.2.2 真正的冲突点在全局共享状态

1. **`CodeLocatorWindow.codeLocatorMap` 是按 Project 维度存当前应用**
   - `CodeLocatorWindow.kt:63-64, 676`
   - 同一项目开多个快照时，后更新者覆盖前更新者。

2. **`DataUtils` 记录的是进程级“当前项目/当前 APK/当前 SDK”**
   - `utils/DataUtils.java:37-42, 72-103`
   - `CodeLocatorWindow` 在 mouse enter / activity 更新时都会回写：
     - `CodeLocatorWindow.kt:240-246`
     - `CodeLocatorWindow.kt:669-678`

3. **`CodeLocatorUserConfig` / `FileUtils.getConfig()` 都是全局单例配置**
   - `CodeLocatorUserConfig.java:17, 456-487`
   - `FileUtils.java:194-218`

4. **`ScreenPanel` 有进程级静态交互状态**
   - 双击/连击统计：`ScreenPanel.java:101-103`
   - 提示节流：`832-883`

结论：

- **多个快照同时显示是可行的**；
- **但不能宣称“完全实例隔离”**；
- 焦点切换、埋点、当前 APK 上下文等仍然共享。

### 5.3 同一文件被工具窗口和 FileEditor 同时打开时的一致性

建议：**不要自动同步**。

原因：

1. 工具窗口代表“当前设备实时抓取态”，文件编辑器代表“磁盘上的离线快照”。
2. 二者的数据语义不同，同步会制造错误预期。
3. 现有 `CodeLocatorWindow` 的联动机制本来就是针对“主窗口 + 关联对话框”设计的：
   - `dialogCodeLocatorWindowList / mainCodeLocatorWindow`：`CodeLocatorWindow.kt:189-191`
   - tab / fragment / click view 的跨窗口广播：`310-349, 653-667`

如果把 File Editor 也硬塞进这套联动，容易造成：

- 选中状态被互相覆盖
- diff 模式被误触发
- 用户误解离线快照会跟着当前设备变化

建议边界：

- File Editor 默认完全独立；
- 只有将来明确做“Compare current device with snapshot”时，再使用 `isDiffMode` 思路。

### 5.4 `Mob.java`、设置项等副作用

#### 5.4.1 埋点副作用

`CodeLocatorWindow` 初始化时会调用：

- `Mob.logShow(isWindowMode)`：`CodeLocatorWindow.kt:230`
- `Mob.logShow()` 的真实网络行为在 `utils/Mob.java:320-343`

大量树选择、tab 切换、右键、历史点击等操作也都会打点：

- `Mob.mob(...)`：`utils/Mob.java:260-288`
- 各 UI 调用遍布 `ViewTreePanel`、`ActivityTreePanel`、`FileTreePanel`、`ShowHistoryDialog` 等

这意味着：

- 若直接复用 `CodeLocatorWindow` 作为 File Editor，**打开离线快照也会产生一次 show 埋点**；
- 若产品不希望把“文件编辑器打开快照”统计为“窗口弹出”，需要加 mode 细分。

#### 5.4.2 本地文件副作用

即使是离线快照模式，`ScreenPanel.notifyGetCodeLocatorInfo()` 仍会：

- `FileUtils.saveScreenCap(mScreenCapImage)`：`ScreenPanel.java:1798`

也就是每次打开 `.codeLocator`，都会覆盖一次插件私有目录中的 `screenCap.png`。

这不会污染仓库，但属于**真实副作用**，需要在设计上知晓。

#### 5.4.3 历史记录副作用

实时抓取成功时，`ScreenPanel.onGetApplicationInfoSuccess()` 会自动写历史：`ScreenPanel.java:826-828`

但该逻辑只在：

- `!mCodeLocatorWindow.isWindowMode()`

时生效，所以 File Editor 复用 `isWindowMode = true` 路线时，**不会把打开本地文件再次写入抓取历史**。这一点是利好。

---

## 6. 推荐 API 选型 + 代码骨架（E）

### 6.1 推荐选型

- 文件类型：`CodeLocatorFileType`
- 打开入口：`CodeLocatorFileEditorProvider : AsyncFileEditorProvider, DumbAware`
- 编辑器实现：`CodeLocatorFileEditor : FileEditor`
- 展示组件：直接复用 `CodeLocatorWindow(project, isWindowMode = true, codelocatorInfo = info)`
- 默认策略：`FileEditorPolicy.HIDE_DEFAULT_EDITOR`
- 状态持久化：v1 不做，返回 `FileEditorState.INSTANCE`
- 图标：先只用 `FileType.getIcon()`，不额外上 `FileIconProvider`

### 6.2 Kotlin 骨架：`CodeLocatorFileType`

```kotlin
package com.bytedance.tools.codelocator.fileeditor

import com.intellij.openapi.fileTypes.FileType
import javax.swing.Icon

/**
 * FileType 是 plugin.xml 扩展里的少数例外，允许使用 Kotlin object。
 * 这里保持实现最轻，避免额外 companion object。
 */
object CodeLocatorFileType : FileType {
    override fun getName(): String = "CodeLocator Snapshot"

    override fun getDescription(): String = "CodeLocator 抓取快照文件"

    override fun getDefaultExtension(): String = "codeLocator"

    override fun getIcon(): Icon? = CodeLocatorIcons.FILE

    override fun isBinary(): Boolean = true

    override fun isReadOnly(): Boolean = true

    override fun getCharset(file: com.intellij.openapi.vfs.VirtualFile, content: ByteArray): String? = null
}
```

### 6.3 Kotlin 骨架：`CodeLocatorFileEditorProvider`

```kotlin
package com.bytedance.tools.codelocator.fileeditor

import com.bytedance.tools.codelocator.model.CodeLocatorInfo
import com.intellij.openapi.fileEditor.AsyncFileEditorProvider
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import java.io.DataInputStream

class CodeLocatorFileEditorProvider : AsyncFileEditorProvider, DumbAware {

    override fun accept(project: Project, file: VirtualFile): Boolean {
        if (file.extension != CodeLocatorFileType.defaultExtension) return false
        return runCatching { hasValidHeader(file) }.getOrDefault(false)
    }

    override fun createEditorAsync(project: Project, file: VirtualFile): AsyncFileEditorProvider.Builder {
        val info = parseFile(file)
        return object : AsyncFileEditorProvider.Builder() {
            override fun build(): FileEditor = CodeLocatorFileEditor(project, file, info)
        }
    }

    override fun createEditor(project: Project, file: VirtualFile): FileEditor {
        // 按理说平台优先走 createEditorAsync()；这里保留同步兜底。
        return CodeLocatorFileEditor(project, file, parseFile(file))
    }

    override fun getEditorTypeId(): String = "com.bytedance.tools.codelocator.snapshotEditor"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR

    private fun hasValidHeader(file: VirtualFile): Boolean {
        DataInputStream(file.inputStream.buffered()).use { input ->
            val tagLength = input.readInt()
            if (tagLength <= 0 || tagLength > 64) return false
            val tagBytes = ByteArray(tagLength)
            input.readFully(tagBytes)
            return String(tagBytes, Charsets.UTF_8) == "CodeLocator"
        }
    }

    private fun parseFile(file: VirtualFile): CodeLocatorInfo {
        val bytes = file.contentsToByteArray()
        return requireNotNull(CodeLocatorInfo.fromCodeLocatorInfo(bytes)) {
            "Invalid .codeLocator file: ${file.path}"
        }
    }
}
```

### 6.4 Kotlin 骨架：`CodeLocatorFileEditor`

```kotlin
package com.bytedance.tools.codelocator.fileeditor

import com.bytedance.tools.codelocator.model.CodeLocatorInfo
import com.bytedance.tools.codelocator.panels.CodeLocatorWindow
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorLocation
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.fileEditor.FileEditorStateLevel
import com.intellij.openapi.fileEditor.impl.text.TextEditorState
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ide.structureView.StructureViewBuilder
import java.beans.PropertyChangeListener
import javax.swing.JComponent

class CodeLocatorFileEditor(
    private val project: Project,
    private val file: VirtualFile,
    info: CodeLocatorInfo,
) : UserDataHolderBase(), FileEditor {

    /**
     * 每个打开文件实例都创建自己的 viewer，避免 Swing 组件与状态共享。
     */
    private val viewer = CodeLocatorWindow(
        project = project,
        isWindowMode = true,
        codelocatorInfo = info,
        isDiffMode = false,
    )

    override fun getComponent(): JComponent = viewer

    override fun getPreferredFocusedComponent(): JComponent? = viewer

    override fun getName(): String = "CodeLocator"

    override fun getState(level: FileEditorStateLevel): FileEditorState = FileEditorState.INSTANCE

    override fun setState(state: FileEditorState) {
        // v1 不做 UI 状态恢复。
    }

    override fun isModified(): Boolean = false

    override fun isValid(): Boolean = file.isValid

    override fun selectNotify() = Unit

    override fun deselectNotify() = Unit

    override fun addPropertyChangeListener(listener: PropertyChangeListener) = Unit

    override fun removePropertyChangeListener(listener: PropertyChangeListener) = Unit

    override fun getCurrentLocation(): FileEditorLocation? = null

    override fun getStructureViewBuilder(): StructureViewBuilder? = null

    override fun dispose() {
        viewer.disposable?.dispose()
    }
}
```

> 说明：上面 `dispose()` 只体现思路，真实实现时应进一步检查 `CodeLocatorWindow` 内部是否还需要显式释放其它资源。

### 6.5 `plugin.xml` 片段

```xml
<extensions defaultExtensionNs="com.intellij">
    <fileType
            name="CodeLocator Snapshot"
            implementationClass="com.bytedance.tools.codelocator.fileeditor.CodeLocatorFileType"
            fieldName="INSTANCE"
            extensions="codeLocator"/>

    <fileEditorProvider
            implementation="com.bytedance.tools.codelocator.fileeditor.CodeLocatorFileEditorProvider"/>

    <!-- 可选：若后续需要按文件动态覆盖图标，再补这个 -->
    <!--
    <fileIconProvider
            implementation="com.bytedance.tools.codelocator.fileeditor.CodeLocatorFileIconProvider"/>
    -->
</extensions>
```

实现细节说明：

- `fileType` 采用官方推荐的 `com.intellij.fileType`。
- `fileEditorProvider` 直接挂在 `com.intellij` namespace 下。
- 首版不建议额外引入 `iconProvider`，因为 `FileType.getIcon()` 已足够。

---

## 7. 附录（参考链接、JetBrains 平台文档引用）

### 7.1 JetBrains 官方文档

1. Registering a File Type  
   <https://plugins.jetbrains.com/docs/intellij/registering-file-type.html>

2. Language and File Type（`com.intellij.fileType` 示例）  
   <https://plugins.jetbrains.com/docs/intellij/language-and-filetype.html>

3. Plugin Extensions（扩展实现应尽量无状态、避免重初始化）  
   <https://plugins.jetbrains.com/docs/intellij/plugin-extensions.html>

4. Configuring Kotlin Support（`FileType` 是 Kotlin `object` 的例外）  
   <https://plugins.jetbrains.com/docs/intellij/using-kotlin.html>

5. IntelliJ Platform Extension Point and Listener List  
   <https://plugins.jetbrains.com/docs/intellij/intellij-platform-extension-point-list.html>

6. User Interface FAQ（`LoadingDecorator`、`FileIconProvider`）  
   <https://plugins.jetbrains.com/docs/intellij/ui-faq.html>

7. File type associations（IDE 用户侧文件关联与“设为默认应用”）  
   <https://www.jetbrains.com/help/idea/creating-and-registering-file-types.html>

8. Notable Changes in IntelliJ Platform API 2020.*（`OSFileIdeAssociation`）  
   <https://plugins.jetbrains.com/docs/intellij/api-notable-list-2020.html>

9. Incompatible Changes in IntelliJ Platform API 2026.*（Java / Gradle 兼容边界）  
   <https://plugins.jetbrains.com/docs/intellij/api-changes-list-2026.html>

### 7.2 平台源码 / 官方镜像（用于确认接口语义）

1. `AsyncFileEditorProvider` 官方镜像  
   <https://android.googlesource.com/platform/tools/idea/+/9ea67227e8fdcf8ed37e65bb96e32767291d0f4f/platform/platform-api/src/com/intellij/openapi/fileEditor/AsyncFileEditorProvider.java>

2. `FileEditor` 官方镜像（含 `getState()` / `setState()` 协议）  
   <https://android.googlesource.com/platform/tools/idea/+/9b5d02ac8c92b1e71523cc15cb3d168d57fbd898/platform/editor-ui-api/src/com/intellij/openapi/fileEditor/FileEditor.java>

3. `FileEditorState` 官方镜像  
   <https://android.googlesource.com/platform/tools/idea/+/0ecdb5090b29e51adc5322347bafda41760653ea/platform/platform-api/src/com/intellij/openapi/fileEditor/FileEditorState.java>

### 7.3 本仓库关键代码索引

- `src/main/java/com/bytedance/tools/codelocator/model/CodeLocatorInfo.java`
- `src/main/java/com/bytedance/tools/codelocator/utils/CodeLocatorFileParser.java`
- `src/main/java/com/bytedance/tools/codelocator/panels/CodeLocatorWindow.kt`
- `src/main/java/com/bytedance/tools/codelocator/panels/MainPanel.kt`
- `src/main/java/com/bytedance/tools/codelocator/panels/RootPanel.kt`
- `src/main/java/com/bytedance/tools/codelocator/panels/ScreenPanel.java`
- `src/main/java/com/bytedance/tools/codelocator/tools/CodeLocatorDropTargetAdapter.kt`
- `src/main/java/com/bytedance/tools/codelocator/action/LoadWindowAction.kt`
- `src/main/java/com/bytedance/tools/codelocator/action/SaveWindowAction.kt`
- `src/main/java/com/bytedance/tools/codelocator/action/ShowGrabHistoryAction.kt`
- `src/main/resources/META-INF/plugin.xml`
- `build.gradle`

### 7.4 仍建议后续真机验证的点（TBD）

1. Android Studio 2025.1.1.14 下 `Associate File Types with IntelliJ IDEA` 对 `.codeLocator` 的用户路径与品牌文案是否完全沿用 IDEA。
2. `CodeLocatorWindow` 在作为长期驻留的 Editor Tab 时，是否还需要细化埋点区分（避免把 Editor 打开记成 dialog/window show）。
3. 是否要在 Editor 模式下关闭 `FileUtils.saveScreenCap()` 这类本地副作用。
4. 是否需要给 Editor Tab 自定义标题（例如显示抓取时间/包名），若需要可再评估 `EditorTabTitleProvider`。
