import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

/**
 * The backend origin baked into the APK. Override at build time with:
 *   ./gradlew assembleDebug -PserverUrl=http://192.168.1.20:8787
 * Precedence at runtime is: `--es server_url` intent extra > saved preference >
 * this build field > the emulator default (http://10.0.2.2:8787). See ServerConfig.kt.
 */
val configuredServerUrl: String = (project.findProperty("serverUrl") as String?)
    ?.trim()
    ?.trimEnd('/')
    ?.ifEmpty { null }
    ?: "http://10.0.2.2:8787"

require(Regex("""^https?://[^\s]+$""").matches(configuredServerUrl)) {
    "serverUrl must be an absolute http(s) origin, got: $configuredServerUrl"
}

android {
    namespace = "com.fastvideo.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.fastvideo.android"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"

        buildConfigField("String", "SERVER_URL", "\"$configuredServerUrl\"")
        buildConfigField("String", "DEFAULT_EMULATOR_URL", "\"http://10.0.2.2:8787\"")
    }

    buildFeatures {
        // AGP 8 does not generate BuildConfig unless explicitly asked; the server URL lives there.
        buildConfig = true
        viewBinding = false
    }

    buildTypes {
        debug {
            // Cleartext HTTP to the dev backend is expected here; the debug source set swaps
            // in a permissive network security config (src/debug/res/xml).
            isMinifyEnabled = false
            isDebuggable = true
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
            manifestPlaceholders["shellLabel"] = "FastVideo Dev"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            // No keystore is committed to the repo; a release APK signed with the debug key is
            // still a real, installable artifact for self-hosting. Replace before publishing.
            signingConfig = signingConfigs.getByName("debug")
            manifestPlaceholders["shellLabel"] = "FastVideo"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        abortOnError = false
        warningsAsErrors = false
        checkReleaseBuilds = false
    }

    packaging {
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}")
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

dependencies {
    // The shell is deliberately dependency-free: framework Activity/WebView/AlertDialog only.
    // Smaller APK, no transitive supply-chain surface, nothing that can silently re-enable
    // file access or universal access from file URLs.
    testImplementation("junit:junit:4.13.2")
}
