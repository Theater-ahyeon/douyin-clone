// Root build file: declares the plugin versions once, applies nothing.
//
// Version rationale (see android/README.md):
//   - AGP 8.7.3  -> officially supports compileSdk/targetSdk 35, needs Gradle >= 8.9 and JDK 17+.
//   - Kotlin 2.0.21 -> compatible with Gradle 8.11.1 and AGP 8.7.x, runs on JDK 17.
//   - Gradle 8.11.1 -> current 8.x line that still fully supports JDK 17 (Gradle itself only
//     gained *full* JDK 25 support much later; AGP 8.7 does not support running on JDK 25).
plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
