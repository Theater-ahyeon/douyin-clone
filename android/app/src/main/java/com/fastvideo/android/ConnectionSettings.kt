package com.fastvideo.android

import android.app.Activity
import android.app.AlertDialog
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * The 连接设置 dialog: the only place a user can point the shell at a different backend
 * (needed for a physical device, where 10.0.2.2 does not exist).
 *
 * Input is validated by [UrlPolicy.normalize] before it is ever persisted, so a typo cannot
 * leave the app configured to an unloadable or non-http origin.
 */
object ConnectionSettings {

    fun show(activity: Activity, current: String, onSaved: (String) -> Unit, onReset: () -> Unit) {
        val density = activity.resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()

        val content = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(10), dp(22), dp(4))
        }

        val description = TextView(activity).apply {
            text = activity.getString(R.string.settings_desc)
            setTextColor(activity.getColor(R.color.shell_text_secondary))
            textSize = 13f
        }
        content.addView(description)

        val input = EditText(activity).apply {
            setText(current)
            hint = activity.getString(R.string.settings_server_hint)
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            setTextColor(activity.getColor(R.color.shell_text_primary))
            setSelectAllOnFocus(true)
            gravity = Gravity.START
        }
        content.addView(
            input,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                .apply { topMargin = dp(14) },
        )

        val currentLabel = TextView(activity).apply {
            text = activity.getString(R.string.settings_current, current)
            setTextColor(activity.getColor(R.color.shell_text_secondary))
            textSize = 12f
        }
        content.addView(
            currentLabel,
            LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                .apply { topMargin = dp(8) },
        )

        val dialog = AlertDialog.Builder(activity)
            .setTitle(R.string.settings_title)
            .setView(ScrollView(activity).apply { addView(content) })
            .setPositiveButton(R.string.settings_save, null)
            .setNeutralButton(R.string.settings_reset_default) { d, _ ->
                d.dismiss()
                onReset()
            }
            .setNegativeButton(R.string.settings_cancel, null)
            .create()

        dialog.show()
        // Override the positive button so an invalid address keeps the dialog open instead of
        // silently discarding what the user typed.
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
            val normalized = UrlPolicy.normalize(input.text.toString())
            if (normalized == null) {
                input.error = activity.getString(R.string.settings_invalid)
                input.requestFocus()
            } else {
                dialog.dismiss()
                onSaved(normalized)
            }
        }
    }
}
