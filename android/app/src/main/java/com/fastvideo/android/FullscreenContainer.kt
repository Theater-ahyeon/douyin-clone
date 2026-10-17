package com.fastvideo.android

import android.graphics.Color
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient.CustomViewCallback
import android.widget.Button
import android.widget.FrameLayout

/**
 * Owns the `<video>` fullscreen custom view.
 *
 * WebView hands us a View that must be attached to the window to play in fullscreen; the shell's
 * job is to re-parent it, hide the page underneath, and - crucially - always call
 * [CustomViewCallback.onCustomViewHidden] so the document's fullscreen state does not get stuck.
 *
 * The system bars are not hidden by flag juggling; the host simply drops the shell's safe-area
 * padding while fullscreen is active, which works identically on every supported API level.
 */
class FullscreenContainer(
    private val container: FrameLayout,
    private val pageView: () -> View?,
    private val onEnter: () -> Unit,
    private val onExit: () -> Unit,
) {

    private var callback: CustomViewCallback? = null
    private var exitButton: Button? = null

    val isShowing: Boolean
        get() = callback != null

    /** @return false when a custom view is already occupying the container. */
    fun show(view: View, customViewCallback: CustomViewCallback): Boolean {
        if (isShowing) return false
        container.removeAllViews()
        (view.parent as? ViewGroup)?.removeView(view)

        container.addView(
            view,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            ),
        )
        container.visibility = View.VISIBLE
        container.setBackgroundColor(Color.BLACK)
        pageView()?.visibility = View.INVISIBLE
        onEnter()

        // Gesture navigation has no ESC: give the user a visible way out that goes through the
        // same path the page uses, so the document always learns that fullscreen ended.
        val close = Button(view.context).apply {
            text = uiText(view, R.string.fullscreen_close)
            isAllCaps = false
            alpha = 0.85f
            setPadding(dp(view, 14), dp(view, 8), dp(view, 14), dp(view, 8))
            setBackgroundResource(R.drawable.bg_button_ghost)
            setOnClickListener { requestExit() }
        }
        exitButton = close
        container.addView(
            close,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP or Gravity.END,
            ).apply {
                setMargins(dp(view, 12), dp(view, 12), dp(view, 12), dp(view, 12))
            },
        )
        close.bringToFront()
        callback = customViewCallback
        return true
    }

    /** Framework-initiated exit (the page called document.exitFullscreen()). */
    fun hideFromPage() = hide(notifyCallback = false)

    /** Shell-initiated exit (back gesture / the 退出全屏 button). */
    fun requestExit() = hide(notifyCallback = true)

    private fun hide(notifyCallback: Boolean) {
        val cb = callback ?: return
        callback = null
        exitButton = null
        container.removeAllViews()
        container.visibility = View.GONE
        pageView()?.visibility = View.VISIBLE
        onExit()
        if (notifyCallback) cb.onCustomViewHidden()
    }

    private fun dp(view: View, value: Int): Int =
        (value * view.resources.displayMetrics.density).toInt()

    private fun uiText(view: View, resId: Int): String = view.context.getString(resId)
}
