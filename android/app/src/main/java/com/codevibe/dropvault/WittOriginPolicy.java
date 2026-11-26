package com.codevibe.dropvault;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Enforces trusted origin boundaries, manages primary/standby failover,
 * and proxies authenticated chat-image requests for the WebView.
 */
final class WittOriginPolicy {
    private static final String CHAT_IMAGE_PATH_REGEX = "^/vault-api/chat-images/[a-f0-9-]{36}$";

    private final String primaryWebUrl;
    private final String primaryApiUrl;
    private final String fallbackWebUrl;
    private final String fallbackApiUrl;
    private volatile boolean usingStandby;
    private boolean standbyAttempted;

    WittOriginPolicy() {
        this(BuildConfig.WEB_URL, BuildConfig.API_URL,
            BuildConfig.FALLBACK_WEB_URL, BuildConfig.FALLBACK_API_URL);
    }

    WittOriginPolicy(String primaryWebUrl, String primaryApiUrl,
                     String fallbackWebUrl, String fallbackApiUrl) {
        this.primaryWebUrl = primaryWebUrl;
        this.primaryApiUrl = primaryApiUrl;
        this.fallbackWebUrl = fallbackWebUrl;
        this.fallbackApiUrl = fallbackApiUrl;
    }

    static String hostOf(String rawUrl) {
        try { return Uri.parse(rawUrl).getHost(); } catch (Exception ignored) { return ""; }
    }

    static String originOf(String rawUrl) {
        try {
            Uri uri = Uri.parse(rawUrl);
            return uri.getScheme() + "://" + uri.getAuthority();
        } catch (Exception ignored) {
            return "";
        }
    }

    boolean isTrustedWittHost(String host) {
        return host != null && (host.equalsIgnoreCase(hostOf(primaryWebUrl)) ||
            host.equalsIgnoreCase(hostOf(fallbackWebUrl)));
    }

    boolean isStandbyHost(String host) {
        return host != null && host.equalsIgnoreCase(hostOf(fallbackWebUrl));
    }

    boolean isTrustedChatImageUri(Uri uri) {
        return uri != null &&
            "https".equalsIgnoreCase(uri.getScheme()) &&
            isTrustedWittHost(uri.getHost()) &&
            uri.getPath() != null &&
            uri.getPath().matches(CHAT_IMAGE_PATH_REGEX);
    }

    Set<String> trustedWebOrigins() {
        Set<String> origins = new HashSet<>();
        origins.add(originOf(primaryWebUrl));
        origins.add(originOf(fallbackWebUrl));
        origins.remove("");
        return origins;
    }

    String activeApiUrl() {
        return usingStandby ? fallbackApiUrl : primaryApiUrl;
    }

    String activeWebUrl() {
        return usingStandby ? fallbackWebUrl : primaryWebUrl;
    }

    boolean isUsingStandby() {
        return usingStandby;
    }

    void onPageStarted(String url) {
        usingStandby = isStandbyHost(hostOf(url));
    }

    boolean tryStandby(WebView view, Uri failedUri) {
        if (standbyAttempted || usingStandby || failedUri == null ||
            !hostOf(primaryWebUrl).equalsIgnoreCase(failedUri.getHost())) return false;
        standbyAttempted = true;
        usingStandby = true;
        view.stopLoading();
        view.loadUrl(fallbackWebUrl);
        return true;
    }

    WebResourceResponse protectedImageResponse(WebResourceRequest request, String token) {
        Uri uri = request.getUrl();
        if (!"GET".equalsIgnoreCase(request.getMethod()) || !isTrustedChatImageUri(uri)) return null;
        if (token == null || token.isEmpty()) return null;
        try {
            HttpURLConnection connection = (HttpURLConnection) new URL(uri.toString()).openConnection();
            connection.setConnectTimeout(15_000);
            connection.setReadTimeout(60_000);
            connection.setRequestProperty("Authorization", "Bearer " + token);
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                connection.disconnect();
                return new WebResourceResponse("text/plain", "UTF-8", status,
                    "Image request failed", Collections.singletonMap("Cache-Control", "no-store"),
                    new ByteArrayInputStream(new byte[0]));
            }
            String contentType = connection.getContentType();
            String mimeType = contentType == null ? "image/jpeg" : contentType.split(";", 2)[0];
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "private, max-age=300");
            headers.put("X-Content-Type-Options", "nosniff");
            return new WebResourceResponse(mimeType, null, status, "OK", headers,
                new BufferedInputStream(connection.getInputStream()));
        } catch (Exception ignored) {
            return null;
        }
    }
}
