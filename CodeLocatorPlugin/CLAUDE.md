# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目简介

CodeLocator 是一个强大的 Android 调试工具的 IntelliJ IDEA/Android Studio 插件。该插件提供了丰富的 Android 应用程序调试功能，包括 View 信息显示、实时编辑、代码跳转等。

## 开发环境配置

- Java 17
- Kotlin 2.1.0
- IntelliJ Platform Plugin SDK
- Gradle 构建系统

## 常用命令

### 构建相关
```bash
# 构建插件
./gradlew buildPlugin

# 运行开发环境
./gradlew runIde

# 发布插件
./gradlew publishPlugin

# 插件签名
./gradlew signPlugin
```

### 运行配置
项目包含以下 IntelliJ 运行配置：
- `CodeLocatorPlugin [buildPlugin]` - 构建插件
- `CodeLocatorPlugin [publishPlugin]` - 发布插件  
- `CodeLocatorPlugin [runIde]` - 启动开发环境
- `CodeLocatorPlugin [signPlugin]` - 插件签名

### 调试模式切换
构建脚本会根据任务自动切换调试模式：
- `runIde` 任务会将 `Log.java` 中的 `DEBUG` 设置为 `true`
- 其他任务会将 `DEBUG` 设置为 `false`

## 项目架构

### 核心包结构
- `com.bytedance.tools.codelocator.action` - 插件动作和菜单项
- `com.bytedance.tools.codelocator.panels` - UI 面板组件
- `com.bytedance.tools.codelocator.utils` - 工具类
- `com.bytedance.tools.codelocator.device` - 设备连接和通信
- `com.bytedance.tools.codelocator.processor` - 数据处理器
- `com.bytedance.tools.codelocator.views` - 自定义 UI 组件
- `com.bytedance.tools.codelocator.dialog` - 对话框组件

### 主要功能模块
1. **ToolWindow**: 主界面工具窗口 (`CodeLocatorWindowFactory`)
2. **APK 安装**: 快捷安装 APK 文件 (`InstallApkMenuAction`, `InstallApkAction`)
3. **代码搜索**: 在线代码搜索功能 (`SearchInWebAction`)
4. **设备通信**: Android 设备连接和数据获取
5. **实时调试**: View 属性实时编辑和预览

### 关键文件
- `plugin.xml` - 插件配置文件，定义扩展点、动作和工具窗口
- `build.gradle` - 构建配置，包含版本管理和依赖项
- `Log.java` - 日志系统，支持调试模式切换
- `NetUtils.java` - 网络工具类，包含服务器 URL 配置

## 构建特性

### 动态配置
- 支持通过 `local.properties` 配置自定义服务器 URL
- 构建时自动替换网络配置和调试标志
- 支持本地 IDE 覆盖配置

### 资源文件
构建过程会自动复制以下资源文件到插件包：
- `imgcopy.m` - 图片处理脚本
- `AndroidModuleTemplate.zip` - Android 模块模板
- `JarModuleTemplate.zip` - JAR 模块模板
- `codelocatorhelper.apk` - 辅助应用程序
- `restartAndroidStudio` - 重启脚本

## 版本信息

- 当前版本: 2.0.5
- 支持的 IDE 版本: 232-252.*
- 目标 Android Studio: 2025.1.1.14

## CI/CD 自动化

### GitHub Actions
项目配置了自动化构建和发布流程：

- **触发条件**: 推送到 `main` 分支时自动触发
- **构建环境**: Ubuntu + JDK 17
- **构建产物**: 自动生成插件 ZIP 包
- **自动发布**: 构建完成后自动创建 GitHub Release

### 发布流程
1. 代码推送到 `main` 分支
2. GitHub Actions 自动构建插件
3. 创建带版本号的 Git Tag
4. 上传插件 ZIP 文件到 GitHub Releases
5. 生成包含安装说明的 Release Notes

### 手动触发
可以在 GitHub Actions 页面手动触发构建流程。

## 国际化

项目支持多语言：
- 中文: `codeLocatorRes_zh_CN.properties`
- 英文: `codeLocatorRes_en_US.properties`