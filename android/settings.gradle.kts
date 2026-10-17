// FastVideo Android shell — Gradle settings.
// Repositories are pinned here (FAIL_ON_PROJECT_REPOS) so module build files cannot add
// ad-hoc mirrors: only Google's Android artifacts and Maven Central are used.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "fastvideo-android"
include(":app")
