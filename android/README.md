# Android client (WebView shell)

Native Android host for the existing full-stack app in this repo. It is a single-activity
`WebView` shell: it loads the FastVideo web app from the Node backend, and adds the things a
browser tab cannot do on a phone — autoplaying feed video, a real file picker for publishing,
fullscreen `<video>`, screen-on-while-playing, a native offline panel instead of a white screen,
and an enforced single-origin trust policy.

Nothing in `web/` or `server/` was changed: the shell treats the running backend as its only
trusted origin.

---

## 1. Prerequisites (verified on this machine)

| Requirement | Value used here |
| --- | --- |
| JDK | `C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot` (**17** — see §6) |
| Android SDK | `E:\Android\Sdk` (`ANDROID_HOME`) |
| Platform | `platforms/android-35` |
| Build tools | `35.0.0` (AGP 8.7.3 default) |
| adb | `E:\Android\Sdk\platform-tools\adb.exe` (not on PATH) |
| Gradle | **wrapper only** — `./gradlew.bat` fetches Gradle 8.11.1 itself; there is no system `gradle` |

`android/local.properties` holds the machine-specific SDK path and is **gitignored**:

```properties
sdk.dir=E\:\\Android\\Sdk
```

On a different machine either edit that file or just export `ANDROID_HOME`; AGP reads the env
var when `local.properties` is absent.

## 2. Build the APK

```bash
cd android
export JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-17.0.20.101-hotspot"
./gradlew.bat assembleDebug            # -> app/build/outputs/apk/debug/app-debug.apk
```

Git Bash note: `./gradlew.bat` works; if your shell refuses it, use
`cmd //c gradlew.bat assembleDebug`.

Other useful tasks:

```bash
./gradlew.bat testDebugUnitTest        # JVM tests for the origin policy (no device needed)
./gradlew.bat assembleRelease          # R8-minified, signed with the debug key (see app/build.gradle.kts)
./gradlew.bat lintDebug                # optional, slow on first run
node tools/gen-icons.mjs               # regenerate the launcher PNGs from math (no brand artwork)
```

Point the APK at a backend at build time instead of at runtime:

```bash
./gradlew.bat assembleDebug -PserverUrl=http://192.168.1.20:8787
```

## 3. Start the backend

```bash
cd ..
npm run build        # web/dist must exist; scripts/start.mjs refuses to run without it
npm start            # API + SPA on http://127.0.0.1:8787
```

The backend binds `127.0.0.1` by default, which is exactly why the shell's default URL is
`http://10.0.2.2:8787` — the emulator's alias for the *host machine's* loopback. For a physical
device, bind all interfaces:

```bash
DY_HOST=0.0.0.0 npm start          # Git Bash
$env:DY_HOST="0.0.0.0"; npm start  # PowerShell
```

Then find the machine's LAN address (`ipconfig | grep -A3 Wi-Fi` / `ipconfig`), e.g.
`http://192.168.1.20:8787`. Same-origin requests never need CORS, so `DY_CORS_ORIGINS` is not
required for the shell.

## 4. Install and run

### Emulator (AVD created in Android Studio, API 24+)

```bash
ADB=/e/Android/Sdk/platform-tools/adb.exe
"$ADB" devices                                  # emulator-5554 must be listed
"$ADB" install -r app/build/outputs/apk/debug/app-debug.apk
# debug builds install as com.fastvideo.android.debug (applicationIdSuffix)
"$ADB" shell am start -n com.fastvideo.android.debug/com.fastvideo.android.MainActivity
```

The default `http://10.0.2.2:8787` should just work if `npm start` is running on this machine.

### Physical device (USB, developer mode + OEM debugging on)

```bash
ADB=/e/Android/Sdk/platform-tools/adb.exe
"$ADB" devices                       # authorize the RSA prompt on the phone
"$ADB" -s <serial> install -r app/build/outputs/apk/debug/app-debug.apk
"$ADB" -s <serial> shell am start -n com.fastvideo.android.debug/com.fastvideo.android.MainActivity
```

The phone cannot see `10.0.2.2`, so tell the app where the backend lives, in any of three ways:

1. **In-app (no rebuild, persists):** tap the translucent gear at the top-left (or 连接设置 in the
   offline panel) → enter `http://<LAN-IP>:8787` → 保存并重试.
2. **Intent extra (persisted only after you confirm in-app):**
   ```bash
   "$ADB" -s <serial> shell am start -n com.fastvideo.android.debug/com.fastvideo.android.MainActivity \
     --es server_url http://192.168.1.20:8787
   ```
   The same value can arrive as a deep link:
   `"$ADB" -s <serial> shell am start -a android.intent.action.VIEW -d "fastvideo://shell?server_url=http%3A%2F%2F192.168.1.20%3A8787"`.
3. **Baked in:** `./gradlew.bat assembleDebug -PserverUrl=http://192.168.1.20:8787`.

Resolution order at startup: **intent extra → saved preference → `BuildConfig.SERVER_URL` →
`http://10.0.2.2:8787`**. Whichever wins, the value is re-validated by `UrlPolicy.normalize`
(http/https only, host required, no credentials/fragment/`..`).

### Logs

```bash
"$ADB" -s <serial> logcat -s FastVideoShell chromium WebView | head -60
```

Debug builds log page console messages as `js info: ...` from `FastVideoShell` and enable
`WebView.setWebContentsDebuggingEnabled(true)`, so `chrome://inspect` can attach.

## 5. WebView security posture

`MainActivity.configureWebView` (settings) + `AppWebViewClient` (navigation) +
`AppWebChromeClient` (device capabilities) + `UrlPolicy` (origin math, unit-tested).

| Setting | Value | Why |
| --- | --- | --- |
| `javaScriptEnabled` | `true` | React SPA |
| `domStorageEnabled` | `true` | auth token lives in `localStorage` under `dy:token` (`web/src/utils/storage.ts`) |
| `mediaPlaybackRequiresUserGesture` | `false` | feed autoplays on scroll |
| `mixedContentMode` | `MIXED_CONTENT_NEVER_ALLOW` | an https origin can never downgrade to http subresources |
| `allowFileAccess` / `allowContentAccess` | `false` | no local disk, no `content://` browsing |
| `allowFileAccessFromFileURLs` / `allowUniversalAccessFromFileURLs` | explicitly `false`, **never enabled** | these two are how a WebView becomes a filesystem reader |
| `javaScriptCanOpenWindowsAutomatically` / `setSupportMultipleWindows` | `false` | no popups, no second window outside the origin allow-list |
| `safeBrowsingEnabled` | `true` on API 26+ | absent on the API 24-25 platform WebView |
| `databaseEnabled` | `false` | WebSQL unused |
| third-party cookies | refused (`setAcceptThirdPartyCookies(view, false)`) | the API uses a `Bearer` header, cookies are not needed |
| `useWideViewPort` + `loadWithOverviewMode` | `true` | honours the app's `viewport-fit=cover` meta |
| background | `#000000`, plus a black `windowBackground` | never flashes white |

**Origin policy** (`AppWebViewClient.shouldOverrideUrlLoading`)

* same configured origin → load in place (the SPA's `#/...` hash routes are same-document and
  never reach the callback; `blob:` URLs derived from the app origin are unwrapped and compared);
* off-origin `http(s)` **with** a user gesture → refused inline, offered to the system browser
  behind a confirmation dialog that shows the target URL;
* off-origin `http(s)` **without** a user gesture (script-driven redirect) → blocked, so a feed
  page cannot re-point the shell and its `localStorage` session at another host;
* `javascript:`, `data:`, `file:`, `content:`, `view-source:` → blocked, never executed;
* `mailto:` / `tel:` / `intent:` / anything else → blocked (not forwarded).

**Failure handling**

* `onReceivedError` on the main frame → native 无法连接到服务器 panel with the URL, the platform
  error text, 重试 and 连接设置. No blank white screen.
* `onReceivedHttpError` (5xx, main frame) → same panel.
* `onReceivedSslError` → `handler.cancel()`. There is deliberately **no** "continue anyway".
* `onRenderProcessGone` (API 26+) → the dead WebView is removed and rebuilt, then reloaded; a
  decoder OOM cannot take the process with it.
* `onResume` retries automatically when the last load failed (app opened before the backend).

**Device capabilities**

* `onPermissionRequest`: granted **only** when the requesting document origin equals the
  configured origin **and** the matching Android runtime permission (CAMERA / RECORD_AUDIO) is
  already granted. Otherwise `deny()` — never a silent grant. Geolocation is answered `false`.
* `onShowCustomView`/`onHideCustomView`: `<video>` fullscreen is re-parented into a container that
  fills the window, with a 退出全屏 button, and `CustomViewCallback.onCustomViewHidden()` is always
  invoked so the document cannot get stuck in fullscreen.
* `onShowFileChooser`: `ACTION_OPEN_DOCUMENT` filtered to the page's accept types (`video/*`),
  supports single/multiple, and always resolves the `ValueCallback` (including on cancel/destroy)
  so the renderer's file input never hangs.

**Keep-screen-on** — the simplest defensible approach, chosen because `web/src` is shared with the
browser build and must stay untouched: the shell injects ~20 lines of ES5 into the *trusted*
document on page start/finish (`NativeBridge.INJECTION_JS`) which listens in capture phase for
`play`/`pause`/`ended` on any `HTMLMediaElement` and calls `AndroidBridge.setKeepScreenOn(bool)`.
`FLAG_KEEP_SCREEN_ON` therefore tracks actual playback, not merely "activity resumed", and is
cleared in `onPause`/on page hide. Only two `@JavascriptInterface` methods are exported
(`setKeepScreenOn`, `onShellMessage`) and neither reads tokens, files or identifiers;
`proguard-rules.pro` keeps them so R8 cannot rename the bridge out of existence in release.

**Manifest** — `allowBackup="false"`, no `FileProvider`, no exported components other than the
launcher activity, `enableOnBackInvokedCallback="true"`, `INTERNET` is the only required
permission (camera/mic are `required="false"` and only reachable through the policy above).
Cleartext is governed by `res/xml/network_security_config.xml`: release permits it **only** for
`10.0.2.2`, `localhost`, `127.0.0.1`, `[::1]` (add your own LAN host there, or use TLS), while
`src/debug/res/xml/network_security_config.xml` permits cleartext broadly and trusts user CAs so a
debug build is usable on a handset and behind a proxy.

## 6. Versions chosen, and why

* **Gradle 8.11.1** — newest 8.x that fully supports running on **JDK 17**; the wrapper downloads it
  (no system Gradle on this machine).
* **AGP 8.7.3** — supports `compileSdk`/`targetSdk 35` without "newer than tested" warnings, requires
  Gradle ≥ 8.9 and JDK 17+ (it is **not** validated on JDK 25, which is why `JAVA_HOME` is pinned to
  the Adoptium 17 install). Default build-tools 35.0.0 is present.
* **Kotlin Android plugin 2.0.21** — pairs with Gradle 8.11.1 / AGP 8.7.x on JDK 17; `jvmTarget 17`.
* **Zero runtime dependencies** — framework `Activity`, `WebView`, `AlertDialog` only (no AndroidX, no
  Material). A shell that enforces a WebView policy is safer with nothing else in its classpath that
  could flip `allowFileAccess` or add a `WebViewClient` of its own. `junit:4.13.2` is test-only.

## 7. Layout

```
android/
├── gradlew(.bat), gradle/wrapper/            Gradle wrapper (8.11.1)
├── settings.gradle.kts, build.gradle.kts, gradle.properties
├── local.properties                          machine-specific, gitignored
├── .gitignore
├── tools/gen-icons.mjs                       regenerates res/mipmap-*/ic_launcher*.png
└── app/
    ├── build.gradle.kts, proguard-rules.pro
    └── src/
        ├── main/AndroidManifest.xml
        ├── main/java/com/fastvideo/android/
        │   ├── MainActivity.kt               host, URL resolution, back, insets, lifecycle
        │   ├── Host.kt                       contract between the WebView clients and the activity
        │   ├── UrlPolicy.kt                  origin allow-list math (unit tested)
        │   ├── ServerConfig.kt               SharedPreferences persistence + precedence
        │   ├── AppWebViewClient.kt           navigation policy, error/SSL/renderer handling
        │   ├── AppWebChromeClient.kt         permissions, file chooser, fullscreen, console
        │   ├── FullscreenContainer.kt        <video> custom view owner
        │   ├── NativeBridge.kt               @JavascriptInterface + injected keep-screen-on JS
        │   └── ConnectionSettings.kt         连接设置 dialog
        ├── main/res/                         layout, values, drawables, adaptive + PNG icons, NSC
        ├── debug/res/xml/network_security_config.xml
        └── test/java/com/fastvideo/android/UrlPolicyTest.kt
```

## 8. Runtime verification (API 35 emulator, x86_64, headless)

An emulator **was** booted for this build (`emulator-5554`, Android 15 / API 35, x86_64, headless),
the debug APK installed and the shell driven through adb. The backend ran on a spare port so it
would not fight the other agents over `8787`:

```bash
DY_PORT=8899 node scripts/start.mjs     # app pointed at http://10.0.2.2:8899
```

| Behaviour | Evidence |
| --- | --- |
| Page loads, bridge injected | logcat `FastVideoShell: page: bridge-ready`; `GET 200 static`, `GET 200 /api/feed` |
| Feed renders and video decodes | `verification/fv-2-feed.png` (a decoded frame, not an empty `<video>`), `POST 200 /api/videos/:id/views`, `GET 206 /media/*.mp4` (range requests served) |
| Keep-screen-on tracks playback | `dumpsys window windows` → `fl=KEEP_SCREEN_ON` present while playing, absent when paused, re-asserted after the retry reload |
| SPA navigation and BACK | tap 搜索 → `fv-3-search.png`; BACK #1 stayed in the app and walked the WebView history (`fv-4-back.png`), BACK #2 returned to the launcher (`fv-5-exited.png`) |
| Foreign-origin `--es server_url` is not adopted silently | `am start --es server_url https://evil.example` → 切换服务器？ confirmation dialog showing the target origin (`fv-1-dialog.png`); the app stayed on the saved origin |
| Offline panel and 重试 recovery | backend killed → `fv-8-offline-panel.png`: 无法连接到服务器, `http://10.0.2.2:8899`, `net::ERR_CONNECTION_TIMED_OUT (code -8)`, 重试 / 连接设置; backend restarted → tap 重试 → `fv-9-retry-recovered.png`, feed playing again |
| Subresource failures do not fake an outage | non-main-frame errors are logged only (`subresource error -1: /media/...mp4`), the panel stays hidden |

Two findings from that run are worth knowing:

* **The unreachable-server panel is not instantaneous on the emulator.** QEMU/SLIRP NAT does not RST
  a closed host port, it drops the SYN, so Chromium reports `ERR_CONNECTION_TIMED_OUT` after roughly
  30 s of an advancing progress bar instead of `ERR_CONNECTION_REFUSED` in a few milliseconds
  (`fv-6-offline-pending.png` and `fv-6b-offline-still-pending.png` capture the interim state — black
  with a progress bar, never white). On a real LAN where the host answers with a RST the panel appears
  immediately. This is platform behaviour; the shell deliberately does not add its own load timeout.
* **A back-handling bug was found and fixed during this pass.** Under `targetSdk 35` the
  `OnBackInvokedCallback` path is used, and the first version discarded `handleBack()`'s `Boolean`,
  so the app exited on the *first* BACK instead of walking history. It is now
  `if (!handleBack()) finish()`, and the BACK sequence above was re-verified against the rebuilt APK.

Screenshots and the captured backend access log are in `android/verification/`.

## 9. Known limitations

* Not verified because no physical handset was attached: the camera/microphone `getUserMedia` prompt
  path, TLS-failure cancellation against a real bad certificate, LAN reachability from a phone, and
  `assembleRelease` on a device. Fullscreen `<video>` and the file chooser were exercised only to the
  point where the platform callbacks are reached (the seeded app never requests them).
* **Release builds are signed with the debug keystore** — fine for self-hosting, not for a store.
* `minSdk 24` devices whose system WebView is old (un-updated Chrome 5x) may not support
  `safeBrowsingEnabled` (API 26+) — the code guards it. `localStorage`-based sessions are per
  origin: switching servers (10.0.2.2 → LAN IP) logs you out, because the token belongs to the
  other origin. That is correct behaviour, not a bug.
* No hardware back affordance for the "app is at the root route" case other than exit; `onKeyDown`
  for volume/DPAD is deliberately untouched so the page keeps its own handlers.
* The keep-screen-on injection is a shell-side workaround for a shared web bundle; if `web/` ever
  emits its own playback signals, delete `NativeBridge.INJECTION_JS` and call the bridge from there.
* Off-origin *subresources* (scripts/images/media hosted elsewhere) are logged, not blocked — strict
  CSP belongs to the web app, and blocking them in the shell would break CDN assets.
