# 02 `.codeLocator` 文件格式

## 历史文件不是传输响应

运行时广播传输格式和历史 `.codeLocator` 格式不同：

- 广播传输：`BaseResponse` JSON -> `CodeLocatorUtils.compress` -> Base64，可能直接放在 broadcast result 的 `data="..."`，也可能写入设备临时文件并返回 `FP:<path>`。
- 历史 `.codeLocator`：IDE 本机保存的二进制容器，直接包含 `WApplication` JSON 和 PNG 截图。

历史文件由 `CodeLocatorPlugin/src/main/java/com/bytedance/tools/codelocator/model/CodeLocatorInfo.java` 写入和读取。

## 二进制布局

`CodeLocatorInfo.toBytes()` 使用 Java `DataOutputStream.writeInt`，所以所有长度都是 4 字节 big-endian int。文件布局如下：

```text
int32 tagLength
bytes tag                         // UTF-8，固定为 "CodeLocator"
int32 versionLength
bytes pluginVersion               // UTF-8，AutoUpdateUtils.getCurrentPluginVersion()
int32 applicationJsonLength
bytes applicationJson             // UTF-8，Gson 序列化 WApplication
bytes screenshotPng               // 剩余全部字节，ImageIO 写出的 PNG
```

读取逻辑在 `CodeLocatorInfo.fromCodeLocatorInfo(byte[] bytes)`：

1. 读 tag，必须等于 `CodeLocator`。
2. 读 version，目前只读取不校验。
3. 读 `WApplication` JSON 并 Gson 反序列化。
4. 剩余字节作为 PNG，通过 `ImageIO.read` 读取。
5. `application == null` 或 `image == null` 时返回 null。

因此独立脚本解析 `.codeLocator` 时，不需要解压、不需要 Base64，也不需要 Gradle 类路径；只要按上面的长度拆分即可。

## JSON 字段名

`WApplication`/`WView` 等模型使用 `@SerializedName` 的短字段名保存。例如：

- `WApplication.bd` = packageName，`b7` = activity，`b8` = file，`bi` = grabTime，`ag` = application className。
- `WActivity.ag` = className，`cj` = decorViews，`ck` = fragments，`cl` = startInfo。
- `WFragment.ag` = className，`cb` = viewMemAddr，`cc` = tag，`af` = memAddr。
- `WView.ag` = className，`ac` = idStr，`aq` = text，`af` = memAddr，`a` = children。
- `WView.ah/ai/aj/ak/al/an/ao` 分别是 clickTag、touchTag、findViewByIdTag、xmlTag、drawableTag、viewHolderTag、adapterTag。
- `WFile.c6` = name，`c7` = absoluteFilePath，`a` = children。

建议 AI 优先读取本 skill 脚本导出的 `*.normalized.json`，只有需要核对字段完整性时再看 `*.raw.json`。

## 设备侧临时文件

常量在 `CodeLocatorApp/CodeLocatorModel/src/main/java/com/bytedance/tools/codelocator/utils/CodeLocatorConstants.java`：

- `BASE_DIR_NAME = "codeLocator"`。
- `BASE_DIR_PATH = "/sdcard/codeLocator"`。
- `TMP_DATA_FILE_NAME = "codeLocator_data.txt"`。
- `TMP_IMAGE_FILE_NAME = "codeLocator_image.png"`。
- Android 30+ 传输目录：`TMP_TRANS_DATA_DIR_PATH = "/sdcard/Download/"`。
- `TMP_TRANS_DATA_FILE_PATH = "/sdcard/Download/codeLocator_data.txt"`。
- `TMP_TRANS_IMAGE_FILE_PATH = "/sdcard/Download/codeLocator_image.png"`。

应用侧 `FileUtils.getFile(context, fileName)` 在 Android 30+ 会倾向使用 `/sdcard/codeLocator`，失败时通过 MediaStore 写到 Downloads。IDE 侧 `DeviceManager.parserResult` 和截图相关逻辑会把这些文件 pull 到本机 `FileUtils.sCodeLocatorMainDirPath`。

## 本机历史目录

插件本机目录在 `CodeLocatorPlugin/src/main/java/com/bytedance/tools/codelocator/utils/FileUtils.java` 初始化：

- 主目录：`<userHome>/.codeLocator_main`。
- 历史目录：`<userHome>/.codeLocator_main/historyFile`。
- 截图目录：`<userHome>/.codeLocator_main/image`。
- 临时目录：`<userHome>/.codeLocator_main/tempFile`。

历史保存由 `ShowGrabHistoryAction.saveCodeLocatorHistory` 完成，超过 `maxHistoryCount` 时删除最旧文件。
