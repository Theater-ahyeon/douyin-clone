package com.fastvideo.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for the origin policy the shell enforces. These run without a device, which is
 * the point: the security-critical decisions are the ones that are testable offline.
 */
class UrlPolicyTest {

    @Test
    fun `resolution order is intent then preference then build field then emulator default`() {
        val intent = "http://10.0.2.2:8787"
        val saved = "http://192.168.1.20:8787"
        val build = "http://10.0.5.5:8787"

        assertEquals(intent, UrlPolicy.resolve(intent, saved, build))
        assertEquals(saved, UrlPolicy.resolve(null, saved, build))
        assertEquals(build, UrlPolicy.resolve(null, null, build))
        assertEquals(UrlPolicy.EMULATOR_DEFAULT, UrlPolicy.resolve(null, null, null))
        // An unusable candidate is skipped, not loaded.
        assertEquals(saved, UrlPolicy.resolve("javascript:alert(1)", saved, build))
    }

    @Test
    fun `normalize accepts http(s) origins and adds a missing scheme`() {
        assertEquals("http://192.168.1.9:8787", UrlPolicy.normalize("192.168.1.9:8787"))
        assertEquals("http://10.0.2.2:8787", UrlPolicy.normalize("  http://10.0.2.2:8787/  "))
        assertEquals("https://video.example.com", UrlPolicy.normalize("https://video.example.com:443"))
        assertEquals("http://studio.local:8787/feed", UrlPolicy.normalize("http://studio.local:8787/feed"))
    }

    @Test
    fun `normalize refuses anything that is not a plain http origin`() {
        listOf(
            null,
            "",
            "   ",
            "javascript:alert(document.domain)",
            "data:text/html,<script>fetch('http://10.0.2.2:8787/api/feed')</script>",
            "file:///android_asset/index.html",
            "content://media/external/video",
            "ftp://example.com/pub",
            "http://",
            "http://user:password@10.0.2.2:8787",
            "http://10.0.2.2:8787#/steal",
            "http://10.0.2.2:8787/../../etc/passwd",
        ).forEach { bad ->
            assertNull("must reject $bad", UrlPolicy.normalize(bad))
        }
    }

    @Test
    fun `origin comparison ignores the default port and case`() {
        assertEquals("http://10.0.2.2:8787", UrlPolicy.originOf("HTTP://10.0.2.2:8787/#/feed"))
        assertEquals("http://10.0.2.2", UrlPolicy.originOf("http://10.0.2.2:80/media/a.mp4"))
        assertEquals("https://video.example.com", UrlPolicy.originOf("https://video.example.com:443/api/x"))
    }

    @Test
    fun `only the configured origin is trusted`() {
        val app = "http://10.0.2.2:8787"
        assertTrue(UrlPolicy.isTrusted("http://10.0.2.2:8787/#/feed", app))
        assertTrue(UrlPolicy.isTrusted("http://10.0.2.2:8787/api/feed?limit=12", app))
        // Deep-link / intent URLs typed with the default port still match.
        assertTrue(UrlPolicy.isTrusted("http://10.0.2.2:8787", app))
        assertFalse(UrlPolicy.isTrusted("http://10.0.2.2:8788/", app))
        assertFalse(UrlPolicy.isTrusted("https://10.0.2.2:8787/", app))
        assertFalse(UrlPolicy.isTrusted("http://evil.example/", app))
        assertFalse(UrlPolicy.isTrusted("http://10.0.2.2:8787.evil.example/", app))
        // Authority confusion: "app-origin@foreign-host" reads as the app but is a foreign host
        // with userinfo; originOf must return null so it can never compare equal (see UrlPolicy).
        assertNull(UrlPolicy.originOf("http://10.0.2.2:8787@evil.example/"))
        assertFalse(UrlPolicy.isTrusted("http://10.0.2.2:8787@evil.example/", app))
        assertFalse(UrlPolicy.isTrusted(null, app))
        assertFalse(UrlPolicy.isTrusted("http://10.0.2.2:8787", "not a url"))
    }

    @Test
    fun `blob object urls of the app origin are trusted but foreign ones are not`() {
        val app = "http://10.0.2.2:8787"
        assertTrue(UrlPolicy.isTrusted("blob:http://10.0.2.2:8787/6f2a-uuid", app))
        assertFalse(UrlPolicy.isTrusted("blob:http://evil.example/6f2a-uuid", app))
    }

    @Test
    fun `executing and local schemes are never trusted`() {
        val app = "http://10.0.2.2:8787"
        assertFalse(UrlPolicy.isTrusted("javascript:alert(1)", app))
        assertFalse(UrlPolicy.isTrusted("data:text/html,hi", app))
        assertFalse(UrlPolicy.isTrusted("file:///sdcard/Download/x.html", app))
    }

    @Test
    fun `web scheme gate keeps mailto and intent out of the browser handoff`() {
        assertTrue(UrlPolicy.isWebScheme("https://example.com/a"))
        assertFalse(UrlPolicy.isWebScheme("mailto:someone@example.com"))
        assertFalse(UrlPolicy.isWebScheme("intent://scan/#Intent"))
        assertFalse(UrlPolicy.isWebScheme("tel:10086"))
        assertFalse(UrlPolicy.isWebScheme(null))
    }
}
