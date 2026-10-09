package com.cloudhub.updater

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.security.MessageDigest

class UpdateFileProvider : FileProvider()

@InvokeArg
class InstallArgs {
    lateinit var path: String
    lateinit var version: String
}

@TauriPlugin
class UpdaterPlugin(private val activity: Activity) : Plugin(activity) {
    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo): Set<String> {
        val signatures = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
        return signatures?.map { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).joinToString("") { "%02x".format(it) }
        }?.toSet() ?: emptySet()
    }

    @Suppress("DEPRECATION")
    @Command
    fun installApk(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(InstallArgs::class.java)
            val file = File(args.path).canonicalFile
            val expected = File(activity.cacheDir, "cloudhub-updates/update.apk").canonicalFile
            require(file == expected && file.isFile) { "Invalid update path" }
            val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
            val installed = activity.packageManager.getPackageInfo(activity.packageName, flags)
            val archive = activity.packageManager.getPackageArchiveInfo(file.path, flags) ?: error("Invalid APK")
            require(archive.packageName == activity.packageName && archive.versionName == args.version) { "Wrong update package" }
            val nextCode = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else archive.versionCode.toLong()
            val currentCode = if (Build.VERSION.SDK_INT >= 28) installed.longVersionCode else installed.versionCode.toLong()
            require(nextCode > currentCode) { "Update must be newer" }
            val trusted = signers(installed)
            require(trusted.isNotEmpty() && trusted == signers(archive)) { "Update signer does not match" }
            activity.runOnUiThread {
                try {
                    val result = JSObject()
                    if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
                        activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
                        result.put("status", "permission_required")
                    } else {
                        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.cloudhub.updates", file)
                        activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
                            setDataAndType(uri, "application/vnd.android.package-archive")
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        })
                        result.put("status", "installer_opened")
                    }
                    invoke.resolve(result)
                } catch (_: Exception) { invoke.reject("无法打开系统安装器，请重试") }
            }
        } catch (_: Exception) {
            invoke.reject("安装包校验失败，请重新下载并确认签名一致")
        }
    }
}
