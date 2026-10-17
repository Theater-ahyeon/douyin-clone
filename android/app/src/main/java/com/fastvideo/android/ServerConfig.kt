package com.fastvideo.android

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences

/**
 * Owns the single SharedPreferences key that remembers which backend origin the user chose,
 * and applies the documented resolution order on top of [UrlPolicy].
 */
class ServerConfig(context: Context) {

    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    val savedUrl: String?
        get() = prefs.getString(KEY_SERVER_URL, null)

    /** @param persist store the intent-supplied value too, so a `adb --es server_url` sticks. */
    fun resolve(intent: Intent?, persistIntentExtra: Boolean): String {
        val fromIntent = UrlPolicy.normalize(intent?.getStringExtra(EXTRA_SERVER_URL))
        val effective = UrlPolicy.resolve(fromIntent, savedUrl, BuildConfig.SERVER_URL)
        if (persistIntentExtra && fromIntent != null && fromIntent != savedUrl) {
            save(fromIntent)
        }
        return effective
    }

    /** Used to tell an operator's own baked origin apart from a third party's redirect request. */
    val buildUrl: String
        get() = UrlPolicy.normalize(BuildConfig.SERVER_URL) ?: UrlPolicy.EMULATOR_DEFAULT

    fun save(url: String): String? {
        val canonical = UrlPolicy.normalize(url) ?: return null
        prefs.edit().putString(KEY_SERVER_URL, canonical).apply()
        return canonical
    }

    fun clear() {
        prefs.edit().remove(KEY_SERVER_URL).apply()
    }

    companion object {
        const val PREFS_NAME = "fastvideo_shell"
        const val KEY_SERVER_URL = "server_url"
        const val EXTRA_SERVER_URL = "server_url"
        const val DEEP_LINK_PARAM = "server_url"
    }
}
