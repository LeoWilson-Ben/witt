package com.codevibe.dropvault;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Environment;
import android.provider.OpenableColumns;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;

/**
 * Handles document picking, streaming file uploads with progress callbacks,
 * and DownloadManager-backed artifact and image downloads.
 */
final class FileTransferController {
    private static final long MAX_FILE_BYTES = 500L * 1024L * 1024L;

    interface Callbacks {
        void onFilesPicked(String filesJson);
        void onUploadProgress(String id, int percent);
        void onUploadFinished(String id, boolean success, String message, String responseJson);
    }

    private final Activity activity;
    private final ExecutorService network;
    private final WittOriginPolicy originPolicy;
    private final AuthTokenStore authStore;
    private final Callbacks callbacks;
    private final Map<String, PickedFile> pickedFiles = new ConcurrentHashMap<>();
    private final Map<Long, String> artifactDownloads = new ConcurrentHashMap<>();

    FileTransferController(Activity activity, ExecutorService network,
                           WittOriginPolicy originPolicy, AuthTokenStore authStore,
                           Callbacks callbacks) {
        this.activity = activity;
        this.network = network;
        this.originPolicy = originPolicy;
        this.authStore = authStore;
        this.callbacks = callbacks;
    }

    void chooseFiles(int requestCode) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        activity.startActivityForResult(intent, requestCode);
    }

    void handlePickedFilesResult(Intent data) {
        JSONArray result = new JSONArray();
        if (data.getClipData() != null) {
            for (int index = 0; index < data.getClipData().getItemCount(); index++) {
                addPickedFile(data.getClipData().getItemAt(index).getUri(), result);
            }
        } else if (data.getData() != null) {
            addPickedFile(data.getData(), result);
        }
        callbacks.onFilesPicked(result.toString());
    }

    String displayName(Uri uri) {
        String name = "file";
        try (Cursor cursor = activity.getContentResolver().query(uri,
            new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0 && cursor.getString(index) != null) name = cursor.getString(index);
            }
        }
        return name;
    }

    private void addPickedFile(Uri uri, JSONArray output) {
        try {
            activity.getContentResolver().takePersistableUriPermission(
                uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Exception ignored) {}
        String id = UUID.randomUUID().toString();
        String name = "file";
        long size = -1L;
        try (Cursor cursor = activity.getContentResolver().query(uri,
            new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameIndex >= 0) name = cursor.getString(nameIndex);
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex);
            }
        }
        String type = activity.getContentResolver().getType(uri);
        if (size > MAX_FILE_BYTES) {
            Toast.makeText(activity, "单个文件不能超过 500 MB", Toast.LENGTH_LONG).show();
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

    void upload(String id) {
        PickedFile file = pickedFiles.get(id);
        if (file == null) {
            callbacks.onUploadFinished(id, false, "文件授权已失效，请重新选择", "");
            return;
        }
        network.execute(() -> {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(originPolicy.activeApiUrl() + "files")
                    .openConnection();
                connection.setRequestMethod("POST");
                connection.setDoOutput(true);
                connection.setConnectTimeout(15_000);
                connection.setReadTimeout(600_000);
                connection.setRequestProperty("Authorization", "Bearer " + authStore.apiToken());
                connection.setRequestProperty("Content-Type", "application/octet-stream");
                connection.setRequestProperty("X-File-Name",
                    URLEncoder.encode(file.name, StandardCharsets.UTF_8.name()).replace("+", "%20"));
                connection.setRequestProperty("X-File-Type", file.type);
                if (file.size > 0 && file.size <= Integer.MAX_VALUE) {
                    connection.setFixedLengthStreamingMode((int) file.size);
                } else {
                    connection.setChunkedStreamingMode(128 * 1024);
                }

                long sent = 0;
                long lastUpdate = 0;
                byte[] buffer = new byte[128 * 1024];
                try (InputStream input = activity.getContentResolver().openInputStream(file.uri);
                     OutputStream output = connection.getOutputStream()) {
                    if (input == null) throw new IllegalStateException("无法读取文件");
                    int read;
                    while ((read = input.read(buffer)) >= 0) {
                        output.write(buffer, 0, read);
                        sent += read;
                        long now = System.currentTimeMillis();
                        if (file.size > 0 && now - lastUpdate > 120) {
                            int percent = Math.min(99, (int) (sent * 100 / file.size));
                            callbacks.onUploadProgress(id, percent);
                            lastUpdate = now;
                        }
                    }
                }
                int status = connection.getResponseCode();
                InputStream response = status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream();
                String body = WittApiClient.readBody(response);
                if (status >= 200 && status < 300) {
                    pickedFiles.remove(id);
                    callbacks.onUploadFinished(id, true, "", body);
                } else {
                    String message = "上传失败";
                    try { message = new JSONObject(body).optString("error", message); }
                    catch (Exception ignored) {}
                    callbacks.onUploadFinished(id, false, message, "");
                }
            } catch (Exception error) {
                callbacks.onUploadFinished(id, false, "网络异常，请重试", "");
            } finally {
                if (connection != null) connection.disconnect();
            }
        });
    }

    void downloadArtifact(String conversationId, String messageId, String artifactId,
                          String name, String mimeType) {
        activity.runOnUiThread(() -> {
            try {
                String safeName = sanitizeFilename(name, "交付文件");
                String destinationName = System.currentTimeMillis() + "-" + safeName;
                Uri uri = Uri.parse(originPolicy.activeApiUrl() + "chat/conversations/" +
                    conversationId + "/messages/" + messageId + "/artifacts/" + artifactId);
                DownloadManager.Request request = new DownloadManager.Request(uri)
                    .addRequestHeader("Authorization", "Bearer " + authStore.apiToken())
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
                    (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
                long downloadId = manager.enqueue(request);
                artifactDownloads.put(downloadId, safeName);
                Toast.makeText(activity, "已开始下载 " + safeName, Toast.LENGTH_SHORT).show();
            } catch (Exception error) {
                Toast.makeText(activity, "无法下载交付文件", Toast.LENGTH_LONG).show();
            }
        });
    }

    void downloadImage(String rawUrl, String name, String mimeType) {
        activity.runOnUiThread(() -> {
            try {
                Uri uri = Uri.parse(rawUrl);
                if (!originPolicy.isTrustedChatImageUri(uri)) {
                    throw new IllegalArgumentException("invalid image url");
                }
                String safeName = sanitizeFilename(name, "Witt 图片");
                if (!safeName.matches(".*\\.[A-Za-z0-9]{2,5}$")) {
                    safeName += "image/jpeg".equalsIgnoreCase(mimeType) ? ".jpg" : ".png";
                }
                DownloadManager.Request request = new DownloadManager.Request(uri)
                    .setTitle(safeName)
                    .setDescription("正在下载 Witt 会话图片")
                    .setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setAllowedOverMetered(true)
                    .setAllowedOverRoaming(false)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS,
                        "Witt/" + System.currentTimeMillis() + "-" + safeName);
                String token = authStore.apiToken();
                if (!token.isEmpty()) request.addRequestHeader("Authorization", "Bearer " + token);
                if (mimeType != null && mimeType.startsWith("image/")) request.setMimeType(mimeType);
                DownloadManager manager =
                    (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
                long downloadId = manager.enqueue(request);
                artifactDownloads.put(downloadId, safeName);
                Toast.makeText(activity, "已开始下载 " + safeName, Toast.LENGTH_SHORT).show();
            } catch (Exception error) {
                Toast.makeText(activity, "无法下载图片", Toast.LENGTH_LONG).show();
            }
        });
    }

    String consumeCompletedDownload(long downloadId) {
        return artifactDownloads.remove(downloadId);
    }

    private static String sanitizeFilename(String name, String fallback) {
        String safeName = name == null ? fallback : name
            .replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_")
            .replaceAll("^\\.+", "");
        return safeName.trim().isEmpty() ? fallback : safeName;
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
