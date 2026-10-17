# R8 rules for the FastVideo Android shell.
#
# The WebView JavaScript bridge is reached by name from injected page JavaScript, so R8 must
# not rename or remove those members (otherwise the bridge silently disappears in release).
-keepattributes *Annotation*,InnerClasses,EnclosingMethod,Signature

-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <fields>;
}
-keep class com.fastvideo.android.NativeBridge { *; }

# BuildConfig.SERVER_URL is read reflectively-free but keep the class for crash-symbol clarity.
-keep class com.fastvideo.android.BuildConfig { *; }

# Never strip the WebView clients: they implement the security policy (origin allow-list,
# permission denial, SSL cancel). Keeping them explicit avoids surprises from aggressive
# horizontal merging of lambdas into the policy methods.
-keep class com.fastvideo.android.AppWebViewClient { *; }
-keep class com.fastvideo.android.AppWebChromeClient { *; }

# Strip Kotlin null-check intrinsics' stack traces from release logs (keeps behaviour).
-dontwarn kotlin.**
