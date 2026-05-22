package com.bytedance.tools.codelocator.fileeditor

import com.bytedance.tools.codelocator.utils.ImageUtils
import com.intellij.openapi.fileTypes.FileType
import com.intellij.openapi.vfs.VirtualFile
import javax.swing.Icon

object CodeLocatorFileType : FileType {

    override fun getName(): String = "CodeLocator"

    override fun getDescription(): String = "CodeLocator 离线快照"

    override fun getDefaultExtension(): String = "codeLocator"

    override fun getIcon(): Icon? = ImageUtils.loadIcon("codeLocator.svg")

    override fun isBinary(): Boolean = true

    override fun isReadOnly(): Boolean = true

    override fun getCharset(file: VirtualFile, content: ByteArray): String? = null
}
