# 01 抓取与历史保存链路

## 入口与总体顺序

IDE 侧的主要抓取入口在 `CodeLocatorPlugin/src/main/java/com/bytedance/tools/codelocator/panels/ScreenPanel.java`。`startGrabEvent(lastSelectView, stopAnim)` 调用 `grab(lastSelectView, stopAnim)`，然后分两条路径：

- `stopAnim == true`：走 `stopAnimAndGrabView`，先广播抓取布局数据，同时启动截图线程 `takeScreenShot`。
- `stopAnim == false`：走 `directGrabView`，通常先 ADB `screencap -p` 截图，再调用 `onGetScreenCapImage` 广播抓取布局数据。

两条路径最终都进入 `onGetApplicationInfoSuccess`，该方法在非历史窗口模式下调用：

```text
ShowGrabHistoryAction.saveCodeLocatorHistory(new CodeLocatorInfo(mApplication, mScreenCapImage))
```

也就是说历史 `.codeLocator` 是“应用运行时结构数据 + 当前截图”的快照。

## IDE 侧抓取细节

`ScreenPanel.directGrabView`：

- 如果设备不需要文件中转，执行 `new ScreencapAction("-p")`，通过 `ImageResponse` 直接得到截图。
- 如果直接截图失败或设备处于文件模式，走 `getScreenCapByFile`，执行 `screencap -p /sdcard/codeLocator_image.png` 后 pull 到本机 `.codeLocator_main`。
- 截图成功后调用 `onGetScreenCapImage`，广播 `ACTION_DEBUG_LAYOUT_INFO`，参数包括：
  - `KEY_SAVE_TO_FILE`：是否要求设备侧把响应写入文件。
  - `KEY_NEED_COLOR`：是否需要颜色预览数据。

`ScreenPanel.stopAnimAndGrabView`：

- 先删除设备侧中转文件 `TMP_TRANS_DATA_FILE_PATH`、`TMP_TRANS_IMAGE_FILE_PATH`。
- 广播 `ACTION_DEBUG_LAYOUT_INFO`，额外带 `KEY_STOP_ALL_ANIM = 2000`。
- 广播执行期间另起线程截图，最后 `checkStopGrabEnd -> onStopGrabEnd` 汇合布局和截图。

截图异常时有 fallback：如果 ADB 截图为空或全同色，`onStopGrabEnd` / `onGetScreenCapImage` 会取第一个 decor view，通过 `getImageFromView` 触发应用侧 `GetViewBitmapModel`，从应用保存的 view bitmap 文件读取 PNG。

## 应用 SDK 侧数据来源

应用侧入口是 `CodeLocatorApp/CodeLocatorCore/src/main/java/com/bytedance/tools/codelocator/receiver/CodeLocatorReceiver.java`。`onReceive` 收到 `ACTION_DEBUG_LAYOUT_INFO` 后进入 `processGetLayoutAction -> getTopActivityLayoutInfo`：

```text
ActivityUtils.getActivityDebugInfo(activity, needColor, isMainThread)
sendResult(context, smartArgs, new ApplicationResponse(application))
```

`ActivityUtils.getActivityDebugInfo` 按顺序构建：

- `buildApplicationInfo`：包名、Application class、SDK 版本、系统版本、设备信息、density、屏幕尺寸、状态栏/导航栏高度等。
- `buildShowAndAppInfo`：业务 `AppInfoProvider` 提供的 appInfo、schema、颜色信息、Toast/Dialog/Popup showInfo。
- `buildActivityInfo`：当前 Activity class、内存地址、启动栈信息 `startInfo`。
- `buildFragmentInfo`：support Fragment 和 platform Fragment 树，记录 class、tag、id、viewMemAddr、可见性。
- `buildViewInfo`：当前 Activity decor view、Dialog/Popup 等窗口 view，递归转换成 `WView` 树。

文件树不是默认随布局抓取一起拿。IDE 侧在 `ScreenPanel.getFileInfo` 里单独广播 `ACTION_DEBUG_FILE_INFO`，应用侧 `CodeLocatorReceiver.getFileInfo` 调用 `ActivityUtils.getFileInfo`，扫描应用私有目录和 external cache，返回 `WFile` 树。

## 传输格式与恢复

应用侧 `CodeLocatorReceiver.sendResult` 会把 `BaseResponse` JSON 压缩后 Base64：

```text
Base64.encodeToString(CodeLocatorUtils.compress(GsonUtils.sGson.toJson(baseResponse)))
```

如果结果过大、显式 `KEY_SAVE_TO_FILE` 或 async 模式，会保存成设备侧临时文件，广播结果只返回 `FP:<path>`。IDE 侧 `DeviceManager.parserResult` 检测 `FP:` 后 pull 文件，再 Base64 解码、解压、Gson 反序列化为 `ApplicationResponse` 或 `FileResponse`。

反序列化后 `DataUtils.restoreAllStructInfo(application, false)` 会恢复运行时结构：

- 重建 parent/child、activity/application 引用。
- 用 `JumpParser` 把 `xmlTag/clickTag/touchTag/findViewByIdTag/startInfo` 转成 `JumpInfo`。
- 排序 showInfo/schemaInfo。

从 `.codeLocator` 文件恢复时，`CodeLocatorInfo.fromCodeLocatorInfo` 会在读取 `WApplication` 后调用 `DataUtils.restoreAllStructInfo(application, true)`，保留历史抓取时间。

## 历史入口

历史按钮在 `CodeLocatorPlugin/src/main/java/com/bytedance/tools/codelocator/action/ShowGrabHistoryAction.kt`：

- 历史目录：`FileUtils.sCodelocatorHistoryFileDirPath`。
- 文件后缀：`.codeLocator`。
- 保存名：`<packageName><yyyy_MM_dd_HH_mm_ss>.codeLocator`。
- 打开历史：`ShowHistoryDialog` 列出文件，悬停用 `CodeLocatorInfo.fromCodeLocatorInfo` 解析截图预览，点击后 `CodeLocatorWindow.showCodeLocatorDialog` 打开历史窗口。

`LoadWindowAction.kt` 则支持从任意位置选择一个 `.codeLocator` 文件，读取二进制并恢复窗口。
