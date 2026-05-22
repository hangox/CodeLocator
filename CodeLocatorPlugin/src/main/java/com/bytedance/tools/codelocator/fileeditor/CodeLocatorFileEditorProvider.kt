package com.bytedance.tools.codelocator.fileeditor

import com.bytedance.tools.codelocator.model.CodeLocatorInfo
import com.intellij.openapi.editor.Document
import com.intellij.openapi.fileEditor.AsyncFileEditorProvider
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorLocation
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.fileEditor.FileEditorStateLevel
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import java.awt.BorderLayout
import java.beans.PropertyChangeListener
import java.io.DataInputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.CancellationException
import javax.swing.JComponent
import javax.swing.SwingConstants
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.suspendCancellableCoroutine

class CodeLocatorFileEditorProvider : AsyncFileEditorProvider, DumbAware {

    override fun accept(project: Project, file: VirtualFile): Boolean {
        if (file.extension?.equals(CodeLocatorFileType.defaultExtension, ignoreCase = true) != true) {
            return false
        }
        return hasValidMagicHeader(file)
    }

    override suspend fun createFileEditor(
        project: Project,
        file: VirtualFile,
        document: Document?,
        editorCoroutineScope: CoroutineScope,
    ): FileEditor {
        return awaitLoadResultAsync(file).fold(
            onSuccess = { info -> CodeLocatorFileEditor(project, file, info) },
            onFailure = { error -> LoadFailedFileEditor(file, error) },
        )
    }

    override fun createEditor(project: Project, file: VirtualFile): FileEditor {
        return CodeLocatorSnapshotLoader.load(file).fold(
            onSuccess = { info -> CodeLocatorFileEditor(project, file, info) },
            onFailure = { error -> LoadFailedFileEditor(file, error) },
        )
    }

    override fun getEditorTypeId(): String = "com.bytedance.codelocator.snapshot-editor"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR

    private suspend fun awaitLoadResultAsync(file: VirtualFile): Result<CodeLocatorInfo> {
        return suspendCancellableCoroutine { continuation ->
            val future = CodeLocatorSnapshotLoader.loadAsync(file)
            continuation.invokeOnCancellation {
                future.cancel(true)
            }
            future.whenComplete { result, error ->
                if (!continuation.isActive) {
                    return@whenComplete
                }
                val actualError = error?.cause ?: error
                when {
                    actualError == null -> continuation.resume(result)
                    actualError is CancellationException -> continuation.resumeWithException(actualError)
                    else -> continuation.resume(Result.failure(actualError))
                }
            }
        }
    }

    private fun hasValidMagicHeader(file: VirtualFile): Boolean {
        if (file.length <= CodeLocatorInfo.INT_SIZE.toLong()) {
            return false
        }
        return runCatching {
            DataInputStream(file.inputStream.buffered()).use { inputStream ->
                val tagLength = inputStream.readInt()
                if (tagLength != CODE_LOCATOR_TAG.length) {
                    return false
                }
                val tagBytes = ByteArray(tagLength)
                inputStream.readFully(tagBytes)
                String(tagBytes, StandardCharsets.UTF_8) == CODE_LOCATOR_TAG
            }
        }.getOrDefault(false)
    }

    private class LoadFailedFileEditor(
        private val file: VirtualFile,
        error: Throwable,
    ) : UserDataHolderBase(), FileEditor {

        private val component = JBPanel<JBPanel<*>>(BorderLayout()).apply {
            add(
                JBLabel(error.message ?: "CodeLocator 快照加载失败", SwingConstants.CENTER),
                BorderLayout.CENTER,
            )
        }

        override fun getComponent(): JComponent = component

        override fun getPreferredFocusedComponent(): JComponent? = component

        override fun getName(): String = "CodeLocator 快照"

        override fun getState(level: FileEditorStateLevel): FileEditorState = FileEditorState.INSTANCE

        override fun setState(state: FileEditorState) = Unit

        override fun isModified(): Boolean = false

        override fun isValid(): Boolean = file.isValid

        override fun selectNotify() = Unit

        override fun deselectNotify() = Unit

        override fun addPropertyChangeListener(listener: PropertyChangeListener) = Unit

        override fun removePropertyChangeListener(listener: PropertyChangeListener) = Unit

        override fun getCurrentLocation(): FileEditorLocation? = null

        override fun dispose() = Unit
    }

    private companion object {
        const val CODE_LOCATOR_TAG = "CodeLocator"
    }
}
