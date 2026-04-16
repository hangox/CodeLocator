package com.bytedance.tools.codelocator.utils;

import com.bytedance.tools.codelocator.model.CodeLocatorInfo;
import com.bytedance.tools.codelocator.model.WApplication;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.*;
import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * CodeLocator 文件解析工具
 * 用于将 .codeLocator 文件解析为可读的 JSON 和图片
 */
public class CodeLocatorFileParser {

    /**
     * 解析 .codeLocator 文件并导出为 JSON 和 PNG
     *
     * @param codeLocatorFilePath .codeLocator 文件路径
     * @param outputDir 输出目录
     * @return 是否成功
     */
    public static boolean parseAndExport(String codeLocatorFilePath, String outputDir) {
        try {
            File codeLocatorFile = new File(codeLocatorFilePath);
            if (!codeLocatorFile.exists()) {
                Log.e("文件不存在: " + codeLocatorFilePath);
                return false;
            }

            // 读取文件内容
            byte[] fileBytes = Files.readAllBytes(Paths.get(codeLocatorFilePath));

            // 解析为 CodeLocatorInfo
            CodeLocatorInfo info = CodeLocatorInfo.fromCodeLocatorInfo(fileBytes);
            if (info == null) {
                Log.e("无法解析文件: " + codeLocatorFilePath);
                return false;
            }

            // 创建输出目录
            File outDir = new File(outputDir);
            if (!outDir.exists()) {
                outDir.mkdirs();
            }

            // 获取基础文件名（不含扩展名）
            String baseName = codeLocatorFile.getName().replace(FileUtils.CODE_LOCATOR_FILE_SUFFIX, "");

            // 导出 JSON
            String jsonPath = outputDir + File.separator + baseName + ".json";
            exportJson(info.getWApplication(), jsonPath);

            // 导出图片
            String imagePath = outputDir + File.separator + baseName + ".png";
            exportImage(info.getImage(), imagePath);

            Log.d("导出成功:");
            Log.d("  JSON: " + jsonPath);
            Log.d("  PNG:  " + imagePath);

            return true;
        } catch (Exception e) {
            Log.e("解析文件失败", e);
            return false;
        }
    }

    /**
     * 导出 WApplication 为 JSON 文件
     */
    private static void exportJson(WApplication application, String jsonPath) throws IOException {
        String json = GsonUtils.sGson.toJson(application);

        // 格式化 JSON，使输出更易读
        String prettyJson = GsonUtils.formatJson(json);

        FileUtils.saveContentToFile(jsonPath, prettyJson);
    }

    /**
     * 导出图片为 PNG 文件
     */
    private static void exportImage(java.awt.Image image, String imagePath) throws IOException {
        if (image == null) {
            return;
        }

        BufferedImage bufferedImage;
        if (image instanceof BufferedImage) {
            bufferedImage = (BufferedImage) image;
        } else {
            bufferedImage = new BufferedImage(
                image.getWidth(null),
                image.getHeight(null),
                BufferedImage.TYPE_INT_ARGB
            );
            bufferedImage.getGraphics().drawImage(image, 0, 0, null);
        }

        ImageIO.write(bufferedImage, "PNG", new File(imagePath));
    }

    /**
     * 批量解析目录下所有 .codeLocator 文件
     */
    public static void parseDirectory(String inputDir, String outputDir) {
        File dir = new File(inputDir);
        if (!dir.exists() || !dir.isDirectory()) {
            Log.e("目录不存在: " + inputDir);
            return;
        }

        File[] files = dir.listFiles((d, name) -> name.endsWith(FileUtils.CODE_LOCATOR_FILE_SUFFIX));
        if (files == null || files.length == 0) {
            Log.d("目录下没有 .codeLocator 文件");
            return;
        }

        Log.d("找到 " + files.length + " 个文件，开始解析...");
        int successCount = 0;
        for (File file : files) {
            if (parseAndExport(file.getAbsolutePath(), outputDir)) {
                successCount++;
            }
        }
        Log.d("解析完成: " + successCount + "/" + files.length);
    }

    /**
     * 命令行入口（用于独立运行）
     */
    public static void main(String[] args) {
        if (args.length < 2) {
            System.out.println("用法:");
            System.out.println("  解析单个文件: java CodeLocatorFileParser <输入文件> <输出目录>");
            System.out.println("  批量解析:     java CodeLocatorFileParser -d <输入目录> <输出目录>");
            return;
        }

        if ("-d".equals(args[0])) {
            // 批量解析目录
            if (args.length < 3) {
                System.out.println("参数错误");
                return;
            }
            parseDirectory(args[1], args[2]);
        } else {
            // 解析单个文件
            parseAndExport(args[0], args[1]);
        }
    }
}
