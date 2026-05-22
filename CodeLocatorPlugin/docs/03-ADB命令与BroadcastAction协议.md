# 03 · ADB 命令与 BroadcastAction 协议

> 本篇是反向操作设计的"协议规范"。所有 IDE 端与 SDK 间的通信都收敛在两套机制：
> 1. **ADB shell / pull / push / install / screencap** —— `device/action/*Action.java`
> 2. **`am broadcast`** —— `BroadcastAction` + `CodeLocatorConstants.ACTION_*`
>
> 反向 skill 要做的就是绕开 IDE 直接发出这些命令。

---

## 1. AdbAction 类型清单

`device/action/AdbCommand.java` 定义所有支持的 shell 一级动作：

```java
PULL_FILE   = "pull"      // adb pull
PUSH_FILE   = "push"      // adb push
DELETE_FILE = "rm"        // shell rm
SCREENCAP   = "screencap" // shell screencap -p
CAT         = "cat"       // shell cat
SETTINGS    = "settings"  // shell settings ...
UNINSTALL   = "uninstall" // adb uninstall
INSTALL     = "install"   // adb install ...
GETPROP     = "getprop"   // shell getprop
SETPROP     = "setprop"   // shell setprop
AM          = "am"        // shell am ...
DUMPSYS     = "dumpsys"   // shell dumpsys ...
UIAUTOMATOR = "uiautomator"
WM          = "wm"        // shell wm
PM          = "pm"        // shell pm
MONKEY      = "monkey"
CONTENT     = "content"   // shell content
RUN_AS      = "run-as"    // shell run-as
```

`DEVICE_NOT_SUPPORT_ACTIONS = [install, uninstall, pull, push, screencap]` 这五个不走 `adb shell`，而由 ddmlib 自己处理（`DeviceManager.java:574`）。

### 1.1 AdbAction 子类

| 子类 | 拼出来的命令样例 | 源文件 |
|------|----------------|--------|
| `BroadcastAction` | `am broadcast -a <ACTION> --es codeLocator_shell_args '<Base64(JSON)>'` | `BroadcastAction.java` |
| `ScreencapAction` | `screencap -p` 或 `screencap -p /sdcard/codeLocator_image.png` | `ScreencapAction.java` |
| `PullFileAction` | `pull <src> <dst>` | `PullFileAction.java` |
| `PushFileAction` | `push <src> <dst>` | `PushFileAction.java` |
| `DeleteFileAction` | `rm <path>`（不带 `-f`） | `DeleteFileAction.java` |
| `CatFileAction` | `cat <path>` | `CatFileAction.java` |
| `InstallApkFileAction` | `install -r -t -d <apkPath>` | `InstallApkFileAction.java` |
| `UnInstallApkAction` | （**死代码**：内部 type 错写为 `INSTALL` 而非 `UNINSTALL`，全仓库 0 调用方）| `UnInstallApkAction.java` |
| `QueryContentAction` | `content query --uri content://<provider>` | `QueryContentAction.java` |
| `GetCurrentPkgNameAction` | `dumpsys activity activities` | `GetCurrentPkgNameAction.java` |
| `RunAsAction` | `run-as <pkg> <cmd> '<value>'` | `RunAsAction.java` |
| `AdbAction(ACTION.AM, "start -d ...")` 等裸 `AdbAction` | 直接拼接 | `AdbAction.java` |

---

## 2. BroadcastAction 协议详解

### 2.1 命令模板

```bash
adb shell am broadcast \
  -a <ACTION_NAME> \
  --es codeLocator_shell_args '<Base64 编码后的 JSON 字符串>'
```

要点：
- 没有 `-n <pkg/component>`，不指定收件人，依赖设备端 SDK 注册的 `IntentFilter` 命中。
- 没有 `-p <pkg>` 限定包名，所以**所有装了 SDK 的应用都会收到**（SDK 内部按"当前 Activity 所属进程"过滤）。
- `--es` 只有一对：`codeLocator_shell_args` ➜ Base64(JSON map)，JSON 里 key 是下面表里的常量。
- 真正的"携带数据"放在 JSON 里，不放在 `--es key value` 形式上。

> 拼装代码：`device/action/BroadcastAction.java:95-115`，使用 `Base64.encodeToString(GsonUtils.sGson.toJson(mArgsList))`。

### 2.2 全部 Action 常量

来自 `CodeLocatorApp/CodeLocatorModel/src/main/java/com/bytedance/tools/codelocator/utils/CodeLocatorConstants.java:26-46`：

| Action 常量 | 字符串值 | 触发场景（IDE 端） | 设备端处理（`CodeLocatorReceiver.java`） |
|------------|---------|-------------------|------------------------------------|
| `ACTION_DEBUG_LAYOUT_INFO` | `com.bytedance.tools.codelocator.action_debug_layout_info` | `ScreenPanel.grab()` 抓取主入口 | `processGetLayoutAction` → `ApplicationResponse` |
| `ACTION_DEBUG_FILE_INFO` | `...action_debug_file_info` | 文件 Tab 拉取沙盒文件树 | `processGetFileAction` → `FileResponse` |
| `ACTION_DEBUG_FILE_OPERATE` | `...action_debug_file_operate` | 文件 pull/move/delete | `processFileOperateAction` → `FilePathResponse` |
| `ACTION_OPERATE_CUSTOM_FILE` ⚠ | `...action_operate_custom_file` | 自定义文件 get/set/delete | SDK 内置 Receiver **不处理**，靠业务方 `ICodeLocatorProcessor.processIntentAction` 扩展（详见 §7 与 06 §2） |
| `ACTION_CHANGE_VIEW_INFO` | `...action_change_view_info` | EditView / GetViewData / Invoke / FinishActivity / GetViewBitmap / GetIntent / GetActivityImage | `processChangeViewAction` → `OperateResponse` |
| `ACTION_GET_TOUCH_VIEW` | `...action_get_touch_view` | "点击链路追踪" 按钮 | `processGetTouchViewAction` → `TouchViewResponse` |
| `ACTION_MOCK_TOUCH_VIEW` ⚠ | `...action_mock_touch_view` | 模拟点击坐标 | `processMockTouchViewAction` → `TouchViewResponse`。**注意：SDK 在 `CodeLocator.registerReceiver()`（`CodeLocator.java:397-405`）的 IntentFilter 里并未注册该 action**，Receiver `switch` 里的 case 永远不会命中。需业务方通过 `ICodeLocatorProcessor.providerRegisterAction()` 自行注册 IntentFilter 才能用 |
| `ACTION_USE_TOOLS_INFO` | `...action_use_tools_info` | LayoutTool / OverdrawTool 等 setprop 后通知应用刷新 | `processToolsAction` → `BaseResponse` |
| `ACTION_PROCESS_SCHEMA` | `...action_process_schema` | `SendSchemaDialog`，`am start -d` 失败后兜底 | `processSchemaAction` → `StatesResponse(true/false)` |
| `ACTION_PROCESS_CONFIG_LIST` | `...action_process_config_list` | `EditSettingsDialog` / `FixJumpErrorDialog` 写忽略列表 | `processConfigListAction` → `StatesResponse` |
| `ACTION_CONFIG_SDK` | `...action_config_sdk` | 设置 fetch url / 异步广播开关 | `processConfigSDk` → `StatesResponse` |
| `codeLocator_action_get_clipboard` | `codeLocator_action_get_clipboard` | `ClipboardDialog`，需要先装 helper APK | helper APK 内处理 |
| `codeLocator_action_set_clipboard` | `codeLocator_action_set_clipboard` | 同上 | 同上 |

### 2.3 KEY 列表

`CodeLocatorConstants.java:50-96`：

| Key | 字符串值 | 类型 | 出现在哪些 ACTION |
|-----|---------|------|------------------|
| `KEY_SHELL_ARGS` | `codeLocator_shell_args` | string (Base64 JSON) | 所有 broadcast 必带（外层壳） |
| `KEY_CHANGE_VIEW` | `codeLocator_change_view` | JSON string | `ACTION_CHANGE_VIEW_INFO` |
| `KEY_MOCK_CLICK_X` | `codeLocator_mock_click_x` | int | `ACTION_MOCK_TOUCH_VIEW` |
| `KEY_MOCK_CLICK_Y` | `codeLocator_mock_click_y` | int | `ACTION_MOCK_TOUCH_VIEW` |
| `KEY_CODELOCATOR_ACTION` | `codeLocator_action` | string (add/set/clear/delete) | `ACTION_PROCESS_CONFIG_LIST`, `ACTION_CONFIG_SDK` |
| `KEY_PROCESS_SOURCE_FILE_PATH` | `codeLocator_process_source_file_path` | string | `ACTION_DEBUG_FILE_OPERATE`, `ACTION_OPERATE_CUSTOM_FILE` |
| `KEY_PROCESS_TARGET_FILE_PATH` | `codeLocator_process_target_file_path` | string | `ACTION_DEBUG_FILE_OPERATE` (move) |
| `KEY_PROCESS_FILE_OPERATE` | `codeLocator_process_file_operate` | enum: pull/move/delete/set/get/add/clear | 文件相关 |
| `KEY_CONFIG_TYPE` | `config_type` | string | `ACTION_PROCESS_CONFIG_LIST`, `ACTION_CONFIG_SDK` |
| `KEY_CUSTOM_TAG` | `custom_tag` | string | `ACTION_OPERATE_CUSTOM_FILE` |
| `KEY_SCHEMA` | `codeLocator_schema` | string | `ACTION_PROCESS_SCHEMA` |
| `KEY_DATA` | `codeLocator_data` | string | 配置类 action |
| `KEY_SAVE_TO_FILE` | `codeLocator_save_to_file` | bool | 所有 broadcast 都可携带，强制结果走文件回传 |
| `KEY_ASYNC` | `codeLocator_save_async` | bool | 启用异步广播（结果异步写到 SP 后由 Provider 查回） |
| `KEY_NEED_COLOR` | `codeLocator_need_color` | bool | `ACTION_DEBUG_LAYOUT_INFO` 是否含 View 色值 |
| `KEY_STOP_ALL_ANIM` | `codeLocator_stop_all_anim` | long (毫秒) | `ACTION_DEBUG_LAYOUT_INFO` 抓取前停止动画 |
| `KEY_TOOLS_COMMAND` | `codeLocator_tools_command` | string (`COMMAND_UPDATE_ACTIVITY` 等) | `ACTION_USE_TOOLS_INFO` |

### 2.4 操作类型枚举 (`EditType`)

`CodeLocatorConstants.EditType`：所有 `ACTION_CHANGE_VIEW_INFO` 下的具体子操作（共 **33 个**常量，含 `IGNORE / FECTH_URL / ASYNC_BROADCAST / GET_CLASS_INFO`），编码在 `KEY_CHANGE_VIEW` 的 JSON 里。

| 常量 | 值 | 用途 |
|------|----|------|
| `PADDING` | `P` | 改 padding |
| `MARGIN` | `M` | 改 margin |
| `BACKGROUND` | `B` | 改背景色 |
| `VIEW_FLAG` | `VF` | 改 visibility / clickable / enable 等 flag |
| `LAYOUT_PARAMS` | `LP` | 改 layoutParams width/height |
| `TRANSLATION_XY` | `TXY` |  |
| `SCROLL_XY` | `SXY` |  |
| `SCALE_XY` | `SCXY` |  |
| `PIVOT_XY` | `PXY` |  |
| `TEXT` | `T` | 改文字 |
| `TEXT_COLOR` | `TC` |  |
| `TEXT_SIZE` | `TS` |  |
| `LINE_SPACE` | `LS` |  |
| `SHADOW_XY` / `SHADOW_RADIUS` / `SHADOW_COLOR` | `SA/SR/SC` |  |
| `MINIMUM_HEIGHT` / `MINIMUM_WIDTH` | `MH/MW` |  |
| `ALPHA` | `A` |  |
| `VIEW_BITMAP` | `VB` | 拉取 View 截图 |
| `DRAW_LAYER_BITMAP` | `DLB` | 拉取分层截图（带 ONLY_FOREGROUND/ONLY_BACKGROUND 参数）|
| `ONLY_FOREGROUND` / `ONLY_BACKGROUND` | `OF/OB` | 与 `VB`/`DLB` 配合 |
| `GET_VIEW_DATA` | `GVD` | 抓取自定义 View 数据 |
| `SET_VIEW_DATA` | `SVD` | 设置自定义 View 数据 |
| `GET_VIEW_CLASS_INFO` | `GVCI` | 反射 View 类元信息 |
| `GET_INTENT` | `GI` | 拉 Intent |
| `CLOSE_ACTIVITY` | `CA` | 关闭 Activity |
| `INVOKE` | `IK` | 反射调用方法 |
| `FECTH_URL` | `FU` | 配 fetch URL（搭配 `ACTION_CONFIG_SDK`）|
| `ASYNC_BROADCAST` | `AB` | 开关异步广播 |
| `GET_CLASS_INFO` | `GCI` |  |
| `IGNORE` | `X` | 占位符（不带参数的子动作填这个）|

### 2.5 `KEY_CHANGE_VIEW` 内 JSON 结构

来自 `model/EditModel.kt:24-33` 的 `OperateData`：

```jsonc
{
  "type": "V",           // OperateType: V=View, A=Activity, F=Fragment, P=Application
  "itemId": 305419896,   // 设备内存地址（hex 转 int）
  "dataList": [          // 多条子操作
    {
      "type": "T",       // EditType
      "value": "Hello"   // 子操作的字符串参数
    },
    {
      "type": "VF",
      "value": "8"       // 8 = GONE, 4 = INVISIBLE, 0 = VISIBLE, 0x10/0x20 = clickable/enable mask
    }
  ]
}
```

`OperateType`：

| 常量 | 值 |
|------|----|
| `VIEW` | `V` |
| `ACTIVITY` | `A` |
| `FRAGMENT` | `F` |
| `APPLICATION` | `P` |

> ⚠ `itemId` 由 IDE 端从抓取数据中拿到的 `memAddr`（十六进制字符串）转成 int 得到（`EditModel.kt:39`）。**反向操作要先抓一次 grab 才能拿到稳定的 memAddr**，进程重启就失效。

---

## 3. 抓取结果回传协议

设备端 `CodeLocatorReceiver.sendResult()` (`receiver/CodeLocatorReceiver.java:493-542`) 把 `BaseResponse` 子类序列化后回传：

1. `responseJson = Gson.toJson(BaseResponse)`
2. `compressed = Base64(GZIP(responseJson))`
3. 判断是否走文件回传：
   - `saveToFile = isAsync || KEY_SAVE_TO_FILE || compressed.length > maxBroadcastTransferLength`
4. 走文件：写到 `<ExternalCacheDir>/codeLocator/codeLocator_data.txt`（API 30+）或 `/sdcard/Download/codeLocator_data.txt`，然后用 `setResultData("FP:<path>")` 通知 IDE
5. 不走文件：直接 `setResultData(compressedString)`

`adb shell am broadcast` 的输出格式：

```text
Broadcasting: Intent { act=... }
Broadcast completed: result=0, data="FP:/data/.../codeLocator_data.txt"
```

IDE 端 `DeviceManager.parserResult()` (`DeviceManager.java:381-497`) 用以下规则解析：

- 如果 `result` 里有 `FP:`，截取路径，执行 `adb pull` 到 `~/.codeLocator_main/`
- 否则截取 `data="..."` 中间的 Base64，本地 `Base64.decode + GZIP.decompress + Gson.fromJson`
- 如果两种都找不到（异步广播或 SDK 无响应），用 `dumpsys activity activities` 拿当前包名/Activity，然后用 `content query --uri content://<pkg>.CodeLocatorProvider` 拿 `AsyncResult=FP:...` 字段

---

## 4. 外部驱动样例命令

以下命令在 macOS / Linux 直接复制到终端可执行（假设设备已 `adb connect` 好）。

> ⚠ **关键约定：URL_SAFE / NO_PADDING / NO_WRAP base64**
>
> SDK 端 `SmartArgs.decode` 用的是 `Base64.DEFAULT_FLAGS = URL_SAFE | NO_PADDING | NO_WRAP`
> （`CodeLocatorApp/CodeLocatorModel/src/main/java/com/bytedance/tools/codelocator/utils/Base64.java:46`），
> 并据此选用 `DECODE_WEBSAFE` 解码表（`Base64.java:260` `alphabet = (flags & URL_SAFE) == 0 ? DECODE : DECODE_WEBSAFE`）。
> IDE 端 `BroadcastAction.buildCmd` 调 `Base64.encodeToString` 同样走 `DEFAULT_FLAGS`，两端一致。
>
> 因此反向 skill / shell 命令必须用 **URL_SAFE 等价 base64**：
> - 编码：把 `+` 换成 `-`、`/` 换成 `_`、去掉 `=` padding、去掉换行 → `base64 | tr -d '\n=' | tr '+/' '-_'`
> - 解码：先把 `-_` 转回 `+/`、补回 `=` padding 再交给 `base64 -d`
>
> 否则只要 payload 编码后碰巧出现 `+` 或 `/`（如 JSON 中含 `?` `&` 等被 UTF-8 编码后 base64 输出含 `/` 的位），SDK 端
> 解码到 `DECODE_WEBSAFE` 表里这两个字符位是 `SKIP=-1` → 解码失败 → `SmartArgs` 拿不到任何字段 → receiver 走 default
> 分支静默无动作。**这种失败没有任何 stderr 提示**，最容易踩坑。
>
> 下面所有样例已统一使用 URL_SAFE 形式。

### 4.1 抓取一次界面（最常用）

```bash
# 1) 准备 JSON args
ARGS_JSON='{"codeLocator_save_to_file":"true","codeLocator_need_color":"true"}'
# 2) URL_SAFE Base64（无换行、无 padding，+/ → -_，对齐 SDK SmartArgs.decode）
ARGS_B64=$(echo -n "$ARGS_JSON" | base64 | tr -d '\n=' | tr '+/' '-_')
# 3) 发广播
adb shell "am broadcast -a com.bytedance.tools.codelocator.action_debug_layout_info --es codeLocator_shell_args '$ARGS_B64'"
# stdout 里会有：data="FP:<path>"
#   - API ≥ 30：path 形如 /sdcard/codeLocator/codeLocator_data.txt
#   - API < 30：path 形如 /sdcard/Android/data/<pkg>/cache/codeLocator/codeLocator_data.txt
# 不要按 API 等级硬编码，必须从 stdout 解析 FP 字段
# 4) 把数据文件拉回（用上一步实际拿到的 FP 路径）
adb pull "<FP path>" /tmp/cl_data.txt
# 5) 本地解析（SDK 写文件用同一套 URL_SAFE base64，所以先转回标准 base64 + 补 padding 再 -d）
tr -d '\n' < /tmp/cl_data.txt | tr '_-' '/+' \
  | awk '{ pad=(4-length%4)%4; for(i=0;i<pad;i++) $0=$0"="; print }' \
  | base64 -d | gunzip | jq .
# 6) 抓屏
adb shell screencap -p > /tmp/cl_screen.png
```

> ⚠ 实测要点：API 30+ 必须 `KEY_SAVE_TO_FILE=true`，否则 broadcast 把整个压缩串塞进 `data=` 字段会被 shell 截断。

### 4.2 触发"点击链路追踪"（Find Click View Chain）

```bash
ARGS=$(echo -n '{"codeLocator_save_to_file":"true"}' | base64 | tr -d '\n=' | tr '+/' '-_')
adb shell "am broadcast -a com.bytedance.tools.codelocator.action_get_touch_view --es codeLocator_shell_args '$ARGS'"
```

### 4.3 模拟点击坐标（拿到点击命中的 View 链）

> ⚠ **此命令默认情况下不会被任何 receiver 处理**。SDK 的 `CodeLocator.registerReceiver()` 没把 `ACTION_MOCK_TOUCH_VIEW` 加进 IntentFilter（详见 §2.2 备注与 06 §2），需要业务方先用 `ICodeLocatorProcessor.providerRegisterAction()` 把它注册进去。下面只展示协议格式：

```bash
ARGS=$(echo -n '{"codeLocator_mock_click_x":"540","codeLocator_mock_click_y":"1200","codeLocator_save_to_file":"true"}' | base64 | tr -d '\n=' | tr '+/' '-_')
adb shell "am broadcast -a com.bytedance.tools.codelocator.action_mock_touch_view --es codeLocator_shell_args '$ARGS'"
```

### 4.4 改 View 文本（依赖前一次 grab 拿到的 `memAddr`）

```bash
# EDIT_CMD 是 OperateData JSON，itemId 是 grab 拿到的 memAddr（hex 字符串）转 int 后的值
EDIT_CMD='{"type":"V","itemId":305419896,"dataList":[{"type":"T","value":"Hello"}]}'
# 把 EDIT_CMD 作为字符串嵌进 KEY_CHANGE_VIEW
JSON="{\"codeLocator_change_view\":$(echo "$EDIT_CMD" | jq -aRs),\"codeLocator_save_to_file\":\"true\"}"
ARGS=$(printf %s "$JSON" | base64 | tr -d '\n=' | tr '+/' '-_')
adb shell "am broadcast -a com.bytedance.tools.codelocator.action_change_view_info --es codeLocator_shell_args '$ARGS'"
```

### 4.5 发 Schema

```bash
# 优先用 am start 试 deep link
adb shell "am start -d 'snssdk1128://feed'"
# 如果失败再走广播
ARGS=$(echo -n '{"codeLocator_schema":"snssdk1128://feed","codeLocator_save_to_file":"true"}' | base64 | tr -d '\n=' | tr '+/' '-_')
adb shell "am broadcast -a com.bytedance.tools.codelocator.action_process_schema --es codeLocator_shell_args '$ARGS'"
```

### 4.6 打开/关闭布局边界

```bash
adb shell setprop debug.layout true
# 通知应用刷新
ARGS=$(echo -n '{"codeLocator_tools_command":"command_update_activity"}' | base64 | tr -d '\n=' | tr '+/' '-_')
adb shell "am broadcast -a com.bytedance.tools.codelocator.action_use_tools_info --es codeLocator_shell_args '$ARGS'"
```

### 4.7 查询 SDK 是否就绪 / 拿异步结果

```bash
# <pkg> 是被调试 app 包名
adb shell "content query --uri content://<pkg>.CodeLocatorProvider"
# 返回字段：AsyncBroadcast=true/false, AsyncResult=FP:/path, ...
```

### 4.8 拉应用沙盒文件树

```bash
ARGS=$(echo -n '{"codeLocator_save_to_file":"true"}' | base64 | tr -d '\n=' | tr '+/' '-_')
adb shell "am broadcast -a com.bytedance.tools.codelocator.action_debug_file_info --es codeLocator_shell_args '$ARGS'"
```

---

## 5. "外部可调用" 速查表

| 反向操作 | 走的 ACTION / 命令 | 必填字段 | 备注 |
|---------|-------------------|---------|------|
| 抓 View 树 + Activity 信息 | `ACTION_DEBUG_LAYOUT_INFO` | `KEY_SAVE_TO_FILE=true`（API 30+） | 必须设备先打开过 App，SDK 已初始化 |
| 抓屏 | `adb shell screencap -p` | - | 不需要 SDK |
| 抓 View 截图（分层） | `ACTION_CHANGE_VIEW_INFO + EditType.VIEW_BITMAP` | 先 grab 拿到 `memAddr` → `itemId` | 返回 FP，需要再 `cat`/`pull` |
| 改 View 属性 | `ACTION_CHANGE_VIEW_INFO + Edit*Model` | itemId | 同上 |
| 关闭 Activity | `ACTION_CHANGE_VIEW_INFO + EditType.CLOSE_ACTIVITY` | itemId | 需要 Activity memAddr |
| 反射调方法 | `ACTION_CHANGE_VIEW_INFO + EditType.INVOKE` | itemId + InvokeInfo JSON | |
| 拉文件树 | `ACTION_DEBUG_FILE_INFO` | `KEY_SAVE_TO_FILE` | |
| 拉单个文件 | `ACTION_DEBUG_FILE_OPERATE + KEY_ACTION_PULL` | 源路径 | 返回 FilePathResponse，本地再 pull |
| 推/移动文件 | `adb push` + `ACTION_DEBUG_FILE_OPERATE + KEY_ACTION_MOVE` | 源、目标路径 | |
| 删文件 | `ACTION_DEBUG_FILE_OPERATE + KEY_ACTION_DELETE` | 源路径 | |
| 点击链路追踪 | `ACTION_GET_TOUCH_VIEW` | - | 返回最近一次触摸命中的 View 链 |
| 模拟点击 ⚠ | `ACTION_MOCK_TOUCH_VIEW` | x, y | **SDK 默认未注册 IntentFilter，不可直接用**（详见 §2.2）|
| 发 Schema | `am start -d` 或 `ACTION_PROCESS_SCHEMA` | schema | |
| 改 SDK 配置 | `ACTION_PROCESS_CONFIG_LIST` / `ACTION_CONFIG_SDK` | type, action, data | |
| 切布局边界 | `setprop debug.layout` + `ACTION_USE_TOOLS_INFO` | tools_command | |
| 切过度绘制 | `setprop debug.hwui.overdraw` + `ACTION_USE_TOOLS_INFO` | | |
| HTTP 代理 | `settings put global http_proxy 'ip:port'` | - | 不依赖 SDK |
| 显示触摸点 / 指针位置 | `content insert --uri content://settings/system --bind name:s:show_touches --bind value:i:1` | - | 不依赖 SDK |
| 安装 APK | `adb install -r -t -d` | apk 路径 | 不依赖 SDK |
| 卸载 APK | `adb uninstall <pkg>` | 包名 | 不依赖 SDK |
| 读/写设备剪贴板 | 装 `codelocatorhelper.apk` + 广播 `codeLocator_action_get/set_clipboard` | content | 需要辅助 APK |

> 上表"是否依赖 SDK" 几乎只有 ADB 原生能力 / 不依赖 SDK，其它全部依赖被调试 App 内集成了 `codelocator-sdk` 并注册了 `CodeLocatorReceiver`。

---

## 6. 反向操作常见坑

1. **`am broadcast` 输出会被设备端的 ANSI / 多行截断**：稳妥做法是始终带 `KEY_SAVE_TO_FILE=true`，把结果落盘 → 解析 `FP:` → `adb pull` 拉文件。
2. **必须用 URL_SAFE / NO_PADDING / NO_WRAP Base64**（详见本节 §4 开头 ⚠ 块）：JSON Base64 后必须 `tr -d '\n=' | tr '+/' '-_'`，否则 `+/` 字符在 SDK 端 DECODE_WEBSAFE 表里是 SKIP → SmartArgs 静默失败 → receiver 无动作。换行同时也会让 shell 解析 `'...'` 出错，所以"去换行"和"换字符表"两步缺一不可。
3. **`memAddr` 是 Java 对象 hashCode/identityHashCode**，进程重启或 GC 后失效。每次反向 EditView 前都必须重新抓一次。
4. **设备端文件路径**（实现见 `CodeLocatorApp/CodeLocatorCore/.../FileUtils.java:143-150` 的 `getFile(context, fileName)`）：
   - **API ≥ 30**：写到 `/sdcard/codeLocator/<fileName>`（`CodeLocatorConstants.BASE_DIR_PATH`），调用前会触发 `verifyStoragePermissions` 申请旧 SDcard 写权限。
   - **API < 30**：写到 `<ExternalCacheDir>/codeLocator/<fileName>` = `/sdcard/Android/data/<pkg>/cache/codeLocator/<fileName>`。
   - **结论**：反向 skill 一定要从 broadcast `data="FP:<path>"` 字段动态拿路径，不要按 API 等级硬编码。
   - 旧常量 `TMP_TRANS_DATA_FILE_PATH = /sdcard/Download/codeLocator_data.txt` 只在 IDE 端 `getScreenCapByFile` 等场景作"主动指定路径"用，**不是** SDK `sendResult` 自动写入的位置。
5. **`--user 0`**：广播默认 `--user 0`，多用户设备需要在命令中显式带 `--user`。
6. **异步广播**：`KEY_ASYNC=true` 时，`am broadcast` 返回 0 但 `data="..."` 为空；要轮询 `content query --uri content://<pkg>.CodeLocatorProvider` 拿到 `AsyncResult=FP:...`。`BroadcastAction.buildCmd`（`device/action/BroadcastAction.java:104-106`）在 `CodeLocatorUserConfig.isAsyncBroadcast()` 为 true 时**自动**给 args 注入 `KEY_ASYNC=true`；反向 skill 直接发广播时**应显式控制** `codeLocator_save_async` 字段，不要假设默认行为。
7. **`getMaxBroadcastTransferLength()` 默认值** = 240000（240KB），定义在 SDK 端 `CodeLocatorConfig.java:22`，Builder 可覆盖。超过该长度时 SDK 强制走 FP 文件回传。

---

## 7. 已澄清事项（原 ❓ 列表的回填）

- **`DeleteFileAction`**：`super(ACTION.DELETE_FILE, filePath)`，对应命令 `rm <path>`（**不带 `-f`**）。
- **`UnInstallApkAction`**：源码内部 `super(ACTION.INSTALL, pkgName)`——**注意：实际写的是 INSTALL 而非 UNINSTALL，这是 SDK 端的死代码 bug**。整个仓库 grep 0 调用方，未来如要启用 `adb uninstall`，需先把 type 改为 `ACTION.UNINSTALL`。
- **`ACTION_OPERATE_CUSTOM_FILE` 的设备端处理函数**：`CodeLocatorApp/CodeLocatorCore` 内 grep 全 0 命中，**SDK 内置 Receiver 不处理此 action**。要响应必须靠业务方实现 `ICodeLocatorProcessor.processIntentAction` + 在 `providerRegisterAction` 里返回该 action。属业务方扩展点，不是默认能力。
- **`EditType.GET_CLASS_INFO`（GCI）**：SDK 端有 `GetClassInfoAction.java` 作 `ApplicationAction` 处理（type=`P`，value=`InvokeInfo` JSON），用于反射读静态字段 / 调静态方法。IDE 端尚未暴露入口，属"SDK 已实现、IDE 待暴露"。
- **`getMaxBroadcastTransferLength()` 默认值**：240000（240KB），见 SDK 端 `CodeLocatorConfig.java:22` 的 `DEFAULT_MAX_BROADCAST_TRANSFER_LENGTH`。
- **设备端写文件目录**：见上文 §6 第 4 条，已重写。
