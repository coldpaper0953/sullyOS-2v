// package 由 scripts/inject-android-plugins.mjs 按 capacitor appId 注入
package placeholder.injected.by.ci

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject
import java.security.SecureRandom

/**
 * AMSG / UnifiedPush 原生侧：与 utils/unifiedPushPlugin.ts 的 UnifiedPushNativePlugin 对齐。
 *
 * 工作方式（UnifiedPush 规范）：
 *  - discoverDistributors() 查询支持 UP publisher 接口的应用（ntfy 无 Firebase 版等）
 *  - register: 向分发器发 REGISTER 广播；分发器回 NEW_ENDPOINT 广播带 endpoint
 *  - 消息: 分发器发 MESSAGE 广播 → 存入待消费队列（应用不在前台时发本地通知）
 *  - web 层 drainPendingPushes 把离线消息全部取走
 */
@CapacitorPlugin(name = "AmsgUnifiedPush")
class AmsgUnifiedPushPlugin : Plugin() {

    companion object {
        const val ACTION_UP_REGISTER = "org.unifiedpush.android.publisher.REGISTER"
        const val ACTION_UP_UNREGISTER = "org.unifiedpush.android.publisher.UNREGISTER"
        const val ACTION_UP_MESSAGE = "org.unifiedpush.android.connector.MESSAGE"
        const val ACTION_UP_NEW_ENDPOINT = "org.unifiedpush.android.connector.NEW_ENDPOINT"
        const val ACTION_UP_REGISTRATION_FAILED = "org.unifiedpush.android.connector.REGISTRATION_FAILED"
        const val ACTION_UP_NOTIFICATION_TAPPED = "org.unifiedpush.android.connector.NOTIFICATION_TAPPED"
        const val INSTANCE = "SullyOS"
    }

    private val pendingMessages = mutableListOf<JSONObject>()

    @Volatile private var subscription: JSONObject? = null
    @Volatile private var vapidPublicKey: String? = null
    @Volatile private var lastError: String? = null
    @Volatile private var tappedPayload: String? = null

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(ctx: Context, intent: Intent) {
            when (intent.action) {
                ACTION_UP_NEW_ENDPOINT -> {
                    val instance = intent.getStringExtra("instance") ?: INSTANCE
                    val endpoint = intent.getStringExtra("endpoint") ?: ""
                    val distributor = intent.`package`
                        ?: resolveDistributor()
                    if (endpoint.isNotBlank()) {
                        val (p256dh, auth) = generateKeys()
                        subscription = JSONObject().apply {
                            put("endpoint", endpoint)
                            put("keys", JSONObject().apply {
                                put("p256dh", p256dh)
                                put("auth", auth)
                            })
                            put("distributor", distributor)
                            put("temporary", false)
                            put("vapidPublicKey", vapidPublicKey ?: "")
                        }
                        lastError = null
                    } else {
                        subscription = null
                    }
                    notifyListeners("registrationChanged", JSObject().put("endpoint", endpoint))
                }
                ACTION_UP_REGISTRATION_FAILED -> {
                    lastError = "分发器注册失败"
                    subscription = null
                    notifyListeners("registrationChanged", JSObject().put("error", lastError))
                }
                ACTION_UP_MESSAGE -> {
                    val message = intent.getStringExtra("message") ?: return
                    val stored = JSONObject().apply {
                        put("payload", message)
                        put("receivedAt", System.currentTimeMillis())
                    }
                    synchronized(pendingMessages) { pendingMessages.add(stored) }
                    notifyListeners("pushReceived", JSObject().put("payload", message))
                }
                ACTION_UP_NOTIFICATION_TAPPED -> {
                    val message = intent.getStringExtra("payload")
                        ?: intent.getStringExtra("message")
                    if (message != null) {
                        tappedPayload = message
                        notifyListeners("notificationTapped", JSObject().put("payload", message))
                    }
                }
            }
        }
    }

    override fun load() {
        super.load()
        val filter = IntentFilter().apply {
            addAction(ACTION_UP_NEW_ENDPOINT)
            addAction(ACTION_UP_REGISTRATION_FAILED)
            addAction(ACTION_UP_MESSAGE)
            addAction(ACTION_UP_NOTIFICATION_TAPPED)
        }
        try {
            androidx.core.content.ContextCompat.registerReceiver(
                context,
                receiver,
                filter,
                androidx.core.content.ContextCompat.RECEIVER_EXPORTED,
            )
        } catch (e: Exception) {
            // Android 13 以下没有 RECEIVER_EXPORTED；退回普通注册
            context.registerReceiver(receiver, filter)
        }
    }

    override fun handleOnDestroy() {
        try { context.unregisterReceiver(receiver) } catch (e: Exception) { /* noop */ }
        super.handleOnDestroy()
    }

    private fun resolveDistributor(): String {
        val pm = context.packageManager
        val registerIntent = Intent(ACTION_UP_REGISTER)
        val services = pm.queryIntentServices(registerIntent, 0)
        return services.firstOrNull()?.serviceInfo?.packageName ?: ""
    }

    private fun listDistributors(): List<String> {
        val pm = context.packageManager
        val registerIntent = Intent(ACTION_UP_REGISTER)
        val services = pm.queryIntentServices(registerIntent, 0)
        return services
            .mapNotNull { it.serviceInfo?.packageName }
            .distinct()
    }

    private fun generateKeys(): Pair<String, String> {
        val random = SecureRandom()
        val bytes = ByteArray(32) { random.nextInt(256).toByte() }
        val auth = ByteArray(16) { random.nextInt(256).toByte() }
        return Pair(
            android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING),
            android.util.Base64.encodeToString(auth, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING),
        )
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val distributors = JSONArray()
        listDistributors().forEach { distributors.put(it) }
        val status = JSObject().apply {
            put("native", true)
            put("distributors", distributors)
            put("distributor", subscription?.optString("distributor") ?: "")
            put("subscription", subscription ?: JSONObject.NULL)
            put("lastError", lastError ?: "")
        }
        call.resolve(status)
    }

    @PluginMethod
    fun register(call: PluginCall) {
        vapidPublicKey = call.getString("vapidPublicKey")
        val distributor = resolveDistributor()
        if (distributor.isBlank()) {
            return call.reject("没有检测到 UnifiedPush 服务")
        }
        val intent = Intent(ACTION_UP_REGISTER).apply {
            `package` = distributor
            putExtra("instance", INSTANCE)
        }
        context.sendBroadcast(intent)
        call.resolve(JSObject().apply { put("pending", true) })
    }

    @PluginMethod
    fun unregister(call: PluginCall) {
        val distributor = subscription?.optString("distributor") ?: resolveDistributor()
        if (distributor.isNotBlank()) {
            val intent = Intent(ACTION_UP_UNREGISTER).apply {
                `package` = distributor
                putExtra("instance", INSTANCE)
            }
            context.sendBroadcast(intent)
        }
        subscription = null
        call.resolve()
    }

    @PluginMethod
    fun drainPendingPushes(call: PluginCall) {
        val drained: List<JSONObject>
        synchronized(pendingMessages) {
            drained = pendingMessages.toList()
            pendingMessages.clear()
        }
        val result = JSObject().apply {
            put("messages", JSONArray(drained))
            tappedPayload?.let { put("launchPayload", it) }
        }
        tappedPayload = null
        call.resolve(result)
    }
}
