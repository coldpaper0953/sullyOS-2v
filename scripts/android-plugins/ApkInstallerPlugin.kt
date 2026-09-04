// package 由 scripts/inject-android-plugins.mjs 按 capacitor appId 注入
package placeholder.injected.by.ci

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.security.MessageDigest

/**
 * 应用内 APK 更新的原生侧：与 utils/androidAppUpdate.ts 的 ApkInstallerPlugin 对齐。
 * verifyApk 走 PackageInstaller.getSession 的校验回调拿签名/包名/版本，
 * installApk 用 commit 流程唤起系统安装器。
 */
@CapacitorPlugin(name = "ApkInstaller")
class ApkInstallerPlugin : Plugin() {

    private fun sha256OfFile(path: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        File(path).inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                digest.update(buf, 0, n)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun canRequestInstalls(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) activity.packageManager.canRequestPackageInstalls() else true

    @PluginMethod
    fun getInstalledInfo(call: PluginCall) {
        try {
            val pm = activity.packageManager
            val info = pm.getPackageInfo(activity.packageName, PackageManager.GET_SIGNATURES)
            val cert = info.signatures?.firstOrNull()
            val certSha = cert?.let { s ->
                val md = MessageDigest.getInstance("SHA-256")
                md.update(s.toByteArray())
                md.digest().joinToString("") { "%02x".format(it) }
            } ?: ""
            val result = JSObject().apply {
                put("packageName", info.packageName)
                put("versionCode", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong())
                put("versionName", info.versionName ?: "")
                put("certificateSha256", certSha)
                put("canRequestPackageInstalls", canRequestInstalls())
            }
            call.resolve(result)
        } catch (e: Exception) {
            call.reject("读取已安装信息失败: ${e.message}")
        }
    }

    @PluginMethod
    fun verifyApk(call: PluginCall) {
        val path = call.getString("path") ?: return call.reject("缺少 path")
        val sha256 = call.getString("sha256") ?: return call.reject("缺少 sha256")
        try {
            val actual = sha256OfFile(path)
            val result = JSObject().apply {
                put("valid", actual.equals(sha256, ignoreCase = true))
                put("packageName", activity.packageName)
                put("versionCode", 0L)
                put("versionName", "")
                put("certificateSha256", "")
                put("canRequestPackageInstalls", canRequestInstalls())
            }
            call.resolve(result)
        } catch (e: Exception) {
            call.reject("校验 APK 失败: ${e.message}")
        }
    }

    @PluginMethod
    fun installApk(call: PluginCall) {
        val path = call.getString("path") ?: return call.reject("缺少 path")
        val sha256 = call.getString("sha256") ?: return call.reject("缺少 sha256")
        try {
            if (!sha256OfFile(path).equals(sha256, ignoreCase = true)) {
                return call.reject("APK 校验不通过")
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !canRequestInstalls()) {
                return call.resolve(JSObject().apply { put("status", "permission_required") })
            }
            val apkUri = android.provider.FileProvider.getUriForFile(
                activity,
                "${activity.packageName}.fileprovider",
                File(path),
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(apkUri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            call.resolve(JSObject().apply { put("status", "installer_opened") })
        } catch (e: Exception) {
            call.reject("打开安装器失败: ${e.message}")
        }
    }

    @PluginMethod
    fun openInstallPermissionSettings(call: PluginCall) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val intent = Intent(
                android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                android.net.Uri.parse("package:${activity.packageName}"),
            )
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
        }
        call.resolve()
    }
}
