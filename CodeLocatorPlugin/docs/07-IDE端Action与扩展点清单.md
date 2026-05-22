# 07 · IDE 端 Action 与扩展点清单

> 范围：`CodeLocatorPlugin/src/main/java/com/bytedance/tools/codelocator/action/` 下全部 54 个 Action 文件 + plugin.xml 的扩展点。
> 阅读策略：先看第 2 节 "全 Action 速查表"，需要细节时跳到第 3 节单条；ToolWindow / Listener / FileEditor 等其它扩展点在第 4 节。

---

## 1. Action 基类

```text
BaseAction (Kotlin abstract, action/BaseAction.kt)
  ├─ override update(e)：每次 IDE 更新 UI 时调用 isEnable(e) 决定按钮是否可点
  └─ abstract isEnable(e): Boolean
SimpleAction (Java, action/SimpleAction.java)：把一个 lambda 包成 AnAction，不走 BaseAction
```

工具栏注册位置：`panels/CodeLocatorWindow.kt:createDefaultActionGroup()`（约 130 行，决定可见性 / `isWindowMode` 判断）。

---

## 2. 全 Action 速查表

| Action 文件 | 文案 key | 触发入口 | 依赖 IDE state | 调用设备 (ADB/Broadcast) | 主要功能 |
|------------|---------|----------|----------------|--------------------------|---------|
| `GrabViewAction.kt` | `grab_action_text` | 工具栏 Grab 按钮 | ❌ 仅需 ADB | ✅ `ACTION_DEBUG_LAYOUT_INFO` + screencap | 抓取当前 Activity View 树 + 截图 |
| `GrabViewWithStopAnimAction.kt` | `stop_anim_and_grab_action_text` | 工具栏第二个抓取按钮 | ❌ | ✅ 同上 + `KEY_STOP_ALL_ANIM` | 抓取前停动画 2 秒 |
| `LoadWindowAction.kt` | `load_codeLocator_file` | 工具栏 | ❌（纯本地）| ❌ | 弹文件选择对话框读 `.codeLocator` |
| `SaveWindowAction.kt` | `save_grab_info` | 工具栏 | ❌ | ❌ | 当前抓取结果另存为 `.codeLocator` |
| `ShowGrabHistoryAction.kt` | `show_history` | 工具栏 | ❌ | ❌ | 列出 `~/.codeLocator_main/historyFile/*.codeLocator` |
| `CopyGrabFilePathAction.kt` | `copy_grab_file_path` | 工具栏 | ❌ | ❌ | 复制本次 `.codeLocator` 路径到剪贴板（本仓库新增） |
| `CopyViewLinkAction.kt` | `copy_view_link` | 右键 View | ⚠ 需要 selectView + application + 截图 | ❌ | 生成 `codelocator://view?file=...&path=...&memAddr=...&class=...&id=...&xml=...` 协议链接（本仓库新增，详 `CopyViewLinkAction.kt:41-57`） |
| `NewWindowAction.kt` | - | 工具栏 | ❌ | ❌ | 复制当前抓取到独立窗口（diff 用） |
| `EditViewAction.kt` | `edit_view` | 工具栏 + 右键 | ⚠ 需要选中 View | ✅ `ACTION_CHANGE_VIEW_INFO + Edit*Model` | 弹 `EditViewDialog`，改 View 属性 |
| `GetViewDataAction.kt` | - | 工具栏 + 右键 | ⚠ 需要选中 View | ✅ `ACTION_CHANGE_VIEW_INFO + GetDataModel` | 拉 View 自定义数据 JSON |
| `GetViewClassInfoAction.kt` | - | 右键 | ⚠ 需要选中 View | ✅ `ACTION_CHANGE_VIEW_INFO + GetViewClassInfoModel` | 反射 View 类元信息 |
| `GetIntentDataAction.kt` | - | 右键 Activity/Fragment | ⚠ 需要选中 Activity/Fragment | ✅ `ACTION_CHANGE_VIEW_INFO + GetIntentModel` | 拉 Intent |
| `FinishActivityAction.kt` | - | 右键 Activity | ⚠ | ✅ `ACTION_CHANGE_VIEW_INFO + FinishActivityModel` | 关闭当前 Activity |
| `AddExtraFieldAction.kt` | - | 右键 | ⚠ | ✅ `ACTION_PROCESS_CONFIG_LIST + KEY_ACTION_SET` | 给 View 加自定义 ExtraInfo |
| `CopyImageAction.kt` | - | 工具栏 + 右键 | ⚠ 需要 View / Activity | ✅ `ACTION_CHANGE_VIEW_INFO + GetViewBitmapModel` + `cat`/`pull` | 复制 View / Activity 截图 |
| `FindClickLinkAction.kt` | `trace_touch_event` | 工具栏 | ⚠ 需要应用前台 | ✅ `ACTION_GET_TOUCH_VIEW` | 拉最近一次触摸命中的 View 链 |
| `InstallApkAction.kt` | `install_project_new_apk` | 全局快捷键 `⇧⌥I` + 工具栏 | ✅ 需要工程信息（查找 APK） | ✅ `adb install` | 自动找最新 APK 并安装 |
| `InstallApkMenuAction.kt` | - | Project 视图右键 | ✅ 需要选中 vfile | ✅ `adb install` | 安装选中文件 |
| `FileOperateAction.kt` | - | 右键 File Tab | ⚠ 需要选中 WFile | ✅ `ACTION_DEBUG_FILE_OPERATE` + `adb pull/push` | 拉文件、推文件、删文件、改自定义文件 |
| `ClipboardAction.kt` | - | 右键 | ❌ | ❌（仅本地复制） | 把 View 属性文本写入系统剪贴板 |
| `CopyInfoAction.kt` | - | 右键 | ⚠ | ❌ | 复制 View / Activity 信息字符串 |
| `FindViewAction.kt` | `jump_find_view_by_id` | 工具栏 | ✅ 需要 PSI + 当前 View 的 `findViewByIdTag` | ❌ | 跳到代码中的 `findViewById` 处 |
| `FindClickListenerAction.kt` | `jump_clickListener` | 工具栏 | ✅ 需要 `clickTag` | ❌ | 跳到 OnClick 代码 |
| `FindTouchListenerAction.kt` | `jump_touchListener` | 工具栏 | ✅ 需要 `touchTag` | ❌ | 跳到 OnTouch 代码 |
| `FindXmlAction.kt` | `jump_xml` | 工具栏 | ✅ 需要 `xmlTag` | ❌ | 跳到 XML 节点 |
| `FindActivityAction.kt` | `jump_activity` | 工具栏 | ✅ | ❌ | 打开 Activity 源码 |
| `FindFragmentAction.kt` | `jump_fragment` | 工具栏 | ✅ | ❌ | 打开 Fragment 源码 |
| `OpenActivityAction.kt` | `jump_start_activity` | 工具栏 | ✅ 需要 `startInfo` | ❌ | 跳到启动当前 Activity 的代码位置 |
| `OpenClassAction.kt` | `jump_class_file` | 工具栏 | ✅ | ❌ | 用 IDE JumpToClassName 跳到 View 实现类 |
| `OpenDrawableAction.kt` | `jump_resource` | 右键 | ✅ 需要 `drawableTag` | ❌ | 跳到 drawable 资源 |
| `ViewHolderAction.kt` | `jump_view_holder` | 工具栏 | ✅ 需要 `viewHolderTag / adapterTag` | ❌ | 跳到 ViewHolder 代码 |
| `JumpParentViewAction.kt` | `jump_parent_view` | 右键 | ⚠ | ❌ | 选父 View（pure UI） |
| `MarkViewAction.kt` | `mark` | 右键 | ⚠ | ❌ | 在截图上画框 |
| `MarkViewChainAction.kt` | - | 右键 | ⚠ | ❌ | 画 View 链路 |
| `ClearMarkAction.kt` | - | 右键 | ❌ | ❌ | 清画框 |
| `FoldSiblingViewAction.kt` | `fold_sibling_view` | 右键 | ⚠ | ❌ | 折叠兄弟 View |
| `ShowAllClickableAreaAction.kt` | `show_all_clickable_area` | 工具栏 | ❌ | ❌ | 截图上叠加全部可点击区域 |
| `ShowSingleViewClickableAreaAction.kt` | `show_clickable_area` | 工具栏 | ⚠ | ❌ | 仅显示当前 View |
| `TraceShowAction.kt` | `trace_dialog` | 工具栏 | ⚠ 需要 `startInfo` | ❌ | 弹 `ShowTraceDialog` 显示启动栈 |
| `TopItemAction.kt` | `to_top` | 右键 | ⚠ | ❌ | 让选中节点在树中置顶 |
| `OpenToolsAction.kt` | `tool_box` | 工具栏 | ❌ | ❌ | 弹 `ToolsDialog`（9 个工具）|
| `OpenDocAction.kt` | - | 工具栏 | ❌ | ❌ | 浏览器打开在线文档 |
| `SettingsAction.kt` | - | 工具栏 | ❌ | ✅ `ACTION_PROCESS_CONFIG_LIST + KEY_ACTION_CLEAR`（部分子操作） | 编辑插件配置 + 设备端忽略列表 |
| `FeedbackAction.kt` | - | 工具栏 | ❌ | ❌ | 打包日志上传反馈 |
| `UpdateAction.kt` | `update_action_text` | 工具栏（有更新时显示）| ❌ | ❌ | 触发自动更新 |
| `AddSourceCodeAction.kt` | - | 工具栏（仅 hasCodeIndexModule） | ✅ | ❌ | 加索引模块到工程 |
| `RemoveSourceCodeAction.kt` | - | 工具栏 | ✅ | ❌ | 移除上一项加进来的源码索引模块 |
| `ReportJumpWrongAction.kt` | - | 工具栏 | ⚠ | ✅ `ACTION_PROCESS_CONFIG_LIST + KEY_ACTION_ADD` | 反馈跳转错误并下发到设备 |
| `SearchInWebAction.kt` | - | Editor 右键 | ✅ | ❌ | 浏览器搜代码 |
| `SchemaToQRAction.kt` | - | 右键 Schema | ❌ | ❌ | Schema 转二维码 |
| `SelectModuleAction.kt` | - | 内部 | ✅ | ❌ | 选 module |
| `DrawAttrAction.kt` | - | 右键 | ⚠ | ❌ | 显示绘制属性 |
| `SimpleAction.java` | - | 通用 | - | - | 把 lambda 包成 AnAction，本身不出现在工具栏 |

> "依赖 IDE state" 各值含义：
> - **✅**：必须有 IDE 工程信息（PSI / VirtualFile / 工程目录），脱离 IDE 完全不可用。
> - **⚠**：依赖工具窗口内部状态（选中 View / 抓取数据），脱离 IDE 但有等价数据时可复刻。
> - **❌**：不依赖 IDE 工程或工具窗状态。

---

## 3. 关键 Action 单点详解

### 3.1 `GrabViewAction` (`action/GrabViewAction.kt`)

```kotlin
class GrabViewAction(
    val project: Project,
    val codeLocatorWindow: CodeLocatorWindow
) : BaseAction(ResUtils.getString("grab_action_text"), ..., ImageUtils.loadIcon("grab"))
```

- `isEnable`：仅检查 `DeviceManager.hasAndroidDevice()`。
- `actionPerformed`：调 `codeLocatorWindow.rootPanel.startGrab()`，进入 `ScreenPanel.grab(null, false)`。
- 设备协议：见 04 文档。

### 3.2 `EditViewAction` (`action/EditViewAction.kt`)

- `isEnable`：需要 `codeLocatorWindow.currentSelectView != null`。
- `actionPerformed`：弹 `EditViewDialog`；Dialog 内根据用户输入构造 `EditViewBuilder + Edit*Model` 列表，最后 `BroadcastAction(ACTION_CHANGE_VIEW_INFO).args(KEY_CHANGE_VIEW, builder.builderEditCommand())`。

`Edit*Model` 列表（`model/EditModel.kt`）：

| Model | 字段 | EditType |
|-------|------|---------|
| `EditPaddingModel(l,t,r,b)` | int×4 | `P` |
| `EditMarginModel(l,t,r,b)` | int×4 | `M` |
| `EditBackgroudColorModel(int)` | int | `B` |
| `EditFlagModel(flag, type)` | int, string | `VF` |
| `EditLayoutModel(w,h)` | int×2 | `LP` |
| `EditTranslationModel(tx,ty)` | float×2 | `TXY` |
| `EditScrollModel(sx,sy)` | int×2 | `SXY` |
| `EditScaleModel(sx,sy)` | float×2 | `SCXY` |
| `EditPivotModel(px,py)` | float×2 | `PXY` |
| `EditTextModel(s)` | string | `T` |
| `EditTextColorModel(int)` | int | `TC` |
| `EditTextSizeModel(float)` | float | `TS` |
| `EditLineSpacingExtraModel(float)` | float | `LS` |
| `EditShadowModel(x,y) / EditShadowRadiusModel / EditShadowColorModel` | float×n | `SA/SR/SC` |
| `EditAlphaModel(float)` | float | `A` |
| `EditMinimumWidthModel / EditMinimumHeightModel` | int | `MW/MH` |
| `GetViewBitmapModel(type?)` | string? | `VB` 或 `DLB` |
| `GetDataModel()` | - | `GVD` |
| `GetViewClassInfoModel()` | - | `GVCI` |
| `GetIntentModel()` | - | `GI` |
| `FinishActivityModel()` | - | `CA` |
| `GetActivityImageModel()` | - | `VB`（Activity 级） |
| `InvokeMethodModel(MethodInfo)` | object | `IK` |

### 3.3 `FileOperateAction` (`action/FileOperateAction.kt`)

复合 Action，根据右键菜单文案分发到多个 private 方法：

| 私有方法 | 走的命令 |
|----------|---------|
| `downloadFileToPath` | 优先 `adb pull`；如果需要 SDK 协助 → `BroadcastAction(ACTION_DEBUG_FILE_OPERATE + KEY_ACTION_PULL)` 拿到设备端临时路径后再 `pull` |
| `editFile / editCustomFile` | `BroadcastAction(ACTION_OPERATE_CUSTOM_FILE + KEY_ACTION_GET)` 拉自定义文件内容 |
| `pushFiles` | `adb push` + `BroadcastAction(ACTION_DEBUG_FILE_OPERATE + KEY_ACTION_MOVE)` 把文件从 `/sdcard/codeLocator/` 移动到目标位置 |
| `deleteFile` | `BroadcastAction(ACTION_DEBUG_FILE_OPERATE/OPERATE_CUSTOM_FILE + KEY_ACTION_DELETE)` |

### 3.4 `InstallApkAction` (`action/InstallApkAction.kt`)

- `isEnable`：`DeviceManager.hasAndroidDevice()`。
- `actionPerformed`：扫工程目录找 `*.apk`，可能弹 `ShowReInstallDialog` 询问是否覆盖；最终 `DeviceManager.enqueueCmd(AdbCommand(InstallApkFileAction(path)), StringResponse, ...)` → ddmlib `installPackage` 或本地 `adb install -r -t -d`。
- `Ctrl + 点击`：不安装，复制 APK 路径并在 Project 视图选中文件。

### 3.5 `SearchInWebAction` (`action/SearchInWebAction.kt`)

挂在编辑器右键。读当前 Editor 选中或光标所在的文本 → 拼 `getProjectGitUrl()` → 用浏览器打开。**完全 IDE 局部，反向不可能**。

### 3.6 `SettingsAction` (`action/SettingsAction.kt`)

弹 `EditSettingsDialog`：

- 改本地 `CodeLocatorUserConfig`：插件行为开关
- 弹列表让用户编辑设备端忽略列表（Activity / View / Popup / Dialog / Toast / `enable_codelocator`），每次改动调 `BroadcastAction(ACTION_PROCESS_CONFIG_LIST).args(KEY_CODELOCATOR_ACTION, KEY_ACTION_ADD/CLEAR).args(KEY_CONFIG_TYPE, type).args(KEY_DATA, name)`

---

## 4. plugin.xml 其他扩展点

```xml
<extensions defaultExtensionNs="org.jetbrains.kotlin">
    <supportsKotlinPluginMode supportsK1="true" supportsK2="true"/>
    <supportsKotlinK2Mode/>
</extensions>

<extensions defaultExtensionNs="com.intellij">
    <fileType name="CodeLocator" implementationClass="...fileeditor.CodeLocatorFileType" extensions="codeLocator"/>
    <fileEditorProvider implementation="...fileeditor.CodeLocatorFileEditorProvider"/>
    <defaultProjectTypeProvider type="Android"/>
    <postStartupActivity implementation="...listener.CodeLocatorStartupActivity"/>
    <postStartupActivity implementation="...listener.CodeLocatorApplicationInitializedListener"/>
    <toolWindow id="CodeLocator" icon="/images/codeLocator.svg" anchor="right" factoryClass="...panels.CodeLocatorWindowFactory"/>
</extensions>

<projectListeners>
    <listener class="...listener.CodeLocatorProjectManagerListener" topic="com.intellij.openapi.project.ProjectManagerListener"/>
</projectListeners>
```

### 4.1 `fileType` + `fileEditorProvider`（本仓库新增）

把 `.codeLocator` 注册成 IDE 文件类型，双击直接打开。`CodeLocatorFileEditorProvider` 内部把 `CodeLocatorInfo.fromCodeLocatorInfo` 加载结果交给 `CodeLocatorWindow(isWindowMode=true)` 渲染。

### 4.2 `postStartupActivity`

- `CodeLocatorStartupActivity.java`：每个工程启动时跑：`FileUtils.init` → 日志/历史目录创建 → 更新检查 → `DeviceManager.initAdbPath(project)`。
- `CodeLocatorApplicationInitializedListener.kt`：应用级初始化（一次性），见 `~/.codeLocator_main` 目录创建、远程配置拉取。

### 4.3 `projectListeners`

- `CodeLocatorProjectManagerListener.java`：工程关闭时清理 `DeviceManager.sProjectSelectDevice[projectName]`。

### 4.4 `toolWindow`

`CodeLocatorWindowFactory` (`panels/CodeLocatorWindowFactory.kt`) 创建 `CodeLocatorWindow`（`panels/CodeLocatorWindow.kt`），它就是右侧工具窗的实体。

---

## 5. Listener 体系（仅用于内部回调，不是扩展点）

`listener/` 目录全部是 Kotlin/Java 接口或 Adapter：

| Listener | 作用 |
|----------|------|
| `OnActionListener` | `SimpleAction` 的 lambda 类型 |
| `OnClickListener` / `OnShiftClickListener` | UI 鼠标事件 |
| `OnClickTableListener` | 表格行点击 |
| `OnDismissListener` | 弹窗关闭 |
| `OnGrabScreenListener` | screencap 完成 |
| `OnGetActivityInfoListener` | 抓取成功/失败 |
| `OnGetClickViewListener` | 截图区点击命中 View |
| `OnGetViewListListener` | 抓取/过滤后得到 View 列表 |
| `OnSelectExtraListener` / `OnSelectFileListener` / `OnSelectViewListener` | Tab 树选中 |
| `OnViewRightClickListener` | 截图/树右键 |
| `DocumentListenerAdapter` | 编辑器内容变化（用在 `SendSchemaDialog` 等输入框）|

`postStartupActivity` 也在这个目录下。

---

## 6. 反向操作视角的"动作分组"

按"反向 skill 能不能拿来直接用"重新分类（详见 08）：

| 分组 | Action | 反向方案 |
|------|--------|---------|
| 抓取 / 数据 | Grab*, GetViewData, GetViewClassInfo, GetIntentData, FindClickLink | 全部能由 `am broadcast` 复刻 |
| 改设备状态 | EditView, FinishActivity, AddExtraField, ReportJumpWrong | 能复刻，但需要先 grab 取得 memAddr |
| 文件操作 | FileOperate | 能复刻 |
| APK | InstallApk* | `adb install` 直接复刻 |
| 截图相关 | CopyImage, ShowAllClickableArea, ShowSingleViewClickableArea | 截图能复刻，可点击区域要靠 dump 数据自己计算 |
| 跳转代码 | Find*, Open*, ViewHolder, JumpParent | ❌ 完全依赖 IDE PSI，反向 skill 不应承诺 |
| 文件容器 | LoadWindow, SaveWindow, NewWindow, CopyGrabFilePath, CopyViewLink, ShowGrabHistory | 解析/写 `.codeLocator` 文件，skill 现已支持 |
| 杂项 | Settings, Feedback, Update, OpenDoc, OpenTools, ClipBoard, SearchInWeb, SchemaToQR, AddSourceCode... | 部分能复刻，多数是 IDE 内部 UX |

详情见 **08-反向操作可行性矩阵.md**。
