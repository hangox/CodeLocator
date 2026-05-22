package com.bytedance.tools.codelocator.fileeditor

import com.bytedance.tools.codelocator.model.CodeLocatorInfo
import com.bytedance.tools.codelocator.model.WActivity
import com.bytedance.tools.codelocator.model.WApplication
import com.bytedance.tools.codelocator.model.WView
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.ui.JBSplitter
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPanel
import com.intellij.ui.components.JBScrollPane
import com.intellij.util.ui.JBUI
import java.awt.BasicStroke
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Component
import java.awt.Dimension
import java.awt.FontMetrics
import java.awt.Graphics
import java.awt.Graphics2D
import java.awt.Image
import java.awt.Rectangle
import java.awt.RenderingHints
import javax.swing.JComponent
import javax.swing.JTree
import javax.swing.SwingConstants
import javax.swing.ToolTipManager
import javax.swing.event.TreeSelectionListener
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeCellRenderer
import javax.swing.tree.DefaultTreeModel

class SnapshotEditorPanel(
    private val project: Project,
    private val virtualFile: VirtualFile,
    private val info: CodeLocatorInfo,
) : JBPanel<SnapshotEditorPanel>(BorderLayout()), Disposable {

    private val activity: WActivity? = info.wApplication?.activity?.also { it.calculateAllViewDrawInfo() }

    private val previewPanel = SnapshotImagePanel(
        image = info.image,
        application = info.wApplication,
    )

    private val treeModel = DefaultTreeModel(buildRootNode())

    private val treeSelectionListener: TreeSelectionListener = TreeSelectionListener { event ->
        val node = event?.path?.lastPathComponent as? DefaultMutableTreeNode
        previewPanel.setSelectedView(node?.userObject as? WView)
    }

    private val viewTree = JTree(treeModel).apply {
        isRootVisible = true
        showsRootHandles = true
        cellRenderer = SnapshotTreeCellRenderer()
        toolTipText = ""
        addTreeSelectionListener(treeSelectionListener)
    }

    private val splitter = JBSplitter(false, 0.5f).apply {
        border = JBUI.Borders.empty()
        firstComponent = wrap(previewPanel)
        secondComponent = wrap(JBScrollPane(viewTree).apply {
            border = JBUI.Borders.empty()
        })
    }

    init {
        name = "SnapshotEditorPanel:${project.name}:${virtualFile.name}"
        border = JBUI.Borders.empty()
        minimumSize = Dimension(0, 0)
        ToolTipManager.sharedInstance().registerComponent(viewTree)
        add(splitter, BorderLayout.CENTER)
        expandFirstLevel()
    }

    override fun dispose() {
        ToolTipManager.sharedInstance().unregisterComponent(viewTree)
        viewTree.removeTreeSelectionListener(treeSelectionListener)
        viewTree.model = DefaultTreeModel(null)
        removeAll()
    }

    private fun buildRootNode(): DefaultMutableTreeNode {
        val rootLabel = activity?.let {
            formatActivityLabel(it)
        } ?: "${virtualFile.name}（无 Activity 数据）"
        val root = DefaultMutableTreeNode(rootLabel)
        activity?.decorViews.orEmpty().forEach { root.add(buildViewNode(it)) }
        return root
    }

    private fun buildViewNode(view: WView): DefaultMutableTreeNode {
        val node = DefaultMutableTreeNode(view)
        for (index in 0 until view.childCount) {
            view.getChildAt(index)?.let { child ->
                node.add(buildViewNode(child))
            }
        }
        return node
    }

    private fun expandFirstLevel() {
        for (row in 0 until minOf(viewTree.rowCount, 8)) {
            viewTree.expandRow(row)
        }
    }

    private fun wrap(component: JComponent): JComponent {
        component.minimumSize = Dimension(0, 0)
        return JBPanel<JBPanel<*>>(BorderLayout()).apply {
            border = JBUI.Borders.empty()
            minimumSize = Dimension(0, 0)
            add(component, BorderLayout.CENTER)
        }
    }

    private class SnapshotTreeCellRenderer : DefaultTreeCellRenderer() {
        override fun getTreeCellRendererComponent(
            tree: JTree,
            value: Any?,
            selected: Boolean,
            expanded: Boolean,
            leaf: Boolean,
            row: Int,
            hasFocus: Boolean,
        ): Component {
            super.getTreeCellRendererComponent(tree, value, selected, expanded, leaf, row, hasFocus)
            val node = value as? DefaultMutableTreeNode
            val userObject = node?.userObject
            text = when (userObject) {
                is WView -> formatViewLabel(userObject)
                is WActivity -> formatActivityLabel(userObject)
                else -> userObject?.toString() ?: ""
            }
            toolTipText = when (userObject) {
                is WView -> formatViewTooltip(userObject)
                is WActivity -> userObject.className
                else -> text
            }
            return this
        }
    }

    private class SnapshotImagePanel(
        private val image: Image?,
        application: WApplication?,
    ) : JBPanel<SnapshotImagePanel>() {

        private var selectedView: WView? = null
        private val contentMetrics = ContentMetrics.from(application, image)

        init {
            minimumSize = Dimension(0, 0)
            preferredSize = Dimension(
                maxOf(320, contentMetrics.imageWidth.coerceAtLeast(0)),
                maxOf(480, contentMetrics.imageHeight.coerceAtLeast(0)),
            )
        }

        fun setSelectedView(view: WView?) {
            selectedView = view
            repaint()
        }

        override fun paintComponent(graphics: Graphics) {
            super.paintComponent(graphics)
            val g2 = graphics.create() as Graphics2D
            try {
                g2.setRenderingHint(RenderingHints.KEY_ANTIALIASING, RenderingHints.VALUE_ANTIALIAS_ON)
                g2.setRenderingHint(RenderingHints.KEY_INTERPOLATION, RenderingHints.VALUE_INTERPOLATION_BILINEAR)
                g2.color = background
                g2.fillRect(0, 0, width, height)

                if (image == null || contentMetrics.imageWidth <= 0 || contentMetrics.imageHeight <= 0) {
                    drawCenteredText(g2, "无截图数据")
                    return
                }

                val imageBounds = fitImageBounds(contentMetrics.imageWidth, contentMetrics.imageHeight)
                g2.drawImage(image, imageBounds.x, imageBounds.y, imageBounds.width, imageBounds.height, this)

                g2.color = Color(0x33, 0x33, 0x33, 0x40)
                g2.stroke = BasicStroke(1f)
                g2.drawRect(imageBounds.x, imageBounds.y, imageBounds.width, imageBounds.height)

                selectedView?.let { view ->
                    val highlight = translateBounds(view, imageBounds) ?: return@let
                    if (highlight.width > 0 && highlight.height > 0) {
                        g2.color = Color(0x12, 0x96, 0xDB, 0x33)
                        g2.fill(highlight)
                        g2.color = Color(0x12, 0x96, 0xDB)
                        g2.stroke = BasicStroke(2f)
                        g2.draw(highlight)
                    }
                }
            } finally {
                g2.dispose()
            }
        }

        private fun fitImageBounds(imageWidth: Int, imageHeight: Int): Rectangle {
            val padding = 12
            val availableWidth = (width - padding * 2).coerceAtLeast(1)
            val availableHeight = (height - padding * 2).coerceAtLeast(1)
            val scale = minOf(
                availableWidth.toDouble() / imageWidth.toDouble(),
                availableHeight.toDouble() / imageHeight.toDouble(),
            )
            val drawWidth = (imageWidth * scale).toInt().coerceAtLeast(1)
            val drawHeight = (imageHeight * scale).toInt().coerceAtLeast(1)
            val drawX = (width - drawWidth) / 2
            val drawY = (height - drawHeight) / 2
            return Rectangle(drawX, drawY, drawWidth, drawHeight)
        }

        private fun translateBounds(view: WView, imageBounds: Rectangle): Rectangle? {
            val contentWidth = contentMetrics.contentWidth.takeIf { it > 0 } ?: return null
            val contentHeight = contentMetrics.contentHeight.takeIf { it > 0 } ?: return null
            val left = imageBounds.x + view.drawLeft * imageBounds.width / contentWidth
            val top = imageBounds.y + view.drawTop * imageBounds.height / contentHeight
            val right = imageBounds.x + view.drawRight * imageBounds.width / contentWidth
            val bottom = imageBounds.y + view.drawBottom * imageBounds.height / contentHeight
            return Rectangle(left, top, (right - left).coerceAtLeast(1), (bottom - top).coerceAtLeast(1))
        }

        private fun drawCenteredText(g2: Graphics2D, message: String) {
            g2.color = foreground
            val metrics: FontMetrics = g2.fontMetrics
            val textX = (width - metrics.stringWidth(message)) / 2
            val textY = (height - metrics.height) / 2 + metrics.ascent
            g2.drawString(message, textX.coerceAtLeast(12), textY.coerceAtLeast(24))
        }
    }

    private data class ContentMetrics(
        val imageWidth: Int,
        val imageHeight: Int,
        val contentWidth: Int,
        val contentHeight: Int,
    ) {
        companion object {
            fun from(
                application: WApplication?,
                image: Image?,
            ): ContentMetrics {
                val imageWidth = image?.getWidth(null)?.takeIf { it > 0 } ?: 0
                val imageHeight = image?.getHeight(null)?.takeIf { it > 0 } ?: 0
                val maxBounds = collectMaxBounds(application?.activity)
                val contentWidth = listOf(application?.realWidth ?: 0, maxBounds.first, imageWidth)
                    .maxOrNull()
                    ?.coerceAtLeast(1)
                    ?: 1
                val contentHeight = listOf(application?.realHeight ?: 0, maxBounds.second, imageHeight)
                    .maxOrNull()
                    ?.coerceAtLeast(1)
                    ?: 1
                return ContentMetrics(
                    imageWidth = imageWidth,
                    imageHeight = imageHeight,
                    contentWidth = contentWidth,
                    contentHeight = contentHeight,
                )
            }

            private fun collectMaxBounds(activity: WActivity?): Pair<Int, Int> {
                var maxRight = 0
                var maxBottom = 0
                activity?.decorViews.orEmpty().forEach { root ->
                    visitView(root) { view ->
                        maxRight = maxOf(maxRight, view.drawRight)
                        maxBottom = maxOf(maxBottom, view.drawBottom)
                    }
                }
                return maxRight to maxBottom
            }

            private fun visitView(view: WView, visitor: (WView) -> Unit) {
                visitor(view)
                for (index in 0 until view.childCount) {
                    view.getChildAt(index)?.let { child ->
                        visitView(child, visitor)
                    }
                }
            }
        }
    }

    companion object {
        private fun formatActivityLabel(activity: WActivity): String {
            val className = simplifyClassName(activity.className)
            return "$className (${activity.decorViews.orEmpty().size} decorViews)"
        }

        private fun formatViewLabel(view: WView): String {
            val parts = mutableListOf<String>()
            parts += simplifyClassName(view.className)
            view.idStr?.takeIf { it.isNotBlank() }?.let { parts += it }
            view.text?.takeIf { it.isNotBlank() }?.let { parts += abbreviate(it) }
            parts += "${view.visibility} ${view.realWidth}×${view.realHeight}"
            return parts.joinToString(" · ")
        }

        private fun formatViewTooltip(view: WView): String {
            val className = view.className ?: "UnknownView"
            val idPart = view.idStr?.takeIf { it.isNotBlank() } ?: "no-id"
            val textPart = view.text?.takeIf { it.isNotBlank() }?.let { " text=${abbreviate(it, 80)}" } ?: ""
            return "$className [$idPart] (${view.drawLeft}, ${view.drawTop})-${view.realWidth}×${view.realHeight}$textPart"
        }

        private fun simplifyClassName(className: String?): String {
            if (className.isNullOrBlank()) {
                return "UnknownView"
            }
            return className.substringAfterLast('.')
        }

        private fun abbreviate(
            text: String,
            maxLength: Int = 24,
        ): String {
            val singleLine = text.replace('\n', ' ')
            return if (singleLine.length <= maxLength) {
                singleLine
            } else {
                singleLine.take(maxLength - 1) + "…"
            }
        }
    }
}
