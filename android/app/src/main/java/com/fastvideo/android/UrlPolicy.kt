package com.fastvideo.android

import java.net.URI

/**
 * Every URL/origin decision the shell makes, as pure JVM code so it can be unit tested without an
 * Android device (see `app/src/test/.../UrlPolicyTest.kt`).
 *
 * The single security invariant: the WebView only ever renders the one configured origin.
 * Anything else is either handed to the system browser (on a user gesture) or refused.
 *
 * Two parsers on purpose:
 *  - [normalize] is strict, for the *configuration* value a human or an intent supplies;
 *  - [originOf] is lenient about query/fragment, because the SPA's own hash routes
 *    (`http://10.0.2.2:8787/#/video/3`) arrive through the navigation callbacks and must still be
 *    recognised as the app's origin.
 */
object UrlPolicy {

    /** Android emulator alias for the host machine's loopback; the backend binds 127.0.0.1. */
    const val EMULATOR_DEFAULT = "http://10.0.2.2:8787"

    private const val HTTP = "http"
    private const val HTTPS = "https"

    /**
     * Resolution order (highest first): the `--es server_url` intent extra, the saved
     * SharedPreferences value, `BuildConfig.SERVER_URL`, then the emulator default. Invalid
     * candidates are skipped rather than trusted.
     */
    fun resolve(intentExtra: String?, saved: String?, buildField: String?): String {
        return listOfNotNull(
            normalize(intentExtra),
            normalize(saved),
            normalize(buildField),
            normalize(EMULATOR_DEFAULT),
        ).first()
    }

    /**
     * Validates and canonicalises a supplied backend address.
     *
     *  - trims, and prepends `http://` when the scheme was omitted (`192.168.1.9:8787`);
     *  - accepts only http/https, only with a host, never with embedded credentials, a fragment,
     *    or a `..` path escape;
     *  - returns an absolute URL with the default port dropped and no trailing slash,
     *    or `null` when the input must not be loaded.
     */
    fun normalize(raw: String?): String? {
        val trimmed = raw?.trim()?.ifEmpty { return null } ?: return null
        val withScheme = if (trimmed.contains("://")) trimmed else "$HTTP://$trimmed"
        val uri = parse(withScheme) ?: return null
        val scheme = scheme(uri) ?: return null
        val host = host(uri) ?: return null
        if (uri.userInfo != null) return null
        if (uri.fragment != null) return null
        val path = uri.rawPath.orEmpty()
        if (path.contains("..")) return null
        val port = effectivePort(scheme, uri.port)
        return build(scheme, host, port, path.takeIf { it.isNotEmpty() && it != "/" })
    }

    /** `scheme://host[:port]` for a URL the WebView wants to load; null if it has no origin. */
    fun originOf(url: String?): String? {
        val uri = url?.trim()?.let(::parse) ?: return null
        val scheme = scheme(uri) ?: return null
        val host = host(uri) ?: return null
        // `http://evil.example/10.0.2.2:8787@` style authorities must not compare equal.
        if (uri.userInfo != null) return null
        return build(scheme, host, effectivePort(scheme, uri.port), null)
    }

    /**
     * True when [url] is the configured app origin. `blob:` URLs are unwrapped (the upload page
     * previews files with object URLs); `data:`, `javascript:` and `file:` are never trusted.
     */
    fun isTrusted(url: String?, configuredUrl: String?): Boolean {
        val allowed = originOf(configuredUrl) ?: return false
        val candidate = url?.trim()?.lowercase() ?: return false
        if (candidate.startsWith("data:") || candidate.startsWith("javascript:") || candidate.startsWith("file:")) {
            return false
        }
        originOf(candidate)?.let { return it == allowed }
        if (candidate.startsWith("blob:")) {
            // blob:<inner-url>:<uuid> - compare the inner origin.
            val inner = candidate.removePrefix("blob:").substringBeforeLast('/')
            return originOf(inner) == allowed
        }
        return false
    }

    /** Only http/https may be offered to a browser; everything else is refused, not forwarded. */
    fun isWebScheme(url: String?): Boolean {
        val scheme = url?.trim()?.let(::parse)?.scheme?.lowercase() ?: return false
        return scheme == HTTP || scheme == HTTPS
    }

    // ---------------------------------------------------------------------- internals

    private fun parse(value: String): URI? = runCatching { URI(value) }.getOrNull()?.takeIf { !it.isOpaque || it.scheme != null }

    private fun scheme(uri: URI): String? = uri.scheme?.lowercase()?.takeIf { it == HTTP || it == HTTPS }

    private fun host(uri: URI): String? = uri.host?.lowercase()?.trim('[', ']')?.takeIf { it.isNotEmpty() }

    /** 80/443 are implied, so `http://h:80` and `http://h` compare equal. */
    private fun effectivePort(scheme: String, port: Int): Int = when {
        port <= 0 -> -1
        scheme == HTTP && port == 80 -> -1
        scheme == HTTPS && port == 443 -> -1
        else -> port
    }

    private fun build(scheme: String, host: String, port: Int, path: String?): String {
        val hostPart = if (host.contains(':')) "[$host]" else host
        return StringBuilder().append(scheme).append("://").append(hostPart)
            .apply { if (port > 0) append(':').append(port) }
            .apply { if (path != null) append(path) }
            .toString()
    }
}
