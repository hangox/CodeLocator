# CodeLocatorPlugin/CLAUDE.md

本目录继承仓库根目录的 `../CLAUDE.md`。这里仅补充插件模块内的工作约定，避免和根目录说明维护两份重复内容。

## 模块定位

`CodeLocatorPlugin` 是 IntelliJ IDEA / Android Studio 插件模块，负责 IDE 侧工具窗口、动作入口、设备通信、代码跳转、实时调试和发布包构建。

## 常用命令

```bash
./gradlew buildPlugin
./gradlew runIde
./gradlew publishPlugin
./gradlew signPlugin
```

从仓库根目录执行插件构建时也可以使用：

```bash
./gradlew buildPlugin
```

## 当前构建信息

- Java 目标版本：17
- 插件版本：`2.0.7`
- IDE since-build：`232`
- IDE until-build：`263.*`
- 默认开发 IDE：Android Studio `2025.1.1.14`

以上信息以 `build.gradle` 为准。

## 关键文件

- `build.gradle`：插件版本、IDE 版本、依赖和发布配置。
- `src/main/resources/META-INF/plugin.xml`：插件扩展点、动作、工具窗口和监听器注册。
- `src/main/java/com/bytedance/tools/codelocator/listener/`：启动、项目关闭和编辑器监听逻辑。
- `src/main/java/com/bytedance/tools/codelocator/panels/`：主工具窗口和各功能面板。
- `src/main/java/com/bytedance/tools/codelocator/device/`：Android 设备选择、ADB 和通信逻辑。
- `src/main/java/com/bytedance/tools/codelocator/utils/NetUtils.java`：网络请求和远程配置。
- `src/main/java/com/bytedance/tools/codelocator/utils/FileUtils.java`：本地配置、日志、历史记录和临时文件。

## 验证要求

修改插件代码后优先运行：

```bash
./gradlew buildPlugin
```

构建中已有的 deprecation warning 或 `prepareSandbox` 资源复制 warning 不一定表示失败；以 Gradle 最终是否 `BUILD SUCCESSFUL` 为准。
