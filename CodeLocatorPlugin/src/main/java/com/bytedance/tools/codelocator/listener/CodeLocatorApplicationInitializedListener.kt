package com.bytedance.tools.codelocator.listener

import com.android.ddmlib.IDevice
import com.bytedance.tools.codelocator.device.Device
import com.bytedance.tools.codelocator.device.DeviceManager
import com.bytedance.tools.codelocator.model.CodeLocatorUserConfig
import com.bytedance.tools.codelocator.model.ColorInfo
import com.bytedance.tools.codelocator.utils.*
import com.google.gson.reflect.TypeToken
import com.intellij.codeInsight.hint.HintManager
import com.intellij.codeInsight.hint.HintManagerImpl
import com.intellij.openapi.startup.StartupActivity
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.SelectionEvent
import com.intellij.openapi.editor.event.SelectionListener
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.project.ProjectManagerListener
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.TextRange
import com.intellij.ui.LightweightHint
import com.intellij.ui.awt.RelativePoint
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.jetbrains.annotations.NotNull
import java.awt.*
import java.io.File
import java.util.*
import javax.swing.*
import javax.swing.BorderFactory
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel
import kotlin.collections.ArrayList
import kotlin.collections.HashSet

class CodeLocatorApplicationInitializedListener : StartupActivity {

    private var lastSelectText: String? = null

    override fun runActivity(project: Project) {
        FileUtils.init()
        initColorInfo()
        registerEditColorListener()

        ThreadUtils.submit {
            NetUtils.fetchConfig()
        }
        
        Disposer.register(ApplicationManager.getApplication(), disposable)
        ApplicationManager.getApplication().messageBus.connect().subscribe(ProjectManager.TOPIC, object : ProjectManagerListener {
            override fun projectClosed(project: Project) {
                val currentDevice = DeviceManager.getCurrentDevice(project, true)
                if (currentDevice?.device != null) {
                    val serialNumber = currentDevice.device.serialNumber
                    CodeLocatorUserConfig.loadConfig().lastDevice = serialNumber
                    DeviceManager.onProjectClose(project)
                } else if (currentDevice == null) {
                    val device = DeviceManager.onProjectClose(project)
                    if (device != null) {
                        CodeLocatorUserConfig.loadConfig().lastDevice = device.serialNumber
                    }
                } else {
                    DeviceManager.onProjectClose(project)
                }
                CodeLocatorUserConfig.updateConfig(CodeLocatorUserConfig.loadConfig())
            }
        })
    }

    companion object {
        const val HINT_ITEM_HEIGHT = 24
        
        private var sColorInfo: List<ColorInfo>? = null
        private val mFindColorSets = HashSet<ColorInfo>()
        private var maxWidth: Int = 0
        private val disposable: Disposable = Disposer.newDisposable()

        @JvmStatic
        fun setColorInfo(colorInfo: List<ColorInfo>?) {
            if (colorInfo.isNullOrEmpty()) {
                return
            }
            sColorInfo = colorInfo
            for (c in colorInfo) {
                c.color = c.color
            }
            ThreadUtils.submit {
                try {
                    FileUtils.saveContentToFile(
                        File(FileUtils.sCodeLocatorMainDirPath, FileUtils.GRAPH_COLOR_DATA_FILE_NAME),
                        GsonUtils.sGson.toJson(colorInfo)
                    )
                } catch (t: Throwable) {
                    Log.e("保存Color数据失败", t)
                }
            }
        }

        @JvmStatic
        fun getColorInfosPanel(colorInfos: HashSet<ColorInfo>, fontMetrics: FontMetrics): JComponent {
            maxWidth = 0
            val size = colorInfos.size
            val jPanel = JPanel()
            jPanel.layout = BoxLayout(jPanel, BoxLayout.Y_AXIS)
            if (size == 1) {
                jPanel.add(getSingleColorInfoPanel(colorInfos.iterator().next(), false, fontMetrics))
            } else {
                val colorInfoArrayList = ArrayList(colorInfos)
                colorInfoArrayList.sortBy { it.colorMode }
                for (colorInfo in colorInfoArrayList) {
                    if (jPanel.componentCount != 0) {
                        jPanel.add(Box.createVerticalStrut(CoordinateUtils.TABLE_RIGHT_MARGIN))
                    }
                    jPanel.add(getSingleColorInfoPanel(colorInfo, true, fontMetrics))
                }
            }
            val panelWidth = maxWidth + 5 * CoordinateUtils.DEFAULT_BORDER / 2 + HINT_ITEM_HEIGHT * 2
            for (i in 0 until jPanel.componentCount) {
                if (jPanel.getComponent(i) is JPanel) {
                    JComponentUtils.setSize(jPanel.getComponent(i) as JComponent, panelWidth, HINT_ITEM_HEIGHT)
                    JComponentUtils.setSize(
                        ((jPanel.getComponent(i) as JComponent).getComponent(1) as JComponent),
                        maxWidth,
                        HINT_ITEM_HEIGHT
                    )
                }
            }
            JComponentUtils.setMinimumHeight(
                jPanel,
                panelWidth,
                HINT_ITEM_HEIGHT * size + (size - 1) * CoordinateUtils.TABLE_RIGHT_MARGIN
            )
            return jPanel
        }

        @JvmStatic
        fun getSingleColorInfoPanel(colorInfo: ColorInfo, needMode: Boolean, fontMetrics: FontMetrics): JComponent {
            val jPanel = JPanel()
            jPanel.layout = BoxLayout(jPanel, BoxLayout.X_AXIS)
            val displayText = (if (needMode) colorInfo.colorMode + " " else "") + ResUtils.getString(
                "color_value_format",
                CodeLocatorUtils.toHexStr(colorInfo.color)
            )
            val jLabel = JLabel(displayText)
            jPanel.add(Box.createHorizontalStrut(CoordinateUtils.DEFAULT_BORDER))
            jPanel.add(jLabel)
            val width = fontMetrics.stringWidth(displayText)
            maxWidth = maxWidth.coerceAtLeast(width)

            jPanel.add(Box.createHorizontalStrut(CoordinateUtils.DEFAULT_BORDER))

            val whiteColorPanel = createColorPanel(colorInfo, Color.WHITE)
            jPanel.add(whiteColorPanel)
            jPanel.add(Box.createHorizontalStrut(CoordinateUtils.TABLE_RIGHT_MARGIN))

            val blackColorPanel = createColorPanel(colorInfo, Color.BLACK)
            jPanel.add(blackColorPanel)
            return jPanel
        }

        @JvmStatic
        private fun createColorPanel(colorInfo: ColorInfo, backgroundColor: Color): JPanel {
            val foreGroundPanel = JPanel()
            foreGroundPanel.background = Color(colorInfo.color, true)

            val backGroundPanel = JPanel()
            JComponentUtils.setSize(backGroundPanel, HINT_ITEM_HEIGHT, HINT_ITEM_HEIGHT)
            backGroundPanel.alignmentY = 0.5f
            backGroundPanel.layout = null
            backGroundPanel.background = backgroundColor
            backGroundPanel.add(foreGroundPanel)
            foreGroundPanel.setBounds(3, 3, 18, 18)
            foreGroundPanel.border = BorderFactory.createLineBorder(Color.RED)
            return backGroundPanel
        }

        @JvmStatic
        fun getColorInfos(colorStr: String): HashSet<ColorInfo> {
            mFindColorSets.clear()
            for (i in sColorInfo?.indices ?: emptyList<Int>()) {
                if (sColorInfo?.get(i) != null && colorStr == sColorInfo?.get(i)?.colorName) {
                    sColorInfo?.get(i)?.let { mFindColorSets.add(it) }
                    println("${sColorInfo?.get(i)?.colorMode} ${sColorInfo?.get(i)?.color} ${sColorInfo?.get(i)?.colorName}")
                }
            }
            return mFindColorSets
        }

        @JvmStatic
        fun getColorInfos(): List<ColorInfo>? {
            return sColorInfo
        }
    }

    private fun registerEditColorListener() {
        EditorFactory.getInstance().eventMulticaster.addSelectionListener(object : SelectionListener {
            override fun selectionChanged(e: SelectionEvent) {
                if (!CodeLocatorUserConfig.loadConfig().isPreviewColor) {
                    return
                }
                if (e.newRange.length <= 1 || e.newRange.length > 50) {
                    lastSelectText = null
                    return
                }
                val selectText = e.editor.document.getText(e.newRange)
                if (selectText.contains("\n")) {
                    return
                }
                var text = selectText.trim()
                if (e.newRange.startOffset - 8 >= 0) {
                    text = e.editor.document.getText(TextRange(e.newRange.startOffset - 8, e.newRange.endOffset)).trim()
                }
                var colorStr: String? = null
                when {
                    text.contains("R.color.") -> {
                        colorStr = text.substring(text.indexOf("R.color.") + "R.color.".length).trim()
                    }
                    text.contains("@color/") -> {
                        colorStr = text.substring(text.indexOf("@color/") + "@color/".length).trim()
                    }
                    text.contains("name=\"") -> {
                        val lineNumber = e.editor.document.getLineNumber(e.newRange.startOffset)
                        val lineStr = e.editor.document.getText(
                            TextRange(
                                e.editor.document.getLineStartOffset(lineNumber),
                                e.editor.document.getLineEndOffset(lineNumber)
                            )
                        )
                        if (lineStr.contains("format=\"color\"")) {
                            colorStr = text.substring(text.indexOf("name=\"") + "name=\"".length).trim()
                        }
                    }
                }
                if (colorStr == null || colorStr == lastSelectText) {
                    return
                }
                if (sColorInfo == null) {
                    return
                }
                lastSelectText = colorStr
                val colorInfos = getColorInfos(colorStr)
                if (colorInfos.isEmpty()) {
                    return
                }
                val editor = e.editor
                val fontMetrics = e.editor.component.getFontMetrics(e.editor.component.font)
                val colorInfosPanel = getColorInfosPanel(colorInfos, fontMetrics)
                val lightweightHint = LightweightHint(colorInfosPanel)
                val point = HintManagerImpl.getInstanceImpl().getHintPosition(lightweightHint, editor, HintManager.ABOVE)
                point.y -= ((colorInfos.size - 1) * CoordinateUtils.TABLE_RIGHT_MARGIN + colorInfos.size * HINT_ITEM_HEIGHT + CoordinateUtils.TABLE_RIGHT_MARGIN)
                lastSelectText = null
                HintManagerImpl.getInstanceImpl().showHint(
                    colorInfosPanel,
                    RelativePoint(e.editor.component.rootPane, point),
                    HintManager.HIDE_BY_ANY_KEY or HintManager.HIDE_BY_TEXT_CHANGE or HintManager.HIDE_BY_OTHER_HINT or HintManager.HIDE_BY_SCROLLING,
                    0
                )
                Mob.mob(Mob.Action.CLICK, Mob.Button.COLOR_MODE)
            }
        }, disposable)
    }

    private fun initColorInfo() {
        val fileContent = FileUtils.getFileContent(File(FileUtils.sCodeLocatorMainDirPath, FileUtils.GRAPH_COLOR_DATA_FILE_NAME))
        if (fileContent.isNullOrEmpty()) {
            return
        }
        try {
            val colorInfos: List<ColorInfo>? = GsonUtils.sGson.fromJson(
                fileContent,
                object : TypeToken<List<ColorInfo>>() {}.type
            )
            if (colorInfos != null) {
                sColorInfo = colorInfos
            }
        } catch (t: Throwable) {
            Log.e("恢复Color失败", t)
            FileUtils.deleteFile(File(FileUtils.sCodeLocatorMainDirPath, FileUtils.GRAPH_COLOR_DATA_FILE_NAME))
        }
    }
}