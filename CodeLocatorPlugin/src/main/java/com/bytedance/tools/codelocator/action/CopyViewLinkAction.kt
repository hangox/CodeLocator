package com.bytedance.tools.codelocator.action

import com.bytedance.tools.codelocator.model.CodeLocatorInfo
import com.bytedance.tools.codelocator.model.WApplication
import com.bytedance.tools.codelocator.model.WView
import com.bytedance.tools.codelocator.panels.CodeLocatorWindow
import com.bytedance.tools.codelocator.utils.ClipboardUtils
import com.bytedance.tools.codelocator.utils.ImageUtils
import com.bytedance.tools.codelocator.utils.Mob
import com.bytedance.tools.codelocator.utils.ResUtils
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.Project
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

class CopyViewLinkAction(
    val project: Project,
    val codeLocatorWindow: CodeLocatorWindow
) : BaseAction(
    ResUtils.getString("copy_view_link"),
    ResUtils.getString("copy_view_link"),
    ImageUtils.loadIcon("copy")
) {

    override fun isEnable(e: AnActionEvent): Boolean {
        return codeLocatorWindow.currentSelectView != null
            && codeLocatorWindow.currentApplication != null
            && codeLocatorWindow.getScreenPanel()?.screenCapImage != null
    }

    override fun actionPerformed(e: AnActionEvent) {
        val view = codeLocatorWindow.currentSelectView ?: return
        val application = codeLocatorWindow.currentApplication ?: return
        val screenCapImage = codeLocatorWindow.getScreenPanel()?.screenCapImage ?: return

        val codeLocatorInfo = CodeLocatorInfo(application, screenCapImage)
        val historyFile = ShowGrabHistoryAction.ensureCodeLocatorHistoryFile(codeLocatorInfo) ?: return

        val path = buildViewPath(view, application)

        val builder = StringBuilder("codelocator://view?")
        builder.append("file=").append(urlEncode(historyFile.absolutePath))
        if (path.isNotEmpty()) {
            builder.append("&path=").append(urlEncode(path))
        }
        view.memAddr?.takeIf { it.isNotEmpty() }?.let {
            builder.append("&memAddr=").append(urlEncode(it))
        }
        view.className?.takeIf { it.isNotEmpty() }?.let {
            builder.append("&class=").append(urlEncode(it))
        }
        view.idStr?.takeIf { it.isNotEmpty() }?.let {
            builder.append("&id=").append(urlEncode(it))
        }
        view.xmlJumpInfo?.fileName?.takeIf { it.isNotEmpty() }?.let {
            builder.append("&xml=").append(urlEncode(it))
        }

        ClipboardUtils.copyContentToClipboard(project, builder.toString())
        Mob.mob(Mob.Action.CLICK, Mob.Button.COPY_VIEW_LINK)
    }

    private fun buildViewPath(view: WView, application: WApplication): String {
        val segments = mutableListOf<String>()
        var current: WView? = view
        while (current?.parentView != null) {
            val parent = current.parentView ?: return ""
            val index = findChildIndex(parent, current)
            if (index < 0) {
                return ""
            }
            segments.add(index.toString())
            current = parent
        }
        val decorIndex = application.activity?.decorViews
            ?.indexOfFirst { it === current }
            ?.takeIf { it >= 0 }
            ?: return ""
        return buildString {
            append("decorViews/")
            append(decorIndex)
            segments.asReversed().forEach {
                append('/')
                append(it)
            }
        }
    }

    private fun findChildIndex(parent: WView, child: WView): Int {
        val children = parent.children ?: return -1
        val storedIndex = child.indexInParent
        if (storedIndex in children.indices && children[storedIndex] === child) {
            return storedIndex
        }
        return children.indexOfFirst { it === child }
    }

    private fun urlEncode(s: String): String = URLEncoder.encode(s, StandardCharsets.UTF_8.toString())
}
