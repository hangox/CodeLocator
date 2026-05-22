# 03 UI 数据模型与源码定位

## 数据内容来自哪里

`ActivityUtils.getActivityDebugInfo` 是 SDK 模式下 `WApplication` 的核心数据源：

- 应用信息来自当前 `Activity`、`Application`、`Build`、`Resources.DisplayMetrics` 和业务 `AppInfoProvider`。
- Activity 信息来自 `CodeLocator.getCurrentActivity()`、`activity.getClass()`、`activity.getIntent()`。
- Fragment 信息来自 `FragmentActivity.getSupportFragmentManager()` 和 `activity.getFragmentManager()`，递归读取 child fragments。
- View 信息来自 `activity.getWindow().getDecorView()`、`WindowManagerGlobal.mRoots` 反射拿到的其他窗口，以及每个 Android `View` 的运行时属性。
- 文件树来自 `ActivityUtils.getFileInfo` 扫描应用内部目录和 external cache，不会自动包含宿主工程源码。

截图主要来自 IDE 侧 ADB `screencap -p`。如果截图为空或全同色，`ScreenPanel.getImageFromView` 会调用应用侧 view bitmap action，保存并读取 view 绘制结果作为 fallback。

## WApplication

关键字段：

- `packageName`：`activity.getPackageName()`。
- `className`：`activity.getApplication().getClass().getName()`。
- `activity`：当前 `WActivity`。
- `file`：可选，只有执行文件信息抓取后才有 `WFile`。
- `showInfos`：Lancet 记录的 Toast/Dialog/Popup 展示信息。
- `appInfo/schemaInfos/colorInfo`：业务 `AppInfoProvider` 输出。
- `density/densityDpi/statusBarHeight/navigationBarHeight/orientation/realWidth/realHeight`：设备与屏幕上下文。
- `fromSdk/hasSDK/isDebug`：区分 SDK 抓取、无 SDK fallback、debuggable 状态。

判断数据质量时先看 `fromSdk` 和 tag 字段是否存在。`fromSdk=false` 或 `hasSDK=false` 时，布局可能来自 dump fallback，源码 tag 信息通常缺失。

## WActivity

关键字段：

- `className`：当前 Activity 完整类名，最直接的页面归属。
- `memAddr`：运行时对象地址，只适合同一抓取快照内关联。
- `decorViews`：当前 Activity 的根 view 列表。第一个通常是 Activity decor view，后续可能是 Dialog/Popup 等窗口。
- `fragments`：Fragment 树。
- `startInfo`：由 Activity Lancet 在 `Context.startActivity` / `Activity.startActivityForResult` 时写入 intent extra，格式可被 `JumpParser.getSingleJumpInfo` 解析为源码位置。

定位 Activity 源码时优先用 `className`；如果要找“谁打开了这个 Activity”，用 `startInfo`。

## WFragment

关键字段：

- `className`：Fragment 完整类名。
- `viewMemAddr`：`fragment.getView()` 的对象地址。
- `tag/id/visible/added/userVisibleHint`：FragmentManager 运行时状态。
- `children`：child fragments。

把 Fragment 和 View 关联时，用 `WFragment.viewMemAddr` 匹配 `WView.memAddr`。如果匹配到，只能说明该 Fragment 的 root view 是这个 `WView`；它的子 View 默认也可视为该 Fragment UI 的一部分，但嵌套 Fragment、Dialog、Popup 需要结合树路径和窗口根节点判断。

## WView

`ActivityUtils.convertViewToWView` 从真实 Android `View` 读取字段：

- 身份：`className`、`memAddr`、`id`、`idStr`。
- 几何：`left/right/top/bottom`、`drawLeft/drawRight/drawTop/drawBottom`、padding、margin、translation、scale、pivot、scroll。
- 状态：clickable、longClickable、focusable、pressed、selected、focused、enabled、visibility、layoutRequested、flags。
- 类型：TextView -> `text/textColor/textSize/span/lineHeight/shadow`；ImageView -> `scaleType/drawableTag`；Linear/Frame/Relative 等基础类型。
- 资源和源码 tag：`clickTag/touchTag/findViewByIdTag/xmlTag/drawableTag/viewHolderTag/adapterTag/backgroundColor`。
- 扩展：`extraInfos` 来自业务 `AppInfoProvider.processViewExtra` 和 `ICodeLocatorProcessor.processView`。

判断“用户说的 UI 是哪个 View”时推荐顺序：

1. 用截图坐标落点过滤 `drawBounds`，同一区域选面积更小、可见且文本/id 更匹配的 View。
2. 用 `text` 匹配可见文案。
3. 用 `idStr` 匹配资源 id，例如 `app:submit_button`。
4. 用 `className` 区分 TextView/ImageView/RecyclerView/自定义控件。
5. 用父子 `path` / `zIndex` / `viewHolderTag` 判断列表项或重复组件。

## Lancet tag 来源

源码定位最关键的 tag 大多来自 Lancet：

- `CodeLocatorLancetXml.XmlLancet` hook `LayoutInflater.inflate` / `ViewStub.inflate`，调用 `CodeLocator.notifyXmlInflate`，最终由 `XmlInfoAnalyzer` 给整棵 inflate 出来的 View 树写 `xmlTag`。
- `CodeLocatorLancetView.ViewLancet` hook `setOnClickListener`、`setOnTouchListener`、`setClickable`、`findViewById`、`ViewGroup.addView`，最终由 `ViewInfoAnalyzer` 写 `clickTag/touchTag/findViewByIdTag`。
- `ViewLancet` hook `RecyclerView.Adapter.onCreateViewHolder`，给 itemView 写 `viewHolderTag` 和 `adapterTag`。
- `XmlLancet` hook `setImageResource` / `Resources.getDrawable`，`CodeLocator.notifySetImageResource` 或 `DrawableInfoAnalyzer` 写 `drawableTag`。
- `ViewLancet` hook `setBackgroundResource`，写 background tag。
- `CodeLocatorLancetActivity.ActivityLancet` hook startActivity，`ActivityInfoAnalyzer` 把打开 Activity 的调用栈写到 intent 的 `ACTIVITY_START_STACK_INFO`，后续成为 `WActivity.startInfo`。

`ViewInfoAnalyzer` 会跳过系统和配置里忽略的调用栈，取第一个业务栈帧，产物通常是：

- `com.foo.SomeActivity.kt:123`
- `com.foo.SomeBinding.java:id/title`
- `com.foo.SomeBinding.kt:bind_id/title:45`

多个来源用 `|` 拼接。

## JumpInfo 与 IDE 跳转规则

`DataUtils.restoreAllStructInfo` 会调用 `JumpParser`：

- `xmlTag + idStr` -> `xmlJumpInfo`，文件名是 layout XML，id 来自 `idStr`。
- `clickTag` -> `clickJumpInfo`。
- `touchTag` -> `touchJumpInfo`。
- `findViewByIdTag` -> `findViewJumpInfo`。
- `startInfo` -> `WActivity.openActivityJumpInfo`。

`JumpParser.getSingleJumpInfo` 规则：

- `file:line`：直接跳到行号。
- `file:id/name`：按 id 搜索。
- `file:bind_id/name:line`：ViewBinding，先按 id 搜索，失败再跳行。

IDE 侧 `IdeaUtils.navigateByJumpInfo`：

- 有行号时按文件名 + package 过滤打开源码行。
- 需要按 id 跳转时，在源码/XML 内搜索指定文本。
- XML 跳转会搜索 `id="@+id/<id>"`，失败后尝试 `@android:id/<id>` 和 include。

## 实战定位优先级

对一个目标 View，按以下顺序回答“属于哪个 UI/类/代码位置”：

1. Activity：`application.activity.className`。
2. Fragment：用 `view.memAddr` 向上找最近与 `fragment.viewMemAddr` 匹配的节点；没有匹配就只说明 Activity/window 归属。
3. XML：`view.tags.xmlTag` + `view.idStr`。
4. 点击/触摸源码：`clickTag`、`touchTag`。
5. 初始化/绑定源码：`findViewByIdTag`。
6. 列表项：`viewHolderTag`、`adapterTag`。
7. 图片/背景资源：`drawableTag`、`backgroundColor` 中的资源名。
8. 兜底：`className/idStr/text/path` 全仓检索，并明确这是推断。

如果 tag 为空，不要声称能精确到代码行；应说明缺少 Lancet/SDK 运行时 tag，只能给出候选类、XML、id 或文本检索路径。
