package com.codevibe.dropvault;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Manages device identity and AES-GCM encrypted bearer token storage using AndroidKeyStore.
 * Preserves the exact SharedPreferences name, keys, and KeyStore alias for seamless upgrades.
 */
final class AuthTokenStore {
    static final String PREFS_NAME = "witt-device-auth";
    static final String AUTH_KEY_ALIAS = "witt-device-auth-v2";
    private static final String KEY_DEVICE_ID = "device_id";
    private static final String KEY_TOKEN_V2 = "device_token_v2";
    private static final String KEY_TOKEN_LEGACY = "device_token";

    private final Context appContext;

    AuthTokenStore(Context context) {
        this.appContext = context.getApplicationContext();
    }

    private SharedPreferences authPreferences() {
        return appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    String deviceId() {
        String value = authPreferences().getString(KEY_DEVICE_ID, "");
        if (value != null && value.matches("[a-f0-9-]{36}")) return value;
        value = UUID.randomUUID().toString();
        authPreferences().edit().putString(KEY_DEVICE_ID, value).apply();
        return value;
    }

    String regenerateDeviceId() {
        String value = UUID.randomUUID().toString();
        authPreferences().edit().putString(KEY_DEVICE_ID, value).commit();
        return value;
    }

    String apiToken() {
        SharedPreferences preferences = authPreferences();
        String encrypted = preferences.getString(KEY_TOKEN_V2, "");
        if (encrypted != null && !encrypted.isEmpty()) {
            try { return decryptToken(encrypted); } catch (Exception ignored) {}
        }
        String legacy = preferences.getString(KEY_TOKEN_LEGACY, "");
        if (legacy == null || legacy.isEmpty()) return "";
        try {
            preferences.edit().putString(KEY_TOKEN_V2, encryptToken(legacy))
                .remove(KEY_TOKEN_LEGACY).apply();
        } catch (Exception ignored) {}
        return legacy;
    }

    boolean saveToken(String token, boolean commit) throws Exception {
        SharedPreferences.Editor editor = authPreferences().edit()
            .putString(KEY_TOKEN_V2, encryptToken(token))
            .remove(KEY_TOKEN_LEGACY);
        if (commit) return editor.commit();
        editor.apply();
        return true;
    }

    String cacheScope() {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                .digest(deviceId().getBytes(StandardCharsets.UTF_8));
            StringBuilder value = new StringBuilder();
            for (int index = 0; index < 16; index++) {
                value.append(String.format("%02x", digest[index] & 0xff));
            }
            return value.toString();
        } catch (Exception ignored) {
            return "";
        }
    }

    private SecretKey authKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(AUTH_KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) store.getEntry(AUTH_KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(AUTH_KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    private String encryptToken(String value) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, authKey());
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." +
            Base64.encodeToString(ciphertext, Base64.NO_WRAP);
    }

    private String decryptToken(String value) throws Exception {
        String[] parts = value.split("\\.", 2);
        if (parts.length != 2) throw new IllegalArgumentException("invalid token envelope");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, authKey(),
            new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)),
            StandardCharsets.UTF_8);
    }
}
