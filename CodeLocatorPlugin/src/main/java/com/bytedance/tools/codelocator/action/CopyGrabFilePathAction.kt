package com.bytedance.tools.codelocator.action

import com.bytedance.tools.codelocator.model.CodeLocatorInfo
import com.bytedance.tools.codelocator.panels.CodeLocatorWindow
import com.bytedance.tools.codelocator.utils.ClipboardUtils
import com.bytedance.tools.codelocator.utils.ImageUtils
import com.bytedance.tools.codelocator.utils.Mob
import com.bytedance.tools.codelocator.utils.ResUtils
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project

class CopyGrabFilePathAction(
    val project: Project,
    val codeLocatorWindow: CodeLocatorWindow
) : BaseAction(
    ResUtils.getString("copy_grab_file_path"),
    ResUtils.getString("copy_grab_file_path"),
    ImageUtils.loadIcon("copy")
) {

    override fun isEnable(e: AnActionEvent): Boolean {
        return codeLocatorWindow.currentApplication != null && codeLocatorWindow.getScreenPanel()?.screenCapImage != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val application = codeLocatorWindow.currentApplication ?: return
        val screenCapImage = codeLocatorWindow.getScreenPanel()?.screenCapImage ?: return
        val codeLocatorInfo = CodeLocatorInfo(application, screenCapImage)
        val historyFile = ShowGrabHistoryAction.ensureCodeLocatorHistoryFile(codeLocatorInfo) ?: return
        ClipboardUtils.copyContentToClipboard(project, historyFile.absolutePath)
        Mob.mob(Mob.Action.CLICK, Mob.Button.COPY_GRAB_FILE_PATH)
    }
}
