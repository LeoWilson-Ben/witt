package com.codevibe.dropvault;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SafeBrowsingResponse;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.KeyStore;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

public class MainActivity extends Activity {
    private static final int PICK_FILES = 8102;
    private static final long MAX_FILE_BYTES = 500L * 1024L * 1024L;
    private final Map<String, PickedFile> pickedFiles = new ConcurrentHashMap<>();
    private final Map<Long, String> artifactDownloads = new ConcurrentHashMap<>();
    private final ExecutorService network = Executors.newFixedThreadPool(2);
    private final Handler updateHandler = new Handler(Looper.getMainLooper());
    private final Runnable foregroundUpdateCheck = new Runnable() {
        @Override
        public void run() {
            if (isFinishing() || isDestroyed()) return;
            UpdateManager.checkAndPrompt(MainActivity.this);
            updateHandler.postDelayed(this, 60_000L);
        }
    };
    private WebView webView;
    private FrameLayout rootView;
    private WittLaunchView launchView;
    private boolean receiverRegistered;
    private final WebBridge webBridge = new WebBridge();
    private static final String AUTH_KEY_ALIAS = "witt-device-auth-v2";

    private SharedPreferences authPreferences() {
        return getSharedPreferences("witt-device-auth", MODE_PRIVATE);
    }

    private String deviceId() {
        String value = authPreferences().getString("device_id", "");
        if (value != null && value.matches("[a-f0-9-]{36}")) return value;
        value = UUID.randomUUID().toString();
        authPreferences().edit().putString("device_id", value).apply();
        return value;
    }

    private String apiToken() {
        SharedPreferences preferences = authPreferences();
        String encrypted = preferences.getString("device_token_v2", "");
        if (encrypted != null && !encrypted.isEmpty()) {
            try { return decryptToken(encrypted); } catch (Exception ignored) {}
        }
        String legacy = preferences.getString("device_token", "");
        if (legacy == null || legacy.isEmpty()) return "";
        try {
            preferences.edit().putString("device_token_v2", encryptToken(legacy))
                .remove("device_token").apply();
        } catch (Exception ignored) {}
        return legacy;
    }

    private SecretKey authKey() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(AUTH_KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) store.getEntry(AUTH_KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
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

    private String cacheScope() {
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

    private final BroadcastReceiver downloadReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) {
                long downloadId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                String artifactName = artifactDownloads.remove(downloadId);
                if (artifactName != null) {
                    Toast.makeText(MainActivity.this,
                        artifactName + " 已保存到下载/Witt", Toast.LENGTH_LONG).show();
                } else {
                    UpdateManager.handleDownloaded(MainActivity.this, downloadId);
                }
            }
        }
    };

    @Override
    @SuppressLint("SetJavaScriptEnabled")
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applySystemBars("light");

        rootView = new FrameLayout(this);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        webView.setLayerType(android.view.View.LAYER_TYPE_HARDWARE, null);
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true);
        launchView = new WittLaunchView(this);
        rootView.addView(webView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        rootView.addView(launchView, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(rootView);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSafeBrowsingEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMediaPlaybackRequiresUserGesture(false);

        CookieManager.getInstance().setAcceptCookie(false);
        WebViewCompat.addWebMessageListener(webView, "WittNative",
            Collections.singleton("https://upload.16.208.20.133.sslip.io"),
            (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                if (!isMainFrame || sourceOrigin == null ||
                    !"upload.16.208.20.133.sslip.io".equalsIgnoreCase(sourceOrigin.getHost())) return;
                dispatchNativeMessage(message.getData());
            });
        webView.setWebChromeClient(new WebChromeClient());
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public android.webkit.WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {
                android.webkit.WebResourceResponse local =
                    assetLoader.shouldInterceptRequest(request.getUrl());
                if (local != null) return local;
                return protectedImageResponse(request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("upload.16.208.20.133.sslip.io".equalsIgnoreCase(uri.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    Toast.makeText(MainActivity.this, "无法打开链接", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                try {
                    JSONObject info = new JSONObject()
                        .put("version", BuildConfig.VERSION_NAME)
                        .put("cacheScope", cacheScope())
                        .put("bundledLumoraMedia", true);
                    callJs("window.DropVault&&window.DropVault.nativeReady(" + info + ")");
                } catch (Exception ignored) {}
                view.postDelayed(MainActivity.this::dismissLaunchSurface, 650L);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                String html = "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'>" +
                    "<style>body{min-height:100vh;margin:0;display:grid;place-content:center;text-align:center;font-family:sans-serif;background:#f5f8ff;color:#263952}button{margin:18px auto;padding:12px 20px;border:0;border-radius:12px;color:white;background:#566fe8}</style>" +
                    "<h2>暂时无法连接 Witt</h2><p>请检查网络后重试</p><button onclick='location.href=\"" + BuildConfig.WEB_URL + "\"'>重新连接</button>";
                view.loadDataWithBaseURL(BuildConfig.WEB_URL, html, "text/html", "UTF-8", null);
            }

            @Override
            @RequiresApi(Build.VERSION_CODES.O_MR1)
            public void onSafeBrowsingHit(WebView view, WebResourceRequest request, int threatType, SafeBrowsingResponse callback) {
                callback.backToSafety(true);
            }
        });

        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        ContextCompat.registerReceiver(this, downloadReceiver, filter, ContextCompat.RECEIVER_EXPORTED);
        receiverRegistered = true;
        requestNotificationPermission();
        requestStoragePermission();
        UpdateManager.schedule(this);
        webView.loadUrl(BuildConfig.WEB_URL);
        if (getIntent().getBooleanExtra("open_update", false)) {
            webView.postDelayed(() -> UpdateManager.check(this, true), 900L);
        }
    }

    private android.webkit.WebResourceResponse protectedImageResponse(WebResourceRequest request) {
        Uri uri = request.getUrl();
        if (!"GET".equalsIgnoreCase(request.getMethod()) ||
            !"https".equalsIgnoreCase(uri.getScheme()) ||
            !"upload.16.208.20.133.sslip.io".equalsIgnoreCase(uri.getHost()) ||
            uri.getPath() == null ||
            !uri.getPath().matches("^/vault-api/chat-images/[a-f0-9-]{36}$")) return null;
        String token = apiToken();
        if (token.isEmpty()) return null;
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(uri.toString()).openConnection();
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(60_000);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                connection.disconnect();
                return new android.webkit.WebResourceResponse("text/plain", "UTF-8", status,
                    "Image request failed", Collections.singletonMap("Cache-Control", "no-store"),
                    new ByteArrayInputStream(new byte[0]));
            }
            String contentType = connection.getContentType();
            String mimeType = contentType == null ? "image/jpeg" : contentType.split(";", 2)[0];
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "private, max-age=300");
            headers.put("X-Content-Type-Options", "nosniff");
            return new android.webkit.WebResourceResponse(mimeType, null, status, "OK", headers,
                new BufferedInputStream(connection.getInputStream()));
        } catch (Exception ignored) {
            return null;
        }
    }

    private void dispatchNativeMessage(String rawMessage) {
        try {
            JSONObject message = new JSONObject(rawMessage == null ? "{}" : rawMessage);
            String method = message.optString("method", "");
            JSONArray args = message.optJSONArray("args");
            if (args == null) args = new JSONArray();
            switch (method) {
                case "launchSurfaceReady": webBridge.launchSurfaceReady(); break;
                case "contentReady": webBridge.contentReady(args.optString(0, "light")); break;
                case "requestAuthStatus": webBridge.requestAuthStatus(); break;
                case "activateInvite": webBridge.activateInvite(args.optString(0)); break;
                case "requestAdminDevices": webBridge.requestAdminDevices(); break;
                case "requestCodexAccounts": webBridge.requestCodexAccounts(); break;
                case "startXuanyuCodexLogin": webBridge.startXuanyuCodexLogin(); break;
                case "requestXuanyuCodexLoginStatus": webBridge.requestXuanyuCodexLoginStatus(); break;
                case "cancelXuanyuCodexLogin": webBridge.cancelXuanyuCodexLogin(); break;
                case "createInvite": webBridge.createInvite(args.optString(0), args.optInt(1, 1)); break;
                case "disableDevice": webBridge.disableDevice(args.optString(0)); break;
                case "pickFiles": webBridge.pickFiles(); break;
                case "uploadFile": webBridge.uploadFile(args.optString(0)); break;
                case "requestHistory": webBridge.requestHistory(); break;
                case "requestTasks": webBridge.requestTasks(); break;
                case "submitTask": webBridge.submitTask(args.optString(0)); break;
                case "requestConversations": webBridge.requestConversations(); break;
                case "requestCapabilities": webBridge.requestCapabilities(); break;
                case "requestConversation": webBridge.requestConversation(args.optString(0)); break;
                case "requestConversationDelta": webBridge.requestConversationDelta(args.optString(0)); break;
                case "requestUsage": webBridge.requestUsage(args.optString(0)); break;
                case "consumeRateLimitReset": webBridge.consumeRateLimitReset(); break;
                case "requestStreamDetail": webBridge.requestStreamDetail(
                    args.optString(0), args.optString(1), args.optString(2)); break;
                case "createConversation": webBridge.createConversation(
                    args.optString(0), args.optString(1), args.optString(2)); break;
                case "createConversationWithPath": webBridge.createConversationWithPath(
                    args.optString(0), args.optString(1), args.optString(2), args.optString(3)); break;
                case "createConversationWithProfile": webBridge.createConversationWithProfile(
                    args.optString(0), args.optString(1), args.optString(2), args.optString(3),
                    args.optString(4)); break;
                case "updateConversationSettings": webBridge.updateConversationSettings(
                    args.optString(0), args.optString(1), args.optString(2), args.optString(3)); break;
                case "updateConversationProject": webBridge.updateConversationProject(
                    args.optString(0), args.optString(1)); break;
                case "sendChatMessage": webBridge.sendChatMessage(
                    args.optString(0), args.optString(1), args.optString(2, "[]")); break;
                case "interruptConversation": webBridge.interruptConversation(args.optString(0)); break;
                case "archiveConversation": webBridge.archiveConversation(args.optString(0)); break;
                case "forkConversation": webBridge.forkConversation(args.optString(0)); break;
                case "compactConversation": webBridge.compactConversation(args.optString(0)); break;
                case "reviewConversation": webBridge.reviewConversation(args.optString(0)); break;
                case "resolveApproval": webBridge.resolveApproval(
                    args.optString(0), args.optString(1), args.optString(2)); break;
                case "downloadArtifact": webBridge.downloadArtifact(args.optString(0), args.optString(1),
                    args.optString(2), args.optString(3), args.optString(4)); break;
                case "downloadImage": webBridge.downloadImage(
                    args.optString(0), args.optString(1), args.optString(2)); break;
                case "checkForUpdates": webBridge.checkForUpdates(); break;
                default: break;
            }
        } catch (Exception ignored) {}
    }

    private void dismissLaunchSurface() {
        if (launchView == null) return;
        WittLaunchView surface = launchView;
        launchView = null;
        surface.dismiss(() -> {
            if (surface.getParent() == rootView) rootView.removeView(surface);
        });
    }

    private void applySystemBars(String mode) {
        boolean light = "light".equals(mode);
        int color = light ? Color.rgb(247, 249, 254) : Color.BLACK;
        getWindow().setStatusBarColor(color);
        getWindow().setNavigationBarColor(color);
        int flags = 0;
        if (light && Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
        }
        if (light && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            flags |= android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        }
        getWindow().getDecorView().setSystemUiVisibility(flags);
        applyOrientationChrome();
    }

    private void applyOrientationChrome() {
        boolean landscape = getResources().getConfiguration().orientation
            == Configuration.ORIENTATION_LANDSCAPE;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = getWindow().getInsetsController();
            if (controller == null) return;
            controller.setSystemBarsBehavior(
                WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            if (landscape) controller.hide(WindowInsets.Type.statusBars());
            else controller.show(WindowInsets.Type.statusBars());
            return;
        }
        if (landscape) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        }
    }

    private void chooseFiles() {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        startActivityForResult(intent, PICK_FILES);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILES || resultCode != RESULT_OK || data == null) return;
        JSONArray result = new JSONArray();
        if (data.getClipData() != null) {
            for (int index = 0; index < data.getClipData().getItemCount(); index++) {
                addPickedFile(data.getClipData().getItemAt(index).getUri(), data, result);
            }
        } else if (data.getData() != null) {
            addPickedFile(data.getData(), data, result);
        }
        callJs("window.DropVault.onFilesPicked(" + JSONObject.quote(result.toString()) + ")");
    }

    private void addPickedFile(Uri uri, Intent source, JSONArray output) {
        try {
            getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {}
        String id = UUID.randomUUID().toString();
        String name = "file";
        long size = -1L;
        try (Cursor cursor = getContentResolver().query(uri,
            new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameIndex >= 0) name = cursor.getString(nameIndex);
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex);
            }
        }
        String type = getContentResolver().getType(uri);
        if (size > MAX_FILE_BYTES) {
            Toast.makeText(this, "单个文件不能超过 500 MB", Toast.LENGTH_LONG).show();
            return;
        }
        PickedFile file = new PickedFile(id, uri, name == null ? "file" : name, Math.max(0, size),
            type == null ? "application/octet-stream" : type);
        pickedFiles.put(id, file);
        try {
            output.put(new JSONObject()
                .put("id", file.id)
                .put("name", file.name)
                .put("size", file.size)
                .put("type", file.type));
        } catch (Exception ignored) {}
    }

    private void upload(String id) {
        PickedFile file = pickedFiles.get(id);
        if (file == null) {
            uploadFinished(id, false, "文件授权已失效，请重新选择", "");
            return;
        }
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(BuildConfig.API_URL + "files").openConnection();
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(600_000);
                connection.setRequestProperty("Authorization", "Bearer " + apiToken());
                connection.setRequestProperty("Content-Type", "application/octet-stream");
                connection.setRequestProperty("X-File-Name", URLEncoder.encode(file.name, StandardCharsets.UTF_8.name()).replace("+", "%20"));
                connection.setRequestProperty("X-File-Type", file.type);
                if (file.size > 0 && file.size <= Integer.MAX_VALUE) connection.setFixedLengthStreamingMode((int) file.size);
                else connection.setChunkedStreamingMode(128 * 1024);

                long sent = 0;
                long lastUpdate = 0;
                byte[] buffer = new byte[128 * 1024];
                try (InputStream input = getContentResolver().openInputStream(file.uri);
                     OutputStream output = connection.getOutputStream()) {
                    if (input == null) throw new IllegalStateException("无法读取文件");
                    int read;
                    while ((read = input.read(buffer)) >= 0) {
                        output.write(buffer, 0, read);
                        sent += read;
                        long now = System.currentTimeMillis();
                        if (file.size > 0 && now - lastUpdate > 120) {
                            int percent = Math.min(99, (int) (sent * 100 / file.size));
                            uploadProgress(id, percent);
                            lastUpdate = now;
                        }
                    }
                }
                int status = connection.getResponseCode();
                InputStream response = status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream();
                String body = readBody(response);
                if (status >= 200 && status < 300) {
                    pickedFiles.remove(id);
                    uploadFinished(id, true, "", body);
                } else {
                    String message = "上传失败";
                    try { message = new JSONObject(body).optString("error", message); } catch (Exception ignored) {}
                    uploadFinished(id, false, message, "");
                }
            } catch (Exception error) {
                uploadFinished(id, false, "网络异常，请重试", "");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void requestHistory() {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(BuildConfig.API_URL + "files?limit=100").openConnection();
                connection.setConnectTimeout(10_000);
                connection.setReadTimeout(15_000);
                connection.setRequestProperty("Authorization", "Bearer " + apiToken());
                if (connection.getResponseCode() != 200) throw new IllegalStateException("Bad response");
                String body = readBody(connection.getInputStream());
                callJs("window.DropVault.onHistory(" + JSONObject.quote(body) + ")");
            } catch (Exception error) {
                callJs("window.DropVault.onHistoryError()");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void requestTasks() {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("tasks?limit=20", "GET");
                if (connection.getResponseCode() != 200) throw new IllegalStateException("Bad response");
                String body = readBody(connection.getInputStream());
                callJs("window.DropVault.onTasks(" + JSONObject.quote(body) + ")");
            } catch (Exception error) {
                callJs("window.DropVault.onTasksError()");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void submitTask(String prompt) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("tasks", "POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] body = new JSONObject().put("prompt", prompt).toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) {
                    output.write(body);
                }
                int status = connection.getResponseCode();
                InputStream response = status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream();
                String responseBody = readBody(response);
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onTaskSubmitted(" + JSONObject.quote(responseBody) + ")");
                } else {
                    String message = "任务提交失败";
                    try { message = new JSONObject(responseBody).optString("error", message); } catch (Exception ignored) {}
                    callJs("window.DropVault.onTaskSubmitError(" + JSONObject.quote(message) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onTaskSubmitError(" + JSONObject.quote("网络异常，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private HttpURLConnection openApiConnection(String endpoint, String method) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(BuildConfig.API_URL + endpoint).openConnection();
        connection.setRequestMethod(method);
        connection.setConnectTimeout(15_000);
        connection.setReadTimeout(30_000);
        connection.setRequestProperty("Authorization", "Bearer " + apiToken());
        return connection;
    }

    private void requestAuthStatus() {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("auth/status", "GET");
                int status = connection.getResponseCode();
                String body = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onAuthStatus(" + JSONObject.quote(body) + ")");
                } else {
                    callJs("window.DropVault.onAuthError(" + JSONObject.quote(apiError(body)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onAuthError(" + JSONObject.quote("无法连接服务器") + ")");
            } finally { if (connection != null) connection.disconnect(); }
        });
    }

    private void activateInvite(String inviteCode) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(BuildConfig.API_URL + "auth/activate").openConnection();
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(30_000);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                JSONObject payload = new JSONObject()
                    .put("inviteCode", inviteCode == null ? "" : inviteCode.trim())
                    .put("deviceId", deviceId())
                    .put("deviceName", Build.MANUFACTURER + " " + Build.MODEL);
                byte[] bytes = payload.toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                int status = connection.getResponseCode();
                String body = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    String token = new JSONObject(body).optString("token", "");
                    if (token.isEmpty()) throw new IllegalStateException("服务器未返回设备凭据");
                    authPreferences().edit().putString("device_token_v2", encryptToken(token))
                        .remove("device_token").apply();
                    callJs("window.DropVault.onActivation(" + JSONObject.quote(body) + ")");
                } else {
                    callJs("window.DropVault.onActivationError(" + JSONObject.quote(apiError(body)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onActivationError(" + JSONObject.quote("邀请码激活失败，请检查后重试") + ")");
            } finally { if (connection != null) connection.disconnect(); }
        });
    }

    private void requestAdmin(String endpoint, String method, String payload, String callback) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection(endpoint, method);
                if (payload != null) {
                    byte[] bytes = payload.getBytes(StandardCharsets.UTF_8);
                    connection.setDoOutput(true);
                    connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                    connection.setFixedLengthStreamingMode(bytes.length);
                    try (OutputStream output = connection.getOutputStream()) { output.write(bytes); }
                }
                int status = connection.getResponseCode();
                String body = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) callJs(callback + "(" + JSONObject.quote(body) + ")");
                else callJs("window.DropVault.onAdminError(" + JSONObject.quote(apiError(body)) + ")");
            } catch (Exception error) {
                callJs("window.DropVault.onAdminError(" + JSONObject.quote("管理请求失败，请重试") + ")");
            } finally { if (connection != null) connection.disconnect(); }
        });
    }

    private void requestConversations() {
      requestChat("conversations", "window.DropVault.onConversations", "window.DropVault.onChatError");
    }

    private void requestCapabilities() {
        requestChat("capabilities", "window.DropVault.onCapabilities", "window.DropVault.onCapabilitiesError");
    }

    private void conversationAction(String id, String action, JSONObject payload,
                                    String successCallback) {
        if (id == null || !id.matches("[a-f0-9-]{36}")) return;
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("chat/conversations/" + id + "/" + action, "POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] body = (payload == null ? new JSONObject() : payload).toString()
                    .getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs(successCallback + "(" + JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onAppServerActionError(" +
                        JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onAppServerActionError(" +
                    JSONObject.quote("App Server 操作失败，请重试") + ")");
            } finally { if (connection != null) connection.disconnect(); }
        });
    }

    private void requestConversation(String id) {
        requestChat("conversations/" + id, "window.DropVault.onConversation", "window.DropVault.onChatError");
    }

    private void requestConversationDelta(String id) {
        requestChat("conversations/" + id + "/sync",
            "window.DropVault.onConversationDelta", "window.DropVault.onChatError");
    }

    private void resolveApproval(String conversationId, String approvalId, String choiceId) {
        if (!String.valueOf(conversationId).matches("[a-f0-9-]{36}") ||
            !String.valueOf(approvalId).matches("[a-f0-9-]{36}")) return;
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("chat/conversations/" + conversationId +
                    "/approvals/" + approvalId, "POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] body = new JSONObject().put("choiceId", choiceId).toString()
                    .getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onApprovalResolved(" + JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onApprovalError(" + JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onApprovalError(" + JSONObject.quote("权限确认失败，请重试") + ")");
            } finally { if (connection != null) connection.disconnect(); }
        });
    }

    private void requestUsage(String conversationId) {
        String suffix = conversationId != null && conversationId.matches("[a-f0-9-]{36}")
            ? "?conversationId=" + conversationId : "";
        requestChat("usage" + suffix, "window.DropVault.onUsage", "window.DropVault.onUsageError");
    }

    private void consumeRateLimitReset() {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("usage/reset", "POST");
                connection.setDoOutput(true);
                connection.getOutputStream().close();
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) callJs("window.DropVault.onUsageReset(" + JSONObject.quote(response) + ")");
                else callJs("window.DropVault.onUsageResetError(" + JSONObject.quote(apiError(response)) + ")");
            } catch (Exception error) {
                callJs("window.DropVault.onUsageResetError(" + JSONObject.quote("网络异常，请重试") + ")");
            } finally { if (connection != null) connection.disconnect(); }
        });
    }

    private void requestStreamDetail(String conversationId, String messageId, String entryId) {
        requestChat("conversations/" + conversationId + "/messages/" + messageId +
            "/stream/" + entryId,
            "window.DropVault.onStreamDetail", "window.DropVault.onStreamDetailError");
    }

    private void createConversation(String model, String reasoning, String accessMode,
                                    String workDir, String codexProfile) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("chat/conversations", "POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                byte[] body = new JSONObject()
                    .put("model", model)
                    .put("reasoning", reasoning)
                    .put("accessMode", accessMode)
                    .put("workDir", workDir == null ? "" : workDir.trim())
                    .put("codexProfile", codexProfile == null ? "default" : codexProfile)
                    .toString().getBytes(StandardCharsets.UTF_8);
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                String response = readBody(connection.getResponseCode() < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (connection.getResponseCode() >= 200 && connection.getResponseCode() < 300) {
                    callJs("window.DropVault.onConversationCreated(" + JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onChatError(" + JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onChatError(" + JSONObject.quote("网络异常，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void updateConversationSettings(String id, String model, String reasoning, String accessMode) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                byte[] body = new JSONObject()
                    .put("model", model)
                    .put("reasoning", reasoning)
                    .put("accessMode", accessMode)
                    .toString().getBytes(StandardCharsets.UTF_8);
                connection = openApiConnection("chat/conversations/" + id, "PATCH");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onSettingsUpdated(" + JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onChatError(" + JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onChatError(" + JSONObject.quote("设置保存失败，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void updateConversationProject(String id, String workDir) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                byte[] body = new JSONObject()
                    .put("workDir", workDir == null ? "" : workDir.trim())
                    .toString().getBytes(StandardCharsets.UTF_8);
                connection = openApiConnection("chat/conversations/" + id, "PATCH");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onConversationProjectUpdated(" +
                        JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onConversationProjectError(" +
                        JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onConversationProjectError(" +
                    JSONObject.quote("项目切换失败，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void sendChatMessage(String conversationId, String text, String attachmentIdsJson) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                JSONArray attachmentIds;
                try { attachmentIds = new JSONArray(attachmentIdsJson); }
                catch (Exception ignored) { attachmentIds = new JSONArray(); }
                JSONObject payload = new JSONObject()
                    .put("text", text)
                    .put("attachmentIds", attachmentIds);
                byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
                connection = openApiConnection("chat/conversations/" + conversationId + "/messages", "POST");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(body.length);
                try (OutputStream output = connection.getOutputStream()) { output.write(body); }
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onMessageSent(" + JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onMessageSendError(" + JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onMessageSendError(" + JSONObject.quote("网络异常，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void interruptConversation(String conversationId) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection(
                    "chat/conversations/" + conversationId + "/interrupt", "POST");
                connection.setDoOutput(true);
                connection.setFixedLengthStreamingMode(0);
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onConversationInterruptRequested(" +
                        JSONObject.quote(response) + ")");
                } else {
                    callJs("window.DropVault.onConversationInterruptError(" +
                        JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onConversationInterruptError(" +
                    JSONObject.quote("网络异常，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void archiveConversation(String id) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("chat/conversations/" + id, "DELETE");
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs("window.DropVault.onConversationArchived(" + JSONObject.quote(id) + ")");
                } else {
                    callJs("window.DropVault.onChatError(" + JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs("window.DropVault.onChatError(" + JSONObject.quote("网络异常，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private void downloadArtifact(String conversationId, String messageId, String artifactId,
                                  String name, String mimeType) {
        runOnUiThread(() -> {
            try {
                String safeName = name == null ? "交付文件" : name
                    .replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_")
                    .replaceAll("^\\.+", "");
                if (safeName.trim().isEmpty()) safeName = "交付文件";
                String destinationName = System.currentTimeMillis() + "-" + safeName;
                Uri uri = Uri.parse(BuildConfig.API_URL + "chat/conversations/" + conversationId +
                    "/messages/" + messageId + "/artifacts/" + artifactId);
                DownloadManager.Request request = new DownloadManager.Request(uri)
                    .addRequestHeader("Authorization", "Bearer " + apiToken())
                    .setTitle(safeName)
                    .setDescription("正在下载 Witt 交付文件")
                    .setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setAllowedOverMetered(true)
                    .setAllowedOverRoaming(false)
                    .setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS, "Witt/" + destinationName);
                if (mimeType != null && !mimeType.isEmpty()) request.setMimeType(mimeType);
                DownloadManager manager =
                    (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                long downloadId = manager.enqueue(request);
                artifactDownloads.put(downloadId, safeName);
                Toast.makeText(this, "已开始下载 " + safeName, Toast.LENGTH_SHORT).show();
            } catch (Exception error) {
                Toast.makeText(this, "无法下载交付文件", Toast.LENGTH_LONG).show();
            }
        });
    }

    private void downloadImage(String rawUrl, String name, String mimeType) {
        runOnUiThread(() -> {
            try {
                Uri uri = Uri.parse(rawUrl);
                if (!"https".equalsIgnoreCase(uri.getScheme()) ||
                    !"upload.16.208.20.133.sslip.io".equalsIgnoreCase(uri.getHost()) ||
                    uri.getPath() == null || !uri.getPath().matches("^/vault-api/chat-images/[a-f0-9-]{36}$")) {
                    throw new IllegalArgumentException("invalid image url");
                }
                String safeName = name == null ? "Witt 图片" : name
                    .replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_")
                    .replaceAll("^\\.+", "");
                if (safeName.trim().isEmpty()) safeName = "Witt 图片";
                if (!safeName.matches(".*\\.[A-Za-z0-9]{2,5}$")) {
                    safeName += "image/jpeg".equalsIgnoreCase(mimeType) ? ".jpg" : ".png";
                }
                DownloadManager.Request request = new DownloadManager.Request(uri)
                    .setTitle(safeName)
                    .setDescription("正在下载 Witt 会话图片")
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setAllowedOverMetered(true)
                    .setAllowedOverRoaming(false)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                        "Witt/" + System.currentTimeMillis() + "-" + safeName);
                String token = apiToken();
                if (!token.isEmpty()) request.addRequestHeader("Authorization", "Bearer " + token);
                if (mimeType != null && mimeType.startsWith("image/")) request.setMimeType(mimeType);
                DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
                long downloadId = manager.enqueue(request);
                artifactDownloads.put(downloadId, safeName);
                Toast.makeText(this, "已开始下载 " + safeName, Toast.LENGTH_SHORT).show();
            } catch (Exception error) {
                Toast.makeText(this, "无法下载图片", Toast.LENGTH_LONG).show();
            }
        });
    }

    private void requestChat(String endpoint, String successCallback, String errorCallback) {
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = openApiConnection("chat/" + endpoint, "GET");
                int status = connection.getResponseCode();
                String response = readBody(status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream());
                if (status >= 200 && status < 300) {
                    callJs(successCallback + "(" + JSONObject.quote(response) + ")");
                } else {
                    callJs(errorCallback + "(" + JSONObject.quote(apiError(response)) + ")");
                }
            } catch (Exception error) {
                callJs(errorCallback + "(" + JSONObject.quote("网络异常，请重试") + ")");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    private String apiError(String body) {
        try { return new JSONObject(body).optString("error", "服务器暂时无法处理"); }
        catch (Exception ignored) { return "服务器暂时无法处理"; }
    }

    private String readBody(InputStream stream) throws Exception {
        if (stream == null) return "";
        try (BufferedInputStream input = new BufferedInputStream(stream);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int read;
            while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private void uploadProgress(String id, int percent) {
        callJs("window.DropVault.onUploadProgress(" + JSONObject.quote(id) + "," + percent + ")");
    }

    private void uploadFinished(String id, boolean success, String message, String responseJson) {
        callJs("window.DropVault.onUploadFinished(" + JSONObject.quote(id) + "," + success + "," +
            JSONObject.quote(message) + "," + JSONObject.quote(responseJson) + ")");
    }

    private void callJs(String script) {
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(script, null);
        });
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 41);
        }
    }

    private void requestStoragePermission() {
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
            checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) !=
                PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE}, 42);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.resumeTimers();
            webView.onResume();
            webView.evaluateJavascript(
                "window.DropVault&&window.DropVault.onAppVisibility&&window.DropVault.onAppVisibility(true)",
                null);
        }
        UpdateManager.tryInstallPending(this);
        updateHandler.removeCallbacks(foregroundUpdateCheck);
        updateHandler.postDelayed(foregroundUpdateCheck, 1200L);
    }

    @Override
    protected void onPause() {
        updateHandler.removeCallbacks(foregroundUpdateCheck);
        if (webView != null) {
            webView.evaluateJavascript(
                "window.DropVault&&window.DropVault.onAppVisibility&&window.DropVault.onAppVisibility(false)",
                null);
            webView.onPause();
            webView.pauseTimers();
        }
        super.onPause();
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent.getBooleanExtra("open_update", false)) {
            UpdateManager.check(this, true);
        }
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        applyOrientationChrome();
    }

    @Override
    protected void onDestroy() {
        updateHandler.removeCallbacks(foregroundUpdateCheck);
        if (receiverRegistered) unregisterReceiver(downloadReceiver);
        network.shutdownNow();
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    public final class WebBridge {
        @JavascriptInterface public void launchSurfaceReady() {
            runOnUiThread(MainActivity.this::dismissLaunchSurface);
        }
        @JavascriptInterface public void contentReady(String themeMode) {
            runOnUiThread(() -> MainActivity.this.applySystemBars(themeMode));
        }
        @JavascriptInterface public void requestAuthStatus() { MainActivity.this.requestAuthStatus(); }
        @JavascriptInterface public void activateInvite(String code) { MainActivity.this.activateInvite(code); }
        @JavascriptInterface public String getCacheScope() { return cacheScope(); }
        @JavascriptInterface public boolean hasBundledLumoraMedia() { return true; }
        @JavascriptInterface public void requestAdminDevices() { MainActivity.this.requestAdmin("admin/devices", "GET", null, "window.DropVault.onAdminDevices"); }
        @JavascriptInterface public void requestCodexAccounts() { MainActivity.this.requestAdmin("codex/accounts", "GET", null, "window.DropVault.onCodexAccounts"); }
        @JavascriptInterface public void startXuanyuCodexLogin() { MainActivity.this.requestAdmin("codex/accounts/xuanyu/login/start", "POST", "{}", "window.DropVault.onCodexLoginStarted"); }
        @JavascriptInterface public void requestXuanyuCodexLoginStatus() { MainActivity.this.requestAdmin("codex/accounts/xuanyu/login/status", "GET", null, "window.DropVault.onCodexLoginStatus"); }
        @JavascriptInterface public void cancelXuanyuCodexLogin() { MainActivity.this.requestAdmin("codex/accounts/xuanyu/login/cancel", "POST", "{}", "window.DropVault.onCodexLoginCancelled"); }
        @JavascriptInterface public void createInvite(String label, int maxDevices) {
            try { MainActivity.this.requestAdmin("admin/invites", "POST", new JSONObject().put("label", label).put("maxDevices", maxDevices).toString(), "window.DropVault.onInviteCreated"); }
            catch (Exception error) { callJs("window.DropVault.onAdminError('无法创建邀请码')"); }
        }
        @JavascriptInterface public void disableDevice(String id) { MainActivity.this.requestAdmin("admin/devices/" + id + "/disable", "POST", "{}", "window.DropVault.onDeviceDisabled"); }
        @JavascriptInterface public void pickFiles() { runOnUiThread(MainActivity.this::chooseFiles); }
        @JavascriptInterface public void uploadFile(String id) { upload(id); }
        @JavascriptInterface public void requestHistory() { MainActivity.this.requestHistory(); }
        @JavascriptInterface public void requestTasks() { MainActivity.this.requestTasks(); }
        @JavascriptInterface public void submitTask(String prompt) { MainActivity.this.submitTask(prompt); }
        @JavascriptInterface public void requestConversations() { MainActivity.this.requestConversations(); }
        @JavascriptInterface public void requestCapabilities() { MainActivity.this.requestCapabilities(); }
        @JavascriptInterface public void requestConversation(String id) { MainActivity.this.requestConversation(id); }
        @JavascriptInterface public void requestConversationDelta(String id) { MainActivity.this.requestConversationDelta(id); }
        @JavascriptInterface public void requestUsage(String conversationId) { MainActivity.this.requestUsage(conversationId); }
        @JavascriptInterface public void consumeRateLimitReset() { MainActivity.this.consumeRateLimitReset(); }
        @JavascriptInterface public void requestStreamDetail(
                String conversationId, String messageId, String entryId) {
            MainActivity.this.requestStreamDetail(conversationId, messageId, entryId);
        }
        @JavascriptInterface public void createConversation(String model, String reasoning, String accessMode) {
            MainActivity.this.createConversation(model, reasoning, accessMode, "", "default");
        }
        @JavascriptInterface public void createConversationWithPath(
                String model, String reasoning, String accessMode, String workDir) {
            MainActivity.this.createConversation(model, reasoning, accessMode, workDir, "default");
        }
        @JavascriptInterface public void createConversationWithProfile(
                String model, String reasoning, String accessMode, String workDir,
                String codexProfile) {
            MainActivity.this.createConversation(
                model, reasoning, accessMode, workDir, codexProfile);
        }
        @JavascriptInterface public void updateConversationSettings(
                String id, String model, String reasoning, String accessMode) {
            MainActivity.this.updateConversationSettings(id, model, reasoning, accessMode);
        }
        @JavascriptInterface public void updateConversationProject(String id, String workDir) {
            MainActivity.this.updateConversationProject(id, workDir);
        }
        @JavascriptInterface public void sendChatMessage(String id, String text, String attachmentIdsJson) {
            MainActivity.this.sendChatMessage(id, text, attachmentIdsJson);
        }
        @JavascriptInterface public void interruptConversation(String id) {
            MainActivity.this.interruptConversation(id);
        }
        @JavascriptInterface public void archiveConversation(String id) { MainActivity.this.archiveConversation(id); }
        @JavascriptInterface public void forkConversation(String id) {
            MainActivity.this.conversationAction(id, "fork", new JSONObject(),
                "window.DropVault.onConversationForked");
        }
        @JavascriptInterface public void compactConversation(String id) {
            MainActivity.this.conversationAction(id, "compact", new JSONObject(),
                "window.DropVault.onConversationCompacted");
        }
        @JavascriptInterface public void reviewConversation(String id) {
            try {
                MainActivity.this.conversationAction(id, "review",
                    new JSONObject().put("type", "uncommittedChanges"),
                    "window.DropVault.onReviewStarted");
            } catch (Exception ignored) {}
        }
        @JavascriptInterface public void resolveApproval(
                String conversationId, String approvalId, String choiceId) {
            MainActivity.this.resolveApproval(conversationId, approvalId, choiceId);
        }
        @JavascriptInterface public void downloadArtifact(
                String conversationId, String messageId, String artifactId, String name, String mimeType) {
            MainActivity.this.downloadArtifact(conversationId, messageId, artifactId, name, mimeType);
        }
        @JavascriptInterface public void downloadImage(String url, String name, String mimeType) {
            MainActivity.this.downloadImage(url, name, mimeType);
        }
        @JavascriptInterface public void checkForUpdates() { runOnUiThread(() -> UpdateManager.check(MainActivity.this, true)); }
        @JavascriptInterface public String getVersion() { return BuildConfig.VERSION_NAME; }
    }

    private static final class PickedFile {
        final String id;
        final Uri uri;
        final String name;
        final long size;
        final String type;
        PickedFile(String id, Uri uri, String name, long size, String type) {
            this.id = id;
            this.uri = uri;
            this.name = name;
            this.size = size;
            this.type = type;
        }
    }
}
