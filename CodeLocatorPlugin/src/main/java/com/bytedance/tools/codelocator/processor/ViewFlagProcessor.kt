package com.bytedance.tools.codelocator.processor

import com.bytedance.tools.codelocator.model.EditFlagModel
import com.bytedance.tools.codelocator.model.EditModel
import com.bytedance.tools.codelocator.model.WView
import com.bytedance.tools.codelocator.utils.ResUtils
import com.bytedance.tools.codelocator.utils.ThreadUtils
import com.intellij.openapi.project.Project

class ViewFlagProcessor(project: Project, type: String, view: WView) : ViewValueProcessor(project, type, view) {

    companion object {
        const val VISIBILITY = "Visibility"

        const val ENABLE = "Enable"

        const val CLICKABLE = "Clickable"
    }

    override fun getHint(view: WView): String {
        return when (type) {
            VISIBILITY -> ResUtils.getString("edit_visible_tip")
            else -> ResUtils.getString("edit_enable_tip")
        }
    }

    override fun getShowValue(view: WView): String {
        return when (type) {
            VISIBILITY -> {
                when (view.visibility) {
                    'V' -> "visible"
                    'I' -> "invisible"
                    else -> "gone"
                }
            }
            CLICKABLE -> view.isClickable.toString()
            else -> view.isEnabled.toString()
        }
    }

    override fun isValid(newValue: String): Boolean {
        return when (type) {
            VISIBILITY -> {
                "GONE".equals(newValue, true)
                        || "VISIBLE".equals(newValue, true)
                        || "INVISIBLE".equals(newValue, true)
                        || "I".equals(newValue, true)
                        || "V".equals(newValue, true)
                        || "G".equals(newValue, true)
            }
            ENABLE, CLICKABLE -> "TRUE".equals(newValue, true) || "FALSE".equals(newValue, true) || "0".equals(newValue, true) || "1".equals(newValue, true)
            else -> true
        }
    }

    override fun onInputTextChange(view: WView, changeString: String) {
        super.onInputTextChange(view, changeString)
        if (type == ENABLE || type == CLICKABLE) {
            ThreadUtils.runOnUIThread {
                if ("0" == changeString) {
                    textView.text = "false"
                } else if ("1" == changeString) {
                    textView.text = "true"
                }
            }
        }
    }

    override fun getChangeModel(view: WView, newValue: String): EditModel? {
        return when (type) {
            VISIBILITY -> createEditVisibilityModel(newValue)
            ENABLE -> createEditEnableModel(newValue)
            CLICKABLE -> createEditClickableModel(newValue)
            else -> null
        }
    }

    private fun createEditVisibilityModel(newValue: String): EditModel {
        val visibility = when (newValue.uppercase()) {
            "VISIBLE", "V" -> EditFlagModel.VISIBLE
            "INVISIBLE", "I" -> EditFlagModel.INVISIBLE
            else -> EditFlagModel.GONE
        }
        return EditFlagModel(visibility, VISIBILITY)
    }

    private fun createEditEnableModel(newValue: String): EditModel {
        val enable = when (newValue.uppercase()) {
            "TRUE", "1" -> EditFlagModel.ENABLE_MASK
            else -> 0
        }
        return EditFlagModel(enable, ENABLE)
    }

    private fun createEditClickableModel(newValue: String): EditModel {
        val clickable = when (newValue.uppercase()) {
            "TRUE", "1" -> EditFlagModel.CLICKABLE_MASK
            else -> 0
        }
        return EditFlagModel(clickable, CLICKABLE)
    }

}