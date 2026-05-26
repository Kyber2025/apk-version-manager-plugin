/*
 * ApkUpdater — self-hosted APK auto-update for Android.
 *
 * Pairs with the apk-version-manager backend pattern. Polls the server's
 * /apks/device/version endpoint, downloads + prompts install when a newer
 * version is available.
 *
 * Integration:
 *   1. Drop this file into your app module's source tree.
 *   2. Set API_BASE_URL + PACKAGE_PREFIX below.
 *   3. AndroidManifest.xml needs (see android-manifest-snippet.xml):
 *        - permission: REQUEST_INSTALL_PACKAGES
 *        - <provider> for FileProvider with authority "${applicationId}.fileprovider"
 *   4. res/xml/file_paths.xml needs to exist (see android-fileprovider.xml).
 *   5. From a top-level Activity (e.g. MainActivity.onResume), call:
 *        ApkUpdater.checkOnStart(this)
 *   6. (Optional) Schedule a periodic background check via WorkManager —
 *      example at bottom of this file.
 *
 * Why polling instead of FCM push: zero infra, no Firebase account, works
 * offline-with-occasional-online (which describes most internal-tool apps).
 *
 * Why NOT use Google Play update API: this whole pattern exists BECAUSE you
 * don't want to ship via Play. Don't mix the two.
 */
package com.example.myapp   // CHANGE THIS to your package

import android.app.AlertDialog
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.util.Log
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

object ApkUpdater {
    private const val TAG = "ApkUpdater"

    // ── CONFIG: change these for your project ────────────────────────────────
    /** Public base URL of your backend (no trailing slash). */
    private const val API_BASE_URL = "https://example.com"

    /** Matches the <package-prefix> portion of the filename convention.
     *  Backend's filename regex: ^([a-zA-Z0-9_-]+)-v(\d+\.\d+(?:\.\d+)?)\.apk$
     *  e.g. for filenames like "myapp-v1.2.3.apk", set this to "myapp". */
    private const val PACKAGE_PREFIX = "myapp"

    /** Don't poll more than once per N minutes. 30 = sensible default. */
    private const val MIN_POLL_INTERVAL_MS = 30L * 60 * 1000

    /** HTTP timeouts. */
    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 15_000
    // ──────────────────────────────────────────────────────────────────────────

    private val checkInFlight = AtomicBoolean(false)
    private var lastCheckMs = 0L

    /** Get this app's current versionName (set in build.gradle). */
    private fun currentVersion(ctx: Context): String {
        return try {
            ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "0.0.0"
        } catch (e: PackageManager.NameNotFoundException) {
            "0.0.0"
        }
    }

    /** Public entry: call from MainActivity.onResume() (or similar).
     *  Throttles itself so it's safe to call frequently. */
    @JvmStatic
    fun checkOnStart(ctx: Context) {
        if (checkInFlight.get()) return
        val now = System.currentTimeMillis()
        if (now - lastCheckMs < MIN_POLL_INTERVAL_MS) return
        lastCheckMs = now
        checkAsync(ctx)
    }

    /** Force a check, ignoring the throttle. Use for explicit "Check for updates" UI button. */
    @JvmStatic
    fun checkNow(ctx: Context) {
        if (checkInFlight.get()) return
        lastCheckMs = System.currentTimeMillis()
        checkAsync(ctx)
    }

    private fun checkAsync(ctx: Context) {
        Thread {
            checkInFlight.set(true)
            try {
                val info = fetchLatestInfo(ctx)
                if (info != null && info.hasUpdate) {
                    Log.i(TAG, "update available: ${info.latestVersion} (current ${currentVersion(ctx)})")
                    // Hop back to main thread to show dialog
                    android.os.Handler(ctx.mainLooper).post {
                        promptInstall(ctx, info)
                    }
                } else {
                    Log.d(TAG, "no update available")
                }
            } catch (e: Exception) {
                Log.w(TAG, "update check failed: ${e.message}")
            } finally {
                checkInFlight.set(false)
            }
        }.start()
    }

    private data class UpdateInfo(
        val hasUpdate: Boolean,
        val latestVersion: String,
        val downloadUrl: String,
        val filename: String,
        val sizeBytes: Long,
        val sha256: String,
    )

    private fun fetchLatestInfo(ctx: Context): UpdateInfo? {
        val cur = currentVersion(ctx)
        val url = URL("$API_BASE_URL/apks/device/version?currentVersion=$cur&package=$PACKAGE_PREFIX")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.requestMethod = "GET"
            if (conn.responseCode != 200) return null
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            val root = JSONObject(body)
            val hasUpdate = root.optBoolean("hasUpdate", false)
            val latest = root.optJSONObject("latest") ?: return null
            return UpdateInfo(
                hasUpdate = hasUpdate,
                latestVersion = latest.optString("version"),
                downloadUrl = latest.optString("downloadUrl"),
                filename = latest.optString("filename"),
                sizeBytes = latest.optLong("sizeBytes"),
                sha256 = latest.optString("sha256"),
            )
        } finally {
            conn.disconnect()
        }
    }

    private fun promptInstall(ctx: Context, info: UpdateInfo) {
        val sizeMb = String.format("%.1f", info.sizeBytes / 1024.0 / 1024.0)
        AlertDialog.Builder(ctx)
            .setTitle("Update available: v${info.latestVersion}")
            .setMessage(
                "A new version is available ($sizeMb MB).\n\n" +
                "Current: v${currentVersion(ctx)}\n" +
                "New:     v${info.latestVersion}\n\n" +
                "Download and install now?"
            )
            .setPositiveButton("Update") { _, _ -> startDownload(ctx, info) }
            .setNegativeButton("Later", null)
            .show()
    }

    private fun startDownload(ctx: Context, info: UpdateInfo) {
        // Pre-flight: ensure we have permission to install unknown sources on Android 8+
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !ctx.packageManager.canRequestPackageInstalls()) {
            // Send user to settings to grant the permission for this app
            val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES)
                .setData(Uri.parse("package:${ctx.packageName}"))
            ctx.startActivity(intent)
            return
        }

        val dm = ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val request = DownloadManager.Request(Uri.parse(info.downloadUrl)).apply {
            setTitle("Downloading ${info.filename}")
            setDescription("v${info.latestVersion}")
            setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            setDestinationInExternalFilesDir(ctx, Environment.DIRECTORY_DOWNLOADS, info.filename)
            setMimeType("application/vnd.android.package-archive")
        }
        val downloadId = dm.enqueue(request)
        Log.i(TAG, "download enqueued id=$downloadId for ${info.filename}")

        // Register one-shot receiver to fire install intent when DM finishes
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context, intent: Intent) {
                val id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1)
                if (id != downloadId) return
                c.unregisterReceiver(this)
                val file = File(ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), info.filename)
                if (file.exists()) {
                    launchInstall(c, file)
                } else {
                    Log.w(TAG, "downloaded file missing: ${file.absolutePath}")
                }
            }
        }
        // Android 14+ requires explicit RECEIVER_NOT_EXPORTED flag
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ctx.registerReceiver(
                receiver,
                IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE),
                Context.RECEIVER_NOT_EXPORTED,
            )
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            ctx.registerReceiver(receiver, IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE))
        }
    }

    private fun launchInstall(ctx: Context, apkFile: File) {
        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", apkFile)
        val install = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            ctx.startActivity(install)
        } catch (e: Exception) {
            Log.e(TAG, "install intent failed: ${e.message}")
        }
    }

    /* ─────────────────────────────────────────────────────────────────────────
     * Optional: schedule periodic background checks via WorkManager.
     *
     * In your Application.onCreate() or MainActivity.onCreate():
     *
     *   val req = PeriodicWorkRequestBuilder<UpdateCheckWorker>(6, TimeUnit.HOURS)
     *       .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
     *       .build()
     *   WorkManager.getInstance(this).enqueueUniquePeriodicWork(
     *       "apk-update-check", ExistingPeriodicWorkPolicy.KEEP, req
     *   )
     *
     *   // Where UpdateCheckWorker is:
     *   class UpdateCheckWorker(ctx: Context, params: WorkerParameters) : Worker(ctx, params) {
     *       override fun doWork(): Result {
     *           ApkUpdater.checkOnStart(applicationContext)
     *           return Result.success()
     *       }
     *   }
     * ───────────────────────────────────────────────────────────────────────── */
}
