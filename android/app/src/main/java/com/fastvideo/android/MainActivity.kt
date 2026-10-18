package com.fastvideo.android

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.WindowInsets
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast

/**
 * Single-activity WebView host for the FastVideo web app.
 *
 * Responsibilities, in the order they appear below:
 *  1. resolve which backend origin to load: `--es server_url` intent extra > saved preference >
 *     `BuildConfig.SERVER_URL` > `http://10.0.2.2:8787`;
 *  2. build a WebView with the hardening settings in [configureWebView];
 *  3. keep the screen on only while the page is actually playing media ([NativeBridge]);
 *  4. survive an unreachable backend with a native retry panel instead of a white screen;
 *  5. back navigation walks the WebView history before the activity exits.
 *
 * It extends the framework [Activity] rather than AppCompatActivity on purpose: the shell has zero
 * third-party dependencies, so nothing in the APK can quietly weaken the WebView policy.
 */
class MainActivity : Activity(), Host {

    private lateinit var root: FrameLayout
    private lateinit var errorPanel: View
    private lateinit var errorDetail: TextView
    private lateinit var progressBar: ProgressBar
    private lateinit var settingsButton: ImageButton
    private lateinit var customViewContainer: FrameLayout
    private lateinit var retryButton: Button
    private lateinit var errorSettingsButton: Button

    private lateinit var serverConfig: ServerConfig
    private lateinit var fullscreen: FullscreenContainer

    private var webView: WebView? = null
    private var chromeClient: AppWebChromeClient? = null
    private var bridge: NativeBridge? = null

    private var currentUrl: String = UrlPolicy.EMULATOR_DEFAULT
    private var connectionBroken = false
    private var chromeVisible = true
    private var insets = EdgeInsets.EMPTY
    private var pendingForeignOrigin: String? = null
    private var backCallback: android.window.OnBackInvokedCallback? = null

    // ------------------------------------------------------------------ lifecycle

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        root = findViewById(R.id.shellRoot)
        errorPanel = findViewById(R.id.errorPanel)
        errorDetail = findViewById(R.id.errorDetail)
        progressBar = findViewById(R.id.loadProgress)
        settingsButton = findViewById(R.id.settingsButton)
        customViewContainer = findViewById(R.id.customViewContainer)
        retryButton = findViewById(R.id.errorRetryButton)
        errorSettingsButton = findViewById(R.id.errorSettingsButton)

        serverConfig = ServerConfig(this)
        // Debug builds only: chrome://inspect can then see the feed's DOM.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)

        fullscreen = FullscreenContainer(
            container = customViewContainer,
            pageView = { webView },
            onEnter = { setChromeVisible(false) },
            onExit = { setChromeVisible(true) },
        )

        settingsButton.setOnClickListener { showSettings() }
        errorSettingsButton.setOnClickListener { showSettings() }
        retryButton.setOnClickListener { retry() }

        applyWindowInsets()
        registerBackHandling()

        currentUrl = resolveStartUrl(intent)
        buildWebView()

        // restoreState/saveState are the Bundle overloads that return the WebBackForwardList;
        // a null result means there was no usable state, so load fresh.
        val restoredHistory = savedInstanceState?.let { state -> webView?.restoreState(state) }
        if (restoredHistory != null) {
            savedInstanceState?.getString(STATE_URL)?.let { currentUrl = it }
        } else {
            load(currentUrl)
        }
        askBeforeAdoptingForeignOrigin()
    }

    override fun onNewIntent(intent: Intent?) {
        super.onNewIntent(intent)
        setIntent(intent)
        val resolved = resolveStartUrl(intent)
        if (UrlPolicy.originOf(resolved) != UrlPolicy.originOf(currentUrl)) load(resolved)
        askBeforeAdoptingForeignOrigin()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString(STATE_URL, currentUrl)
        webView?.saveState(outState)
        super.onSaveInstanceState(outState)
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
        webView?.resumeTimers()
        // The common flow is "the app was opened before the backend was up": retry on return.
        if (connectionBroken) retry()
    }

    override fun onPause() {
        bridge?.onActivityPause()
        webView?.onPause()
        webView?.pauseTimers()
        super.onPause()
    }

    override fun onDestroy() {
        backCallback?.let { callback ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                runCatching { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(callback) }
            }
        }
        backCallback = null
        chromeClient?.abandonChooser()
        chromeClient = null
        webView?.let { dead ->
            root.removeView(dead)
            runCatching { dead.destroy() }
        }
        webView = null
        bridge = null
        super.onDestroy()
    }

    /** Receives `<input type="file">` results requested by [AppWebChromeClient.onShowFileChooser]. */
    @Suppress("DEPRECATION")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != AppWebChromeClient.REQUEST_FILE_CHOOSER) return
        val client = chromeClient ?: return
        if (resultCode != RESULT_OK) {
            client.onChooserResult(null)
            return
        }
        client.onChooserResult(pickedUris(data))
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_MEDIA_PERMISSION) return
        val refused = permissions
            .filterIndexed { index, _ -> grantResults.getOrNull(index) == PackageManager.PERMISSION_DENIED }
        if (refused.isNotEmpty()) {
            toast(getString(R.string.permission_rationale_message, refused.joinToString(" ")))
        }
    }

    // ------------------------------------------------------------------ WebView

    private fun buildWebView() {
        val view = WebView(this)
        configureWebView(view)
        root.addView(
            view,
            0,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT),
        )
        webView = view
    }

    /**
     * The hardening list. Each line is chosen so the configured page behaves like a browser tab
     * and nothing else gets a foothold; see android/README.md for the full posture table.
     */
    private fun configureWebView(view: WebView) {
        view.setBackgroundColor(Color.BLACK)
        view.isVerticalScrollBarEnabled = false
        view.isHorizontalScrollBarEnabled = false
        view.overScrollMode = View.OVER_SCROLL_NEVER

        val settings = view.settings
        with(settings) {
            // Required for the SPA: React needs JS, the session token lives in localStorage
            // (`dy:token`, see web/src/utils/storage.ts), and the feed autoplays.
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false

            // An https backend must never be able to pull http subresources; combined with the
            // network security config this keeps cleartext confined to the dev backend itself.
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW

            // No local filesystem or content-provider access from the page.
            allowFileAccess = false
            allowContentAccess = false
            // Explicitly false (they are false by default) - these two flags are how a WebView
            // turns into a local-disk reader. They stay off.
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            // The web app has its own login/register forms; keep the WebView from caching typed
            // fields or passwords to disk (on the API 24-25 platform WebView these default to on).
            @Suppress("DEPRECATION")
            saveFormData = false
            @Suppress("DEPRECATION")
            savePassword = false

            // No popups, no second window: window.open / target=_blank stays in this WebView and
            // therefore inside the origin allow-list.
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)

            // WebSQL is dead and unused by the app.
            @Suppress("DEPRECATION")
            databaseEnabled = false
            loadsImagesAutomatically = true
            textZoom = 100
            defaultTextEncodingName = "utf-8"
            // Honour <meta name="viewport" content="width=device-width, viewport-fit=cover">.
            useWideViewPort = true
            loadWithOverviewMode = true
            cacheMode = WebSettings.LOAD_DEFAULT

            // API 26+; the API 24-25 platform WebView predates Safe Browsing.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                safeBrowsingEnabled = true
            }
        }

        // The API authenticates with a Bearer header, so cookies are not needed at all; keeping
        // first-party ones enabled costs nothing but third-party ones are refused per-WebView.
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)

        val nativeBridge = NativeBridge(this).also { bridge = it }
        nativeBridge.attach(view)

        chromeClient = AppWebChromeClient(this, fullscreen).also { view.webChromeClient = it }
        view.webViewClient = AppWebViewClient(this)
    }

    private fun load(url: String) {
        val canonical = UrlPolicy.normalize(url) ?: return
        currentUrl = canonical
        connectionBroken = false
        errorPanel.visibility = View.GONE
        webView?.loadUrl(canonical)
    }

    private fun retry() {
        connectionBroken = false
        errorPanel.visibility = View.GONE
        val view = webView ?: run {
            buildWebView()
            load(currentUrl)
            return
        }
        view.stopLoading()
        view.loadUrl(currentUrl)
    }

    private fun showSettings() {
        ConnectionSettings.show(
            activity = this,
            current = currentUrl,
            onSaved = { url ->
                serverConfig.save(url)?.let { saved ->
                    load(saved)
                    toast(getString(R.string.settings_saved, saved))
                }
            },
            onReset = {
                serverConfig.clear()
                load(serverConfig.buildUrl)
            },
        )
    }

    // ------------------------------------------------------------------ origin resolution

    /**
     * Applies the resolution order. A foreign origin arriving through an [Intent] is *not*
     * adopted silently: it is parked in [pendingForeignOrigin] and only used after the user
     * confirms, because any other app on the device can send this intent to an exported activity.
     */
    private fun resolveStartUrl(intent: Intent?): String {
        val saved = serverConfig.savedUrl
        val build = serverConfig.buildUrl
        val requested = UrlPolicy.normalize(intent?.getStringExtra(ServerConfig.EXTRA_SERVER_URL))
            ?: intent?.data
                ?.takeIf { it.scheme == DEEP_LINK_SCHEME }
                ?.let { UrlPolicy.normalize(it.getQueryParameter(ServerConfig.DEEP_LINK_PARAM)) }

        if (requested == null) return UrlPolicy.resolve(null, saved, build)
        if (UrlPolicy.originOf(requested) == UrlPolicy.originOf(saved ?: build)) return requested
        pendingForeignOrigin = requested
        return UrlPolicy.resolve(null, saved, build)
    }

    private fun askBeforeAdoptingForeignOrigin() {
        val requested = pendingForeignOrigin ?: return
        pendingForeignOrigin = null
        AlertDialog.Builder(this)
            .setTitle(R.string.switch_origin_title)
            .setMessage(getString(R.string.switch_origin_message, requested, currentUrl))
            .setPositiveButton(R.string.switch_origin_allow) { _, _ ->
                serverConfig.save(requested)?.let { load(it) }
            }
            .setNegativeButton(R.string.switch_origin_deny, null)
            .show()
    }

    // ------------------------------------------------------------------ back navigation

    private fun registerBackHandling() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        // The callback is fire-and-forget, so the "nothing left to pop -> leave" decision has to
        // be made here; on API 24-32 onBackPressed() covers the same logic.
        val callback = android.window.OnBackInvokedCallback {
            if (!handleBack()) finish()
        }
        backCallback = callback
        onBackInvokedDispatcher.registerOnBackInvokedCallback(
            android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
            callback,
        )
    }

    /** API 24-32 path; on 33+ the registered [android.window.OnBackInvokedCallback] is used. */
    @Deprecated("Framework back callback; API 33+ goes through OnBackInvokedCallback.")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (!handleBack()) super.onBackPressed()
    }

    /** @return true when the shell consumed the press. */
    private fun handleBack(): Boolean {
        if (fullscreen.isShowing) {
            fullscreen.requestExit()
            return true
        }
        val view = webView ?: return false
        // Hash routes are real history entries, so back walks #/video/3 -> #/feed before exiting.
        return if (view.canGoBack()) {
            view.goBack()
            true
        } else {
            false
        }
    }

    // ------------------------------------------------------------------ Host contract

    override fun isTrusted(url: String?): Boolean = UrlPolicy.isTrusted(url, currentUrl)

    override fun onLoadStarted(url: String?) {
        connectionBroken = false
    }

    override fun onLoadFinished(url: String?) {
        if (!connectionBroken) errorPanel.visibility = View.GONE
    }

    override fun onUnreachable(code: Int, description: String, failingUrl: String) {
        connectionBroken = true
        runOnUiThread {
            errorDetail.text = getString(R.string.error_detail_unreachable, currentUrl, description, code)
            errorPanel.visibility = View.VISIBLE
            onLoadingProgress(0, false)
        }
    }

    override fun onTlsError(failingUrl: String) {
        connectionBroken = true
        runOnUiThread {
            errorDetail.text = getString(R.string.error_detail_tls, getString(R.string.error_tls), failingUrl)
            errorPanel.visibility = View.VISIBLE
            onLoadingProgress(0, false)
        }
    }

    override fun onBlockedNavigation(url: String, reason: String) {
        log("blocked $url - $reason")
        toast(getString(R.string.external_blocked))
    }

    override fun onExternalNavigation(url: String) {
        AlertDialog.Builder(this)
            .setTitle(R.string.external_open_title)
            .setMessage(getString(R.string.external_open_message, url))
            .setPositiveButton(R.string.external_open_confirm) { _, _ -> openExternal(url) }
            .setNegativeButton(R.string.external_open_deny, null)
            .show()
    }

    private fun openExternal(url: String) {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent.resolveActivity(packageManager) == null) {
            toast(getString(R.string.external_blocked))
            return
        }
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            toast(getString(R.string.external_blocked))
        } catch (e: SecurityException) {
            log("browser refused: ${e.message}")
            toast(getString(R.string.external_blocked))
        }
    }

    override fun onRendererCrash() {
        runOnUiThread {
            log("WebView renderer gone; rebuilding")
            webView?.let { dead ->
                root.removeView(dead)
                runCatching { dead.destroy() }
            }
            webView = null
            chromeClient = null
            bridge = null
            buildWebView()
            toast(getString(R.string.error_renderer))
            load(currentUrl)
        }
    }

    override fun onFullscreenVideoClosed() {
        setChromeVisible(true)
    }

    override fun onLoadingProgress(percent: Int, active: Boolean) {
        runOnUiThread {
            progressBar.progress = percent
            progressBar.visibility = if (active) View.VISIBLE else View.GONE
        }
    }

    override fun hasRuntimePermission(permission: String): Boolean =
        checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

    override fun requestRuntimePermissions(permissions: List<String>) {
        if (permissions.isEmpty()) return
        requestPermissions(permissions.toTypedArray(), REQUEST_MEDIA_PERMISSION)
    }

    override fun launchChooser(intent: Intent, requestCode: Int): Boolean = try {
        if (isFinishing || isDestroyed) false
        else {
            startActivityForResult(intent, requestCode)
            true
        }
    } catch (e: ActivityNotFoundException) {
        toast(getString(R.string.chooser_missing))
        false
    }

    override fun log(message: String) {
        if (BuildConfig.DEBUG) Log.d(NativeBridge.TAG, message)
    }

    // ------------------------------------------------------------------ chrome / insets

    private fun setChromeVisible(visible: Boolean) {
        chromeVisible = visible
        applyPadding()
    }

    /**
     * API 30+ (and unavoidable on Android 15, where edge-to-edge is enforced for targetSdk 35):
     * the window goes edge-to-edge and the *shell* pads itself, so the WebView is never under a
     * cutout and the IME inset keeps `adjustResize` working. Below API 30 the framework decor
     * already insets the content view, so applying padding too would double it - hence no-op.
     */
    private fun applyWindowInsets() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return
        @Suppress("DEPRECATION")
        run {
            window.setDecorFitsSystemWindows(false)
            window.statusBarColor = Color.TRANSPARENT
            window.navigationBarColor = Color.TRANSPARENT
        }
        root.setOnApplyWindowInsetsListener { _, windowInsets ->
            val bars = windowInsets.getInsets(
                WindowInsets.Type.systemBars() or WindowInsets.Type.ime() or WindowInsets.Type.displayCutout(),
            )
            insets = EdgeInsets(bars.left, bars.top, bars.right, bars.bottom)
            applyPadding()
            windowInsets
        }
        root.requestApplyInsets()
    }

    private fun applyPadding() {
        val padding = if (chromeVisible) insets else EdgeInsets.EMPTY
        root.setPadding(padding.left, padding.top, padding.right, padding.bottom)
    }

    private fun pickedUris(data: Intent?): Array<Uri> {
        val clip: ClipData? = data?.clipData
        if (clip != null && clip.itemCount > 0) {
            return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }.toTypedArray()
        }
        return data?.data?.let { arrayOf(it) } ?: emptyArray()
    }

    private fun toast(message: String) {
        runOnUiThread { Toast.makeText(this, message, Toast.LENGTH_SHORT).show() }
    }

    private data class EdgeInsets(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        companion object {
            val EMPTY = EdgeInsets(0, 0, 0, 0)
        }
    }

    companion object {
        private const val STATE_URL = "fastvideo.state.url"
        private const val DEEP_LINK_SCHEME = "fastvideo"
        private const val REQUEST_MEDIA_PERMISSION = 0x4101
    }
}
