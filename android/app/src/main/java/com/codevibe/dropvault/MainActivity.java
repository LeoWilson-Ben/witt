package com.codevibe.dropvault;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.SafeBrowsingResponse;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.annotation.RequiresApi;
import androidx.core.content.ContextCompat;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewCompat;

import org.json.JSONObject;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends Activity {
    private static final int PICK_FILES = 8102;
    private static final int PICK_SFTP_UPLOAD = 8103;
    private static final int CREATE_SFTP_DOWNLOAD = 8104;

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

    private final WebBridge webBridge = new WebBridge();
    private AuthTokenStore authStore;
    private WittOriginPolicy originPolicy;
    private WittApiClient apiClient;
    private FileTransferController fileTransfer;
    private ConversationEventStream eventStream;
    private LocalSshManager localSsh;

    private WebView webView;
    private FrameLayout rootView;
    private WittLaunchView launchView;
    private boolean receiverRegistered;
    private String pendingSftpDirectory = ".";
    private String pendingSftpDownloadPath = "";

    private final BroadcastReceiver downloadReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) {
                long downloadId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                String artifactName = fileTransfer != null
                    ? fileTransfer.consumeCompletedDownload(downloadId) : null;
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

        authStore = new AuthTokenStore(this);
        originPolicy = new WittOriginPolicy();
        apiClient = new WittApiClient(network, originPolicy, authStore, this::callJs);
        fileTransfer = new FileTransferController(this, network, originPolicy, authStore,
            new FileTransferController.Callbacks() {
                @Override public void onFilesPicked(String filesJson) {
                    callJs("window.DropVault.onFilesPicked(" + JSONObject.quote(filesJson) + ")");
                }
                @Override public void onUploadProgress(String id, int percent) {
                    callJs("window.DropVault.onUploadProgress(" + JSONObject.quote(id) + "," + percent + ")");
                }
                @Override public void onUploadFinished(
                        String id, boolean success, String message, String responseJson) {
                    callJs("window.DropVault.onUploadFinished(" + JSONObject.quote(id) + "," +
                        success + "," + JSONObject.quote(message) + "," +
                        JSONObject.quote(responseJson) + ")");
                }
            });
        eventStream = new ConversationEventStream(
            network,
            apiClient::openApiConnection,
            () -> !authStore.apiToken().isEmpty(),
            new ConversationEventStream.Listener() {
                @Override public void onSnapshot(String data) {
                    callJs("window.DropVault.onConversation(" + JSONObject.quote(data) + ")");
                }
                @Override public void onDelta(String data) {
                    callJs("window.DropVault.onConversationDelta(" + JSONObject.quote(data) + ")");
                }
            });
        localSsh = new LocalSshManager(this, new LocalSshManager.Callback() {
            @Override public void onStatus(String json) {
                callJs("window.DropVault.onLocalSshStatus(" + JSONObject.quote(json) + ")");
            }
            @Override public void onProfiles(String json) {
                callJs("window.DropVault.onLocalSshProfiles(" + JSONObject.quote(json) + ")");
            }
            @Override public void onProfileError(String message) {
                callJs("window.DropVault.onLocalSshProfileError(" + JSONObject.quote(message) + ")");
            }
            @Override public void onConnected(String json) {
                callJs("window.DropVault.onLocalSshConnected(" + JSONObject.quote(json) + ")");
            }
            @Override public void onOutput(String text) {
                callJs("window.DropVault.onLocalSshOutput(" + JSONObject.quote(text) + ")");
            }
            @Override public void onError(String message) {
                callJs("window.DropVault.onLocalSshError(" + JSONObject.quote(message) + ")");
            }
            @Override public void onDisconnected() {
                callJs("window.DropVault.onLocalSshDisconnected()");
            }
            @Override public void onSftpList(String json) {
                callJs("window.DropVault.onLocalSftpList(" + JSONObject.quote(json) + ")");
            }
            @Override public void onSftpError(String message) {
                callJs("window.DropVault.onLocalSftpError(" + JSONObject.quote(message) + ")");
            }
            @Override public void onSftpComplete(String operation, String path) {
                callJs("window.DropVault.onLocalSftpComplete(" + JSONObject.quote(operation) +
                    "," + JSONObject.quote(path) + ")");
            }
        });

        boolean systemDark = (getResources().getConfiguration().uiMode
            & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        applySystemBars(systemDark ? "dark" : "light");

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
        WittBridgeDispatcher.WorkspaceCallbacks workspaceCallbacks =
            new WittBridgeDispatcher.WorkspaceCallbacks() {
                @Override public void workspaceRequest(
                        String endpoint, String method, String json, String requestId) {
                    apiClient.workspaceRequest(endpoint, method, json, requestId);
                }
                @Override public void taskNotificationSettings(String json) {
                    MainActivity.this.taskNotificationSettings(json);
                }
                @Override public void watchTasks(String json) {
                    TaskNotificationMonitor.snapshot(
                        MainActivity.this, json, originPolicy.activeApiUrl());
                }
            };
        WebViewCompat.addWebMessageListener(webView, "WittNative",
            originPolicy.trustedWebOrigins(),
            (view, message, sourceOrigin, isMainFrame, replyProxy) -> {
                if (!isMainFrame || sourceOrigin == null ||
                    !originPolicy.isTrustedWittHost(sourceOrigin.getHost())) return;
                WittBridgeDispatcher.dispatch(message.getData(), webBridge, workspaceCallbacks);
            });
        webView.setWebChromeClient(new WebChromeClient());
        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
            .build();
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(
                    WebView view, WebResourceRequest request) {
                WebResourceResponse local = assetLoader.shouldInterceptRequest(request.getUrl());
                if (local != null) return local;
                return originPolicy.protectedImageResponse(request, authStore.apiToken());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (originPolicy.isTrustedWittHost(uri.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    Toast.makeText(MainActivity.this, "无法打开链接", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                originPolicy.onPageStarted(url);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                try {
                    JSONObject info = new JSONObject()
                        .put("version", BuildConfig.VERSION_NAME)
                        .put("cacheScope", authStore.cacheScope())
                        .put("supportsSse", true)
                        .put("openAccess", BuildConfig.OPEN_ACCESS)
                        .put("taskNotifications", true)
                        .put("workspaceOperations", true)
                        .put("workspaceFeatures", true)
                        .put("bundledLumoraMedia", true)
                        .put("nativeLaunch", true);
                    callJs("window.DropVault&&window.DropVault.nativeReady(" + info + ")");
                    openNotificationConversation();
                } catch (Exception ignored) {}
            }

            @Override
            public void onReceivedError(
                    WebView view, WebResourceRequest request, WebResourceError error) {
                if (!request.isForMainFrame()) return;
                if (originPolicy.tryStandby(view, request.getUrl())) return;
                String retryUrl = originPolicy.activeWebUrl();
                String html = "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'>" +
                    "<style>body{min-height:100vh;margin:0;display:grid;place-content:center;text-align:center;font-family:sans-serif;background:#f5f8ff;color:#263952}button{margin:18px auto;padding:12px 20px;border:0;border-radius:12px;color:white;background:#566fe8}</style>" +
                    "<h2>暂时无法连接 Witt</h2><p>请检查网络后重试</p><button onclick='location.href=\"" + retryUrl + "\"'>重新连接</button>" +
                    "<script>window.WittNative?.postMessage(JSON.stringify({method:'contentReady',args:['light']}));</script>";
                view.loadDataWithBaseURL(retryUrl, html, "text/html", "UTF-8", null);
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            WebResourceResponse errorResponse) {
                if (request.isForMainFrame() && errorResponse.getStatusCode() >= 500) {
                    originPolicy.tryStandby(view, request.getUrl());
                }
            }

            @Override
            @RequiresApi(Build.VERSION_CODES.O_MR1)
            public void onSafeBrowsingHit(WebView view, WebResourceRequest request,
                                          int threatType, SafeBrowsingResponse callback) {
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

    private void chooseSftpUpload(String directory) {
        pendingSftpDirectory = directory == null || directory.isEmpty() ? "." : directory;
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*");
        startActivityForResult(intent, PICK_SFTP_UPLOAD);
    }

    private void chooseSftpDownload(String remotePath, String name) {
        pendingSftpDownloadPath = remotePath == null ? "" : remotePath;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/octet-stream")
            .putExtra(Intent.EXTRA_TITLE, name == null || name.isEmpty() ? "file" : name);
        startActivityForResult(intent, CREATE_SFTP_DOWNLOAD);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (resultCode != RESULT_OK || data == null) return;
        if (requestCode == PICK_SFTP_UPLOAD) {
            Uri uri = data.getData();
            if (uri != null && localSsh != null) {
                localSsh.uploadSftp(uri, pendingSftpDirectory, fileTransfer.displayName(uri));
            }
            return;
        }
        if (requestCode == CREATE_SFTP_DOWNLOAD) {
            Uri uri = data.getData();
            if (uri != null && localSsh != null && !pendingSftpDownloadPath.isEmpty()) {
                localSsh.downloadSftp(pendingSftpDownloadPath, uri);
            }
            return;
        }
        if (requestCode == PICK_FILES) {
            fileTransfer.handlePickedFilesResult(data);
        }
    }

    private void taskNotificationSettings(String json) {
        runOnUiThread(() -> {
            try {
                JSONObject value = new JSONObject(json == null || json.isEmpty() ? "{}" : json);
                boolean permitted = Build.VERSION.SDK_INT < 33 ||
                    checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                        == PackageManager.PERMISSION_GRANTED;
                if (value.has("enabled")) {
                    boolean enable = value.optBoolean("enabled");
                    if (enable && !permitted) requestNotificationPermission();
                    TaskNotificationMonitor.configure(
                        this, enable && permitted, originPolicy.activeApiUrl());
                }
                JSONObject state = new JSONObject()
                    .put("enabled", TaskNotificationMonitor.enabled(this))
                    .put("permission", permitted)
                    .put("supported", true);
                callJs("window.WittFeatures?.onNotificationSettings(" + state + ")");
            } catch (Exception ignored) {}
        });
    }

    private void openNotificationConversation() {
        String id = getIntent().getStringExtra("open_conversation");
        if (id == null || !id.matches("[a-f0-9-]{36}")) return;
        getIntent().removeExtra("open_conversation");
        if (webView != null) {
            webView.postDelayed(
                () -> callJs("window.WittFeatures?.openConversation(" + JSONObject.quote(id) + ")"),
                1000L);
        }
    }

    private void callJs(String script) {
        runOnUiThread(() -> {
            if (webView != null) webView.evaluateJavascript(script, null);
        });
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 41);
        }
    }

    private void requestStoragePermission() {
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P &&
            checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
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
        eventStream.onResume();
    }

    @Override
    protected void onPause() {
        updateHandler.removeCallbacks(foregroundUpdateCheck);
        eventStream.onPause();
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
        openNotificationConversation();
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
        if (eventStream != null) eventStream.unsubscribe();
        if (localSsh != null) localSsh.shutdown();
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
            // The native initialization surface stays until usable content is ready.
        }
        @JavascriptInterface public void contentReady(String themeMode) {
            runOnUiThread(() -> {
                MainActivity.this.applySystemBars(themeMode);
                MainActivity.this.dismissLaunchSurface();
            });
        }
        @JavascriptInterface public void requestAuthStatus() { apiClient.requestAuthStatus(); }
        @JavascriptInterface public void activateInvite(String code) { apiClient.activateInvite(code); }
        @JavascriptInterface public String getCacheScope() { return authStore.cacheScope(); }
        @JavascriptInterface public boolean hasBundledLumoraMedia() { return true; }
        @JavascriptInterface public void requestAdminDevices() {
            apiClient.requestAdmin("admin/devices", "GET", null, "window.DropVault.onAdminDevices");
        }
        @JavascriptInterface public void requestCodexAccounts() {
            apiClient.requestAdmin("codex/accounts", "GET", null, "window.DropVault.onCodexAccounts");
        }
        private void codexLoginRequest(String profile, String action, String method, String callback) {
            if (profile == null || !profile.matches("^(xuanyu|account4|account5)$")) {
                callJs("window.DropVault.onAdminError('账号配置不存在')");
                return;
            }
            apiClient.requestAdmin("codex/accounts/" + profile + "/login/" + action,
                method, "POST".equals(method) ? "{}" : null, callback);
        }
        @JavascriptInterface public void startCodexLogin(String profile) {
            codexLoginRequest(profile, "start", "POST", "window.DropVault.onCodexLoginStarted");
        }
        @JavascriptInterface public void requestCodexLoginStatus(String profile) {
            codexLoginRequest(profile, "status", "GET", "window.DropVault.onCodexLoginStatus");
        }
        @JavascriptInterface public void cancelCodexLogin(String profile) {
            codexLoginRequest(profile, "cancel", "POST", "window.DropVault.onCodexLoginCancelled");
        }
        @JavascriptInterface public void startXuanyuCodexLogin() {
            apiClient.requestAdmin("codex/accounts/xuanyu/login/start", "POST", "{}",
                "window.DropVault.onCodexLoginStarted");
        }
        @JavascriptInterface public void requestXuanyuCodexLoginStatus() {
            apiClient.requestAdmin("codex/accounts/xuanyu/login/status", "GET", null,
                "window.DropVault.onCodexLoginStatus");
        }
        @JavascriptInterface public void cancelXuanyuCodexLogin() {
            apiClient.requestAdmin("codex/accounts/xuanyu/login/cancel", "POST", "{}",
                "window.DropVault.onCodexLoginCancelled");
        }
        @JavascriptInterface public void createInvite(String label, int maxDevices) {
            if (BuildConfig.OPEN_ACCESS) {
                callJs("window.DropVault.onAdminError('开放版不提供激活码分发')");
                return;
            }
            try {
                apiClient.requestAdmin("admin/invites", "POST",
                    new JSONObject().put("label", label).put("maxDevices", maxDevices).toString(),
                    "window.DropVault.onInviteCreated");
            } catch (Exception error) {
                callJs("window.DropVault.onAdminError('无法创建邀请码')");
            }
        }
        @JavascriptInterface public void disableDevice(String id) {
            apiClient.requestAdmin("admin/devices/" + id + "/disable", "POST", "{}",
                "window.DropVault.onDeviceDisabled");
        }
        @JavascriptInterface public void pickFiles() {
            runOnUiThread(() -> fileTransfer.chooseFiles(PICK_FILES));
        }
        @JavascriptInterface public void uploadFile(String id) { fileTransfer.upload(id); }
        @JavascriptInterface public void requestHistory() { apiClient.requestHistory(); }
        @JavascriptInterface public void requestTasks() { apiClient.requestTasks(); }
        @JavascriptInterface public void submitTask(String prompt) { apiClient.submitTask(prompt); }
        @JavascriptInterface public void requestConversations() { apiClient.requestConversations(); }
        @JavascriptInterface public void requestCapabilities() { apiClient.requestCapabilities(); }
        @JavascriptInterface public void requestConversation(String id) { apiClient.requestConversation(id); }
        @JavascriptInterface public void requestConversationDelta(String id) {
            apiClient.requestConversationDelta(id);
        }
        @JavascriptInterface public void subscribeConversationEvents(String id) {
            eventStream.subscribe(id);
        }
        @JavascriptInterface public void unsubscribeConversationEvents() {
            eventStream.unsubscribe();
        }
        @JavascriptInterface public void requestUsage(String conversationId) {
            apiClient.requestUsage(conversationId);
        }
        @JavascriptInterface public void consumeRateLimitReset(String conversationId) {
            apiClient.consumeRateLimitReset(conversationId);
        }
        @JavascriptInterface public void requestStreamDetail(
                String conversationId, String messageId, String entryId) {
            apiClient.requestStreamDetail(conversationId, messageId, entryId);
        }
        @JavascriptInterface public void createConversation(
                String model, String reasoning, String accessMode) {
            apiClient.createConversation(model, reasoning, accessMode, "", "default");
        }
        @JavascriptInterface public void createConversationWithPath(
                String model, String reasoning, String accessMode, String workDir) {
            apiClient.createConversation(model, reasoning, accessMode, workDir, "default");
        }
        @JavascriptInterface public void createConversationWithProfile(
                String model, String reasoning, String accessMode, String workDir,
                String codexProfile) {
            apiClient.createConversation(model, reasoning, accessMode, workDir, codexProfile);
        }
        @JavascriptInterface public void updateConversationSettings(
                String id, String model, String reasoning, String accessMode) {
            apiClient.updateConversationSettings(id, model, reasoning, accessMode);
        }
        @JavascriptInterface public void updateConversationProject(String id, String workDir) {
            apiClient.updateConversationProject(id, workDir);
        }
        @JavascriptInterface public void sendChatMessage(
                String id, String text, String attachmentIdsJson) {
            apiClient.sendChatMessage(id, text, attachmentIdsJson);
        }
        @JavascriptInterface public void interruptConversation(String id) {
            apiClient.interruptConversation(id);
        }
        @JavascriptInterface public void archiveConversation(String id) {
            apiClient.archiveConversation(id);
        }
        @JavascriptInterface public void forkConversation(String id) {
            apiClient.conversationAction(id, "fork", new JSONObject(),
                "window.DropVault.onConversationForked");
        }
        @JavascriptInterface public void compactConversation(String id) {
            apiClient.conversationAction(id, "compact", new JSONObject(),
                "window.DropVault.onConversationCompacted");
        }
        @JavascriptInterface public void reviewConversation(String id) {
            try {
                apiClient.conversationAction(id, "review",
                    new JSONObject().put("type", "uncommittedChanges"),
                    "window.DropVault.onReviewStarted");
            } catch (Exception ignored) {}
        }
        @JavascriptInterface public void resolveApproval(
                String conversationId, String approvalId, String choiceId) {
            apiClient.resolveApproval(conversationId, approvalId, choiceId);
        }
        @JavascriptInterface public void downloadArtifact(
                String conversationId, String messageId, String artifactId, String name, String mimeType) {
            fileTransfer.downloadArtifact(conversationId, messageId, artifactId, name, mimeType);
        }
        @JavascriptInterface public void downloadImage(String url, String name, String mimeType) {
            fileTransfer.downloadImage(url, name, mimeType);
        }
        @JavascriptInterface public void requestLocalSshStatus() {
            if (localSsh != null) localSsh.requestStatus();
        }
        @JavascriptInterface public void requestLocalSshProfiles() {
            if (localSsh != null) localSsh.requestProfiles();
        }
        @JavascriptInterface public void connectLocalSsh(
                String host, String username, int port, String password) {
            if (localSsh != null) localSsh.connect(host, username, port, password);
        }
        @JavascriptInterface public void saveAndConnectLocalSsh(
                String label, String host, String username, int port, String password) {
            if (localSsh != null) {
                localSsh.connectAndRemember(label, host, username, port, password);
            }
        }
        @JavascriptInterface public void connectSavedLocalSsh(String profileId) {
            if (localSsh != null) localSsh.connectSaved(profileId);
        }
        @JavascriptInterface public void deleteSavedLocalSsh(String profileId) {
            if (localSsh != null) localSsh.deleteSaved(profileId);
        }
        @JavascriptInterface public void sendLocalSshInput(String input) {
            if (localSsh != null) localSsh.send(input);
        }
        @JavascriptInterface public void resizeLocalSsh(int columns, int rows) {
            if (localSsh != null) localSsh.resize(columns, rows);
        }
        @JavascriptInterface public void disconnectLocalSsh() {
            if (localSsh != null) localSsh.disconnect();
        }
        @JavascriptInterface public void requestLocalSftp(String path) {
            if (localSsh != null) localSsh.listSftp(path);
        }
        @JavascriptInterface public void pickLocalSftpUpload(String directory) {
            runOnUiThread(() -> chooseSftpUpload(directory));
        }
        @JavascriptInterface public void downloadLocalSftp(String path, String name) {
            runOnUiThread(() -> chooseSftpDownload(path, name));
        }
        @JavascriptInterface public void checkForUpdates() {
            runOnUiThread(() -> UpdateManager.check(MainActivity.this, true));
        }
        @JavascriptInterface public String getVersion() { return BuildConfig.VERSION_NAME; }
    }
}
