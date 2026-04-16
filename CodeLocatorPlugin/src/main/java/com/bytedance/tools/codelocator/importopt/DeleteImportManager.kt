package com.bytedance.tools.codelocator.importopt

import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.project.Project
import com.intellij.psi.PsiFile
import com.intellij.psi.PsiJavaFile
import com.intellij.psi.codeStyle.JavaCodeStyleManager
import org.jetbrains.kotlin.psi.KtFile

object DeleteImportManager {

    var count = 0

    fun removeUnusedKotlinImports(currentFile: KtFile, project: Project) {
        try {
            // OptimizeImportsProcessor 可能会显示 UI 对话框（例如请求解锁文件）
            // 因此必须在 write action 外部执行，让它自己处理 write action
            val processor = com.intellij.codeInsight.actions.OptimizeImportsProcessor(project, currentFile)
            processor.run()
            count++
        } catch (e: Exception) {
            // 记录错误或优雅处理
            println("Failed to optimize imports for file: ${currentFile.name}")
        }
    }

    fun removeUnusedJavaImports(file: PsiJavaFile, project: Project) {
        WriteCommandAction.runWriteCommandAction(project) {
            val javaCodeStyleManager = JavaCodeStyleManager.getInstance(project)
            val findRedundantImports = javaCodeStyleManager.findRedundantImports(file)
            if (findRedundantImports.isNullOrEmpty()) {
                return@runWriteCommandAction
            }
            count++
            javaCodeStyleManager.removeRedundantImports(file)
        }
    }

    fun deleteUnusedImports(file: PsiFile, project: Project) {
        when (file) {
            is PsiJavaFile -> {
                removeUnusedJavaImports(file, project)
            }
            is KtFile -> {
                removeUnusedKotlinImports(file, project)
            }
        }
    }
}