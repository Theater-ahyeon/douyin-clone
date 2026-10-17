package com.fastvideo.android

import android.content.Intent

/**
 * The contract the WebView clients use to talk to the activity. Keeping it narrow means the
 * security policy lives in the clients (one reviewable file each) while all UI/state machinery
 * lives in MainActivity.
 */
interface Host {

    /** True when [url] is the configured backend origin (see [UrlPolicy.isTrusted]). */
    fun isTrusted(url: String?): Boolean

    fun onLoadStarted(url: String?)

    fun onLoadFinished(url: String?)

    /** A main-frame load failed: show the native error panel instead of a white page. */
    fun onUnreachable(code: Int, description: String, failingUrl: String)

    fun onTlsError(failingUrl: String)

    fun onBlockedNavigation(url: String, reason: String)

    /** Hand an off-origin http(s) link to the system browser (user gesture only). */
    fun onExternalNavigation(url: String)

    /** The WebView renderer died (API 26+); the host discards and rebuilds the view. */
    fun onRendererCrash()

    fun onFullscreenVideoClosed()

    fun onLoadingProgress(percent: Int, active: Boolean)

    fun hasRuntimePermission(permission: String): Boolean

    fun requestRuntimePermissions(permissions: List<String>)

    /** False when the activity is finishing and cannot start an activity for result. */
    fun launchChooser(intent: Intent, requestCode: Int): Boolean

    fun log(message: String)
}
