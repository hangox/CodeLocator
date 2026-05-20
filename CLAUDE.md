# CLAUDE.md

本文件用于指导 Claude Code / Codex / 其他代码代理在本仓库内协作。默认使用中文沟通、编写说明、日志和代码注释，除非用户明确要求使用其他语言。

## 项目概览

CodeLocator 是一个 Android 调试工具集合，仓库由两个平等的 Gradle included build 组成：

- `CodeLocatorApp`：Android Demo、SDK、模型和 Lancet 相关模块。
- `CodeLocatorPlugin`：IntelliJ IDEA / Android Studio 插件，负责 IDE 侧工具窗口、设备通信、APK 安装、代码跳转、实时调试等功能。

根目录 `settings.gradle` 通过 `includeBuild` 连接两个子项目。日常插件开发主要集中在 `CodeLocatorPlugin`。

## 分支模型

- `private-release`：当前仓库的默认分支，也是日常开发、测试和私有发布分支。该分支包含私有插件仓库发布 workflow。
- `main`：上游同步 / PR 分支。保持对上游友好，不放私有发布逻辑。
- `upstream/main`：`bytedance/CodeLocator` 上游主线。

同步原则：

- 日常开发先在 `private-release` 上提交和验证。
- 准备给上游时，只把通用实现从 `private-release` cherry-pick 到 `main`。
- 不要把 `.github/workflows/release.yml` 中的私有发布逻辑同步到上游 PR。
- 私有发布相关提交必须和源码实现提交分开，避免 cherry-pick 时污染 `main`。

## 构建命令

根目录：

```bash
./gradlew buildPlugin
./gradlew runPlugin
./gradlew buildAll
```

插件目录：

```bash
cd CodeLocatorPlugin
./gradlew buildPlugin
./gradlew runIde
```

当前插件构建使用 Java 17，插件版本在 `CodeLocatorPlugin/build.gradle` 的 `myVersion` 中维护，当前为 `2.0.7`。

## 发布说明

`private-release` 的 GitHub Actions 在 tag `v*` 推送时会：

- 构建插件 ZIP。
- 上传 GitHub Release。
- 上传到私有插件仓库。

私有仓库配置通过 GitHub Secrets 注入：

- `PLUGIN_REGISTRY_URL`
- `PLUGIN_REGISTRY_TOKEN`

不要把真实发布地址、Token 或其他凭据写入仓库文件。需要账号、Token、OTP/TOTP 时，优先使用 Bitwarden skill 获取。

## 开发注意事项

- Kotlin 代码遵循《Kotlin in Action》《Effective Kotlin》《Kotlin Coroutines by Tutorials》的风格。
- 一个文件里出现重复逻辑时，抽到统一方法或公共位置，不保留两份实现。
- macOS 上使用 `sed` 正则需要 `+` 时，使用 `sed -E`，不要写非标准的 `\+`。
- 删除文件优先使用 `trash`，除非用户明确要求使用 `rm`。
- 优先用 TypeScript 编写脚本，除非用户明确要求其他语言。
- 不要随手写使用文档；只有用户要求或任务本身需要时才新增文档。

## 关键路径

- 插件配置：`CodeLocatorPlugin/src/main/resources/META-INF/plugin.xml`
- 插件构建：`CodeLocatorPlugin/build.gradle`
- 启动逻辑：`CodeLocatorPlugin/src/main/java/com/bytedance/tools/codelocator/listener/`
- 主工具窗口：`CodeLocatorPlugin/src/main/java/com/bytedance/tools/codelocator/panels/`
- 设备通信：`CodeLocatorPlugin/src/main/java/com/bytedance/tools/codelocator/device/`
- 网络配置：`CodeLocatorPlugin/src/main/java/com/bytedance/tools/codelocator/utils/NetUtils.java`
- 文件与日志：`CodeLocatorPlugin/src/main/java/com/bytedance/tools/codelocator/utils/FileUtils.java`

## 验证要求

涉及插件代码改动时，至少运行：

```bash
cd CodeLocatorPlugin
./gradlew buildPlugin
```

构建中可能出现已有的 deprecation warning 或 `prepareSandbox` 资源复制 warning；只有任务失败或新增错误时才需要阻断提交。

## AGENTS.md

根目录的 `AGENTS.md` 应保持为指向本文件的链接，避免多份代理说明内容漂移。
