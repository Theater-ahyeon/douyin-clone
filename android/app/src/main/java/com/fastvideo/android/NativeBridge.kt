package com.fastvideo.android

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView

/**
 * The only JavaScript bridge the shell exposes, and the smallest one that does the job.
 *
 * Keep-screen-on strategy (simplest defensible approach, deliberately *not* a per-page API the
 * web app would have to call — web/src is shared with the browser build and must stay unchanged):
 *
 *   [INJECTION_JS] is injected into the trusted page and listens for the bubbling-in-capture
 *   `play` / `pause` / `ended` events of any HTMLMediaElement, then calls
 *   `AndroidBridge.setKeepScreenOn(true|false)`. So the flag tracks what is actually on screen,
 *   not whether the activity happens to be resumed.
 *
 * Security notes:
 *  - exactly two methods are exported, both side-effect-free apart from a window flag and a
 *    log line; nothing here reads tokens, files, contacts or device identifiers;
 *  - the bridge is attached to a WebView that can only ever load the configured origin, and the
 *    page-side injection is skipped for any other document (see AppWebViewClient);
 *  - `@JavascriptInterface` members are kept by proguard-rules.pro, otherwise R8 would rename
 *    them out of existence in the release build.
 */
class NativeBridge(private val activity: Activity) {

    private val main = Handler(Looper.getMainLooper())
    @Volatile
    private var screenOnRequested = false

    /** Called from the renderer's JavaBridge thread — hop to main before touching Window flags. */
    @JavascriptInterface
    fun setKeepScreenOn(on: Boolean) {
        if (screenOnRequested == on) return
        screenOnRequested = on
        main.post {
            if (activity.isFinishing || activity.isDestroyed) return@post
            if (on) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    @JavascriptInterface
    fun onShellMessage(message: String?) {
        if (BuildConfig.DEBUG) Log.d(TAG, "page: ${message?.take(500)}")
    }

    /** Drop the flag when the activity goes away, so a paused page cannot pin the screen. */
    fun onActivityPause() {
        screenOnRequested = false
        main.post {
            if (!activity.isFinishing) activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    fun attach(webView: WebView) {
        webView.addJavascriptInterface(this, BRIDGE_NAME)
    }

    companion object {
        const val TAG = "FastVideoShell"
        const val BRIDGE_NAME = "AndroidBridge"

        /** ES5 on purpose: the system WebView on an API 24 device may predate optional chaining. */
        val INJECTION_JS = """
            (function () {
              var B = window['$BRIDGE_NAME'];
              if (!B || window.__fastVideoShell) return;
              window.__fastVideoShell = true;
              var seq = 0, live = {}, count = 0;
              function push() { try { B.setKeepScreenOn(count > 0); } catch (e) {} }
              function mark(ev, playing) {
                var t = ev && ev.target;
                if (!t || typeof HTMLMediaElement === 'undefined') return;
                if (!(t instanceof HTMLMediaElement)) return;
                var id = t.__fvId;
                if (!id) { seq += 1; t.__fvId = seq; id = seq; }
                if (playing) { if (!live[id]) { live[id] = 1; count += 1; push(); } }
                else if (live[id]) { delete live[id]; count = count > 0 ? count - 1 : 0; push(); }
              }
              // Capture phase: media events do not bubble, but they do pass through document.
              document.addEventListener('play', function (e) { mark(e, true); }, true);
              document.addEventListener('pause', function (e) { mark(e, false); }, true);
              document.addEventListener('ended', function (e) { mark(e, false); }, true);
              document.addEventListener('visibilitychange', function () {
                if (document.hidden) { live = {}; count = 0; push(); }
              }, false);
              window.addEventListener('pagehide', function () { live = {}; count = 0; push(); }, false);
              try { B.onShellMessage('bridge-ready'); } catch (e) {}
            })();
        """.trimIndent()
    }
}
