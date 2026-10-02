package com.cloudhub.securestore

import android.app.Activity
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.AtomicFile
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import app.tauri.plugin.Invoke
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class StoreKeyArgs {
    lateinit var key: String
}

@TauriPlugin
class SecureStorePlugin(private val activity: Activity) : Plugin(activity) {
    private val alias = "cloudhub-local-database-key-v1"
    private val identityAlias = "cloudhub-sync-identity-v1"
    // This ciphertext can only be opened by this device's Android Keystore key.
    // Keep it out of Auto Backup/device transfer so it cannot be restored without
    // the non-exportable wrapping key.
    private val wrappedKeyFile by lazy {
        AtomicFile(File(activity.noBackupFilesDir, KEY_FILENAME))
    }
    private val wrappedIdentityFile by lazy {
        AtomicFile(File(activity.noBackupFilesDir, IDENTITY_FILENAME))
    }

    @Command
    fun excludeDataFromBackup(invoke: Invoke) {
        // Native manifest rules exclude app data for cloud backup and device transfer.
        invoke.resolve(JSObject())
    }

    @Command
    fun loadKey(invoke: Invoke) {
        try {
            val packed = try {
                wrappedKeyFile.openRead().use { it.readBytes() }
            } catch (_: java.io.FileNotFoundException) {
                null
            }
            if (packed == null) {
                val result = JSObject()
                result.put("key", JSONObject.NULL)
                invoke.resolve(result)
                return
            }
            require(packed.size > IV_LENGTH) { "Invalid stored key" }
            val iv = packed.copyOfRange(0, IV_LENGTH)
            val ciphertext = packed.copyOfRange(IV_LENGTH, packed.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateWrappingKey(alias), GCMParameterSpec(TAG_BITS, iv))
            val key = cipher.doFinal(ciphertext)
            try {
                require(key.size == KEY_LENGTH) { "Invalid stored key" }
                val result = JSObject()
                result.put("key", Base64.encodeToString(key, Base64.NO_WRAP))
                invoke.resolve(result)
            } finally {
                key.fill(0)
            }
        } catch (_: Exception) {
            invoke.reject("无法读取本机安全密钥；本地数据保持不变")
        }
    }

    @Command
    fun storeKey(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(StoreKeyArgs::class.java)
            val key = Base64.decode(args.key, Base64.NO_WRAP)
            try {
                require(key.size == KEY_LENGTH) { "Invalid key" }
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, getOrCreateWrappingKey(alias))
                val ciphertext = cipher.doFinal(key)
                val packed = cipher.iv + ciphertext
                val stream = wrappedKeyFile.startWrite()
                try {
                    stream.write(packed)
                    wrappedKeyFile.finishWrite(stream)
                } catch (error: Exception) {
                    wrappedKeyFile.failWrite(stream)
                    throw error
                }
            } finally {
                key.fill(0)
            }
            invoke.resolve(JSObject())
        } catch (_: Exception) {
            invoke.reject("无法保存本机安全密钥")
        }
    }

    @Command
    fun loadSyncIdentitySeed(invoke: Invoke) {
        try {
            val packed = try { wrappedIdentityFile.openRead().use { it.readBytes() } }
            catch (_: java.io.FileNotFoundException) { null }
            if (packed == null) {
                invoke.resolve(JSObject().apply { put("key", JSONObject.NULL) })
                return
            }
            require(packed.size > IV_LENGTH)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateWrappingKey(identityAlias), GCMParameterSpec(TAG_BITS, packed.copyOfRange(0, IV_LENGTH)))
            val seed = cipher.doFinal(packed.copyOfRange(IV_LENGTH, packed.size))
            try {
                require(seed.size == KEY_LENGTH)
                invoke.resolve(JSObject().apply { put("key", Base64.encodeToString(seed, Base64.NO_WRAP)) })
            } finally {
                seed.fill(0)
            }
        } catch (_: Exception) {
            invoke.reject("无法读取本机同步身份密钥")
        }
    }

    @Command
    @Synchronized
    fun storeSyncIdentitySeed(invoke: Invoke) {
        try {
            val existing = try { wrappedIdentityFile.openRead().use { it.readBytes() }; true }
            catch (_: java.io.FileNotFoundException) { false }
            if (existing) { invoke.resolve(JSObject()); return }
            val args = invoke.parseArgs(StoreKeyArgs::class.java)
            val seed = Base64.decode(args.key, Base64.NO_WRAP)
            try {
                require(seed.size == KEY_LENGTH)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.ENCRYPT_MODE, getOrCreateWrappingKey(identityAlias))
                val stream = wrappedIdentityFile.startWrite()
                try {
                    stream.write(cipher.iv + cipher.doFinal(seed))
                    wrappedIdentityFile.finishWrite(stream)
                } catch (error: Exception) {
                    wrappedIdentityFile.failWrite(stream)
                    throw error
                }
            } finally {
                seed.fill(0)
            }
            invoke.resolve(JSObject())
        } catch (_: Exception) {
            invoke.reject("无法保存本机同步身份密钥")
        }
    }

    private fun getOrCreateWrappingKey(keyAlias: String): SecretKey {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (keyStore.getKey(keyAlias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setKeySize(256)
                .build(),
        )
        return generator.generateKey()
    }

    private companion object {
        const val KEY_FILENAME = "wrapped-database-key-v1.bin"
        const val IDENTITY_FILENAME = "wrapped-sync-identity-v1.bin"
        const val KEY_LENGTH = 32
        const val IV_LENGTH = 12
        const val TAG_BITS = 128
    }
}
