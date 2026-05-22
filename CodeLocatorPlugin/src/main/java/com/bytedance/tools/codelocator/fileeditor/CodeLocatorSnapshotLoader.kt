package com.bytedance.tools.codelocator.fileeditor

import com.bytedance.tools.codelocator.model.CodeLocatorInfo
import com.bytedance.tools.codelocator.model.SchemaInfo
import com.bytedance.tools.codelocator.model.ShowInfo
import com.bytedance.tools.codelocator.model.WApplication
import com.bytedance.tools.codelocator.model.WView
import com.bytedance.tools.codelocator.parser.JumpParser
import com.bytedance.tools.codelocator.utils.GsonUtils
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.vfs.VirtualFile
import java.awt.image.BufferedImage
import java.io.ByteArrayInputStream
import java.io.DataInputStream
import java.io.EOFException
import java.util.concurrent.CompletableFuture
import javax.imageio.ImageIO

object CodeLocatorSnapshotLoader {
    const val MAX_FILE_BYTES: Long = 256L * 1024 * 1024

    private const val MAX_MAGIC_HEADER_LENGTH = 64
    private val MAGIC_HEADER_BYTES = "CodeLocator".toByteArray(Charsets.UTF_8)

    @JvmStatic
    fun load(file: VirtualFile): Result<CodeLocatorInfo> {
        if (file.length > MAX_FILE_BYTES) {
            return Result.failure(
                SnapshotLoadException.FileTooLarge(
                    fileName = file.name,
                    actualBytes = file.length,
                    limitBytes = MAX_FILE_BYTES,
                ),
            )
        }

        val bytes = try {
            file.contentsToByteArray()
        } catch (t: Throwable) {
            if (t is ProcessCanceledException) {
                throw t
            }
            return Result.failure(SnapshotLoadException.IoFailure(file.name, t))
        }

        validateMagicHeader(file.name, bytes)?.let { error ->
            return Result.failure(error)
        }

        val info = try {
            parseWithoutLeakingGlobalState(bytes)
        } catch (t: Throwable) {
            if (t is ProcessCanceledException) {
                throw t
            }
            return Result.failure(SnapshotLoadException.ParseFailure(file.name, t))
        }

        if (info == null) {
            return Result.failure(SnapshotLoadException.ParseFailure(file.name))
        }

        return Result.success(info)
    }

    @JvmStatic
    fun loadAsync(file: VirtualFile): CompletableFuture<Result<CodeLocatorInfo>> {
        val future = CompletableFuture<Result<CodeLocatorInfo>>()
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                future.complete(load(file))
            } catch (t: Throwable) {
                if (t is ProcessCanceledException) {
                    future.completeExceptionally(t)
                    return@executeOnPooledThread
                }
                future.complete(Result.failure(SnapshotLoadException.UnexpectedFailure(file.name, t)))
            }
        }
        return future
    }

    private fun validateMagicHeader(
        fileName: String,
        bytes: ByteArray,
    ): SnapshotLoadException.InvalidMagicHeader? {
        return try {
            DataInputStream(ByteArrayInputStream(bytes)).use { input ->
                val tagLength = input.readInt()
                if (tagLength <= 0 || tagLength > MAX_MAGIC_HEADER_LENGTH) {
                    return SnapshotLoadException.InvalidMagicHeader(fileName)
                }

                val tagBytes = ByteArray(tagLength)
                input.readFully(tagBytes)
                if (!tagBytes.contentEquals(MAGIC_HEADER_BYTES)) {
                    return SnapshotLoadException.InvalidMagicHeader(fileName)
                }
            }
            null
        } catch (_: EOFException) {
            SnapshotLoadException.InvalidMagicHeader(fileName)
        }
    }

    private fun parseWithoutLeakingGlobalState(bytes: ByteArray): CodeLocatorInfo? {
        DataInputStream(ByteArrayInputStream(bytes)).use { input ->
            val tagLength = input.readInt()
            if (tagLength <= 0 || tagLength > MAX_MAGIC_HEADER_LENGTH) {
                return null
            }

            val tagBytes = ByteArray(tagLength)
            input.readFully(tagBytes)
            if (!tagBytes.contentEquals(MAGIC_HEADER_BYTES)) {
                return null
            }

            val versionLength = input.readInt()
            if (versionLength < 0) {
                return null
            }
            input.skipFully(versionLength)

            val appLength = input.readInt()
            if (appLength <= 0) {
                return null
            }

            val appBytes = ByteArray(appLength)
            input.readFully(appBytes)
            val application = GsonUtils.sGson.fromJson(String(appBytes, Charsets.UTF_8), WApplication::class.java)
                ?: return null
            restoreApplicationStructInfo(application)

            val imageBytes = input.readBytes()
            val image = ImageIO.read(ByteArrayInputStream(imageBytes)) ?: return null
            return CodeLocatorInfo(application, image)
        }
    }

    private fun restoreApplicationStructInfo(application: WApplication) {
        application.restoreAllStructInfo()
        application.showInfos?.sortWith(compareByDescending<ShowInfo> { it.showTime })
        application.schemaInfos?.sortWith(compareBy<SchemaInfo> { it.schema })
        application.activity?.let { activity ->
            restoreViewJumpInfo(activity.decorViews)
            activity.startInfo?.let { startInfo ->
                activity.openActivityJumpInfo = JumpParser.getSingleJumpInfo(startInfo)
            }
        }
        application.showInfos?.forEach { showInfo ->
            showInfo.jumpInfo = JumpParser.getSingleJumpInfo(showInfo.showInfo)
        }
    }

    private fun restoreViewJumpInfo(views: List<WView>?) {
        views?.forEach { restoreViewJumpInfo(it) }
    }

    private fun restoreViewJumpInfo(view: WView) {
        view.xmlJumpInfo = JumpParser.getXmlJumpInfo(view.xmlTag, view.idStr)
        view.clickJumpInfo = JumpParser.getJumpInfo(view.clickTag)
        view.touchJumpInfo = JumpParser.getJumpInfo(view.touchTag)
        view.findViewJumpInfo = JumpParser.getJumpInfo(view.findViewByIdTag)
        repeat(view.childCount) { index ->
            view.getChildAt(index)?.let { child ->
                restoreViewJumpInfo(child)
            }
        }
    }

    private fun DataInputStream.skipFully(byteCount: Int) {
        var remaining = byteCount.toLong()
        while (remaining > 0) {
            val skipped = skip(remaining)
            if (skipped <= 0) {
                throw EOFException()
            }
            remaining -= skipped
        }
    }

    sealed class SnapshotLoadException(
        message: String,
        cause: Throwable? = null,
    ) : Exception(message, cause) {
        class FileTooLarge(
            fileName: String,
            val actualBytes: Long,
            val limitBytes: Long,
        ) : SnapshotLoadException(
            message = "文件 $fileName 大小为 $actualBytes 字节，超过限制 $limitBytes 字节",
        )

        class InvalidMagicHeader(
            fileName: String,
        ) : SnapshotLoadException(
            message = "文件 $fileName 的 magic header 不匹配",
        )

        class ParseFailure(
            fileName: String,
            cause: Throwable? = null,
        ) : SnapshotLoadException(
            message = "文件 $fileName 解析失败",
            cause = cause,
        )

        class IoFailure(
            fileName: String,
            cause: Throwable,
        ) : SnapshotLoadException(
            message = "文件 $fileName 读取失败",
            cause = cause,
        )

        class UnexpectedFailure(
            fileName: String,
            cause: Throwable,
        ) : SnapshotLoadException(
            message = "文件 $fileName 加载失败",
            cause = cause,
        )
    }
}
