package com.codevibe.dropvault;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.UUID;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class LocalSshProfileStore {
    static final class Profile {
        final String id;
        final String label;
        final String host;
        final String username;
        final int port;
        final String password;

        Profile(String id, String label, String host, String username, int port, String password) {
            this.id = id;
            this.label = label;
            this.host = host;
            this.username = username;
            this.port = port;
            this.password = password;
        }
    }

    private static final String KEY_ALIAS = "witt-local-ssh-passwords-v1";
    private static final String PREFERENCES = "witt-local-ssh-profiles-v1";
    private static final String PROFILES_KEY = "profiles";
    private final SharedPreferences preferences;

    LocalSshProfileStore(Context context) {
        preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    synchronized String publicProfilesJson() {
        JSONArray source = storedProfiles();
        JSONArray output = new JSONArray();
        for (int index = 0; index < source.length(); index++) {
            JSONObject item = source.optJSONObject(index);
            if (item == null || !validId(item.optString("id"))) continue;
            output.put(publicProfile(item));
        }
        JSONObject envelope = new JSONObject();
        try { envelope.put("profiles", output); } catch (Exception ignored) {}
        return envelope.toString();
    }

    synchronized Profile save(String requestedLabel, String host, String username, int port,
                              String password) throws Exception {
        JSONArray source = storedProfiles();
        JSONObject existing = null;
        for (int index = 0; index < source.length(); index++) {
            JSONObject item = source.optJSONObject(index);
            if (item != null && host.equalsIgnoreCase(item.optString("host"))
                    && username.equals(item.optString("username"))
                    && port == item.optInt("port", 22)) {
                existing = item;
                break;
            }
        }

        String id = existing == null || !validId(existing.optString("id"))
            ? UUID.randomUUID().toString() : existing.optString("id");
        String label = requestedLabel == null ? "" : requestedLabel.trim();
        if (label.isEmpty()) label = host;
        if (label.length() > 32) label = label.substring(0, 32);
        long now = System.currentTimeMillis();
        JSONObject saved = new JSONObject()
            .put("id", id)
            .put("label", label)
            .put("host", host)
            .put("username", username)
            .put("port", port)
            .put("secret", encrypt(id, password))
            .put("createdAt", existing == null ? now : existing.optLong("createdAt", now))
            .put("updatedAt", now);

        JSONArray reordered = new JSONArray().put(saved);
        for (int index = 0; index < source.length(); index++) {
            JSONObject item = source.optJSONObject(index);
            if (item != null && !id.equals(item.optString("id"))) reordered.put(item);
        }
        persist(reordered);
        return new Profile(id, label, host, username, port, password);
    }

    synchronized Profile get(String id) throws Exception {
        if (!validId(id)) return null;
        JSONArray source = storedProfiles();
        for (int index = 0; index < source.length(); index++) {
            JSONObject item = source.optJSONObject(index);
            if (item == null || !id.equals(item.optString("id"))) continue;
            return new Profile(
                id,
                item.optString("label", item.optString("host")),
                item.optString("host"),
                item.optString("username", "root"),
                item.optInt("port", 22),
                decrypt(id, item.optString("secret")));
        }
        return null;
    }

    synchronized boolean delete(String id) {
        if (!validId(id)) return false;
        JSONArray source = storedProfiles();
        JSONArray output = new JSONArray();
        boolean removed = false;
        for (int index = 0; index < source.length(); index++) {
            JSONObject item = source.optJSONObject(index);
            if (item == null) continue;
            if (id.equals(item.optString("id"))) removed = true;
            else output.put(item);
        }
        if (removed) persist(output);
        return removed;
    }

    private JSONObject publicProfile(JSONObject item) {
        JSONObject output = new JSONObject();
        try {
            output.put("id", item.optString("id"))
                .put("label", item.optString("label", item.optString("host")))
                .put("host", item.optString("host"))
                .put("username", item.optString("username", "root"))
                .put("port", item.optInt("port", 22))
                .put("updatedAt", item.optLong("updatedAt", 0L));
        } catch (Exception ignored) {}
        return output;
    }

    private JSONArray storedProfiles() {
        try {
            return new JSONArray(preferences.getString(PROFILES_KEY, "[]"));
        } catch (Exception ignored) {
            return new JSONArray();
        }
    }

    private void persist(JSONArray profiles) {
        preferences.edit().putString(PROFILES_KEY, profiles.toString()).apply();
    }

    private SecretKey encryptionKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) store.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    private String encrypt(String id, String password) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, encryptionKey());
        cipher.updateAAD(id.getBytes(StandardCharsets.UTF_8));
        byte[] encrypted = cipher.doFinal(password.getBytes(StandardCharsets.UTF_8));
        return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "."
            + Base64.encodeToString(encrypted, Base64.NO_WRAP);
    }

    private String decrypt(String id, String envelope) throws Exception {
        String[] parts = envelope.split("\\.", 2);
        if (parts.length != 2) throw new IllegalArgumentException("invalid password envelope");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, encryptionKey(),
            new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
        cipher.updateAAD(id.getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)),
            StandardCharsets.UTF_8);
    }

    private boolean validId(String id) {
        return id != null && id.matches("[a-f0-9-]{36}");
    }
}
