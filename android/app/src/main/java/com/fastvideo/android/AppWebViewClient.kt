package com.fastvideo.android

import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Build
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

/**
 * Navigation policy + failure reporting for the feed WebView.
 *
 * This is the file to review when asking "what may this app load?" — everything else is plumbing.
 */
class AppWebViewClient(private val host: Host) : WebViewClient() {

    /**
     * Set when a main-frame load fails, cleared when one starts. A failed load still produces
     * onPageFinished (with Chromium's error page underneath), so this flag is what decides
     * whether the native error panel stays up.
     */
    private var mainFrameFailed = false

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url?.toString() ?: return true
        val scheme = request.url?.scheme?.lowercase().orEmpty()

        // 1. The configured origin (and blob: object URLs derived from it) always renders here.
        //    Hash-route changes inside the SPA are same-document and never reach this callback.
        if (host.isTrusted(url)) return false

        // 2. Anything that can execute in the shell's own document context is refused.
        if (scheme in FORBIDDEN_SCHEMES) {
            host.onBlockedNavigation(url, "scheme \"$scheme:\" is not allowed")
            return true
        }

        // 3. Off-origin http(s): only a real user gesture may leave the app, and it leaves via
        //    the system browser instead of by navigating this WebView. A page-initiated redirect
        //    is refused, so a feed page cannot silently re-point the shell (and the origin that
        //    holds its localStorage token) at another host.
        if (scheme == "http" || scheme == "https") {
            if (!request.hasGesture()) {
                host.onBlockedNavigation(url, "off-origin navigation without a user gesture")
                return true
            }
            host.onExternalNavigation(url)
            return true
        }

        // 4. mailto:, tel:, intent:, geo: ... are not this app's business.
        host.onBlockedNavigation(url, "scheme \"$scheme:\" is not handled")
        return true
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        mainFrameFailed = false
        host.onLoadStarted(url)
        if (host.isTrusted(url)) view.evaluateJavascript(NativeBridge.INJECTION_JS, null)
    }

    override fun onPageFinished(view: WebView, url: String?) {
        if (!mainFrameFailed && host.isTrusted(url)) {
            // Idempotent; re-run so the bridge is attached even if page-start injection raced
            // document creation. addJavascriptInterface objects exist per-document.
            view.evaluateJavascript(NativeBridge.INJECTION_JS, null)
        }
        host.onLoadFinished(url)
    }

    /** API 23 signature — with minSdk 24 this is the only one that is ever called. */
    override fun onReceivedError(view: WebView, request: WebResourceRequest?, error: WebResourceError?) {
        val failing = request?.url?.toString().orEmpty()
        val description = error?.description?.toString() ?: "unreachable"
        val code = error?.errorCode ?: WebViewClient.ERROR_UNKNOWN
        if (request?.isForMainFrame == true) {
            mainFrameFailed = true
            host.onUnreachable(code, description, failing)
        } else {
            host.log("subresource error $code: $failing")
        }
    }

    override fun onReceivedHttpError(
        view: WebView,
        request: WebResourceRequest?,
        errorResponse: WebResourceResponse?,
    ) {
        val status = errorResponse?.statusCode ?: return
        // The server has an SPA fallback, so a 5xx on the main frame means a dead backend; a
        // sub-resource 404 (missing thumbnail) is not worth stealing the screen over.
        if (request?.isForMainFrame == true && status >= 500) {
            mainFrameFailed = true
            host.onUnreachable(status, "HTTP $status", request.url?.toString().orEmpty())
        }
    }

    /**
     * Never `proceed()`. A "continue anyway" button would be the usual next step, but a shell
     * that holds a logged-in session has no business minting TLS exceptions: cancel the load and
     * say why. Serve a real certificate (or use the LAN IP over http) instead.
     */
    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler?, error: SslError?) {
        mainFrameFailed = true
        handler?.cancel()
        host.onTlsError(error?.url ?: view.url.orEmpty())
    }

    /**
     * A renderer OOM under video decode must not kill the process. Returning true tells the
     * framework we own recovery; the dead view is discarded by the host.
     *
     * `onRenderProcessGone` and [RenderProcessGoneDetail] are API 26: on API 24-25 the platform
     * WebViewClient has no such method, so this override is simply never dispatched. The SDK guard
     * around `didCrash()` keeps that contract explicit instead of relying on it.
     */
    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail?): Boolean {
        val crashed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) detail?.didCrash() else null
        host.log("renderer gone (didCrash=$crashed)")
        host.onRendererCrash()
        return true
    }

    /**
     * Sub-resources are observed, not blocked: the feed legitimately pulls <video> and image
     * bytes from the backend origin, and a wrong guess here breaks playback with no visible
     * error. Mixed content (MIXED_CONTENT_NEVER_ALLOW) and the navigation policy above are the
     * enforced boundaries.
     */
    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest?): WebResourceResponse? {
        val url = request?.url?.toString() ?: return null
        val lower = url.lowercase()
        if (lower.startsWith("data:") || lower.startsWith("blob:") || lower.startsWith("about:")) return null
        if (!host.isTrusted(url)) host.log("off-origin subresource: $url")
        return null
    }

    companion object {
        private val FORBIDDEN_SCHEMES = setOf(
            "javascript", "data", "file", "content", "android_app", "view-source",
        )
    }
}
