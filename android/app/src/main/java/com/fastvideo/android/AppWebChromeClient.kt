package com.fastvideo.android

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView

/**
 * Everything the page can ask the *device* for lives here: camera/microphone, files, fullscreen,
 * geolocation, console output.
 */
class AppWebChromeClient(
    private val host: Host,
    private val fullscreenContainer: FullscreenContainer,
) : WebChromeClient() {

    /** Kept while the system file picker is in front of us; must always be called back. */
    private var pendingFiles: ValueCallback<Array<Uri>>? = null

    fun onChooserResult(uris: Array<Uri>?) {
        val callback = pendingFiles ?: return
        pendingFiles = null
        callback.onReceiveValue(uris?.takeIf { it.isNotEmpty() })
    }

    /** Call when the activity is torn down so the renderer never waits on a dead callback. */
    fun abandonChooser() {
        pendingFiles?.onReceiveValue(null)
        pendingFiles = null
    }

    // ---------------------------------------------------------------- media permissions

    /**
     * getUserMedia. The web app does not use it today, but the feed can gain it later, and the
     * default behaviour a user expects is "nothing is granted silently". This override grants
     * only when BOTH hold:
     *
     *  1. the requesting document origin is exactly the configured app origin, and
     *  2. the matching Android runtime permission has already been granted by the user.
     *
     * Otherwise the request is denied; when the origin *is* trusted we also nudge the user
     * through the runtime dialog so a second attempt can succeed.
     */
    override fun onPermissionRequest(request: PermissionRequest) {
        val origin = request.origin?.toString()
        if (!host.isTrusted(origin)) {
            request.deny()
            host.log("camera/mic request refused for foreign origin: ${origin ?: "<null>"}")
            return
        }
        val wanted = request.resources ?: emptyArray()
        val required = wanted.mapNotNull {
            when (it) {
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
                else -> null
            }
        }
        if (required.any { !host.hasRuntimePermission(it) }) {
            request.deny()
            host.requestRuntimePermissions(required)
            return
        }
        request.grant(wanted)
    }

    override fun onPermissionRequestCanceled(request: PermissionRequest) {
        host.log("page withdrew its media permission request")
    }

    /** Geolocation is never needed by the feed: answer "denied" instead of hanging the prompt. */
    override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
        callback.invoke(origin, false, false)
        host.log("geolocation refused for $origin")
    }

    // ---------------------------------------------------------------- file upload

    /**
     * The upload page's file input. Without this the picker never
     * opens and publishing looks broken on a phone, so it belongs in "hardened for mobile".
     */
    override fun onShowFileChooser(
        view: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        params: FileChooserParams,
    ): Boolean {
        // An earlier request must be released before we take the new one.
        abandonChooser()
        val multiple = params.mode == FileChooserParams.MODE_OPEN_MULTIPLE
        val acceptTypes = params.acceptTypes?.filter { it.isNotBlank() }?.toTypedArray()
        val pick = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            // Default to video: that is all this app uploads (see web/src/media/uploader.ts).
            type = if (acceptTypes.isNullOrEmpty()) "video/*" else "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, multiple)
            if (!acceptTypes.isNullOrEmpty()) putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes)
        }
        if (params.isCaptureEnabled) {
            host.log("capture=true requested; implicit camera capture is not wired up, using the picker")
        }
        if (!host.launchChooser(pick, REQUEST_FILE_CHOOSER)) return false
        pendingFiles = filePathCallback
        return true
    }

    // ---------------------------------------------------------------- fullscreen <video>

    /**
     * The custom-view path is how WebView asks the host to own the screen for a `<video>`
     * (the legacy `onShowCustomView` API, which every WebView version still uses). The view is
     * re-parented into [FullscreenContainer], sized to the whole window — that is what makes
     * landscape fullscreen playback work on all supported API levels instead of the video
     * staying letterboxed inside the WebView.
     */
    override fun onShowCustomView(view: View, callback: CustomViewCallback) {
        if (!fullscreenContainer.show(view, callback)) {
            callback.onCustomViewHidden()
        }
    }

    override fun onHideCustomView() {
        // The page left fullscreen by itself: the container must not re-notify the callback.
        fullscreenContainer.hideFromPage()
        host.onFullscreenVideoClosed()
    }

    // ---------------------------------------------------------------- chrome plumbing

    override fun onProgressChanged(view: WebView, newProgress: Int) {
        host.onLoadingProgress(newProgress, newProgress in 1..99)
    }

    override fun onConsoleMessage(message: ConsoleMessage): Boolean {
        if (BuildConfig.DEBUG) {
            Log.d(
                TAG,
                "js ${message.messageLevel()}: ${message.message()} " +
                    "(${message.sourceId()}:${message.lineNumber()})",
            )
        }
        return false
    }

    companion object {
        private const val TAG = NativeBridge.TAG
        const val REQUEST_FILE_CHOOSER = 0x9100
    }
}
