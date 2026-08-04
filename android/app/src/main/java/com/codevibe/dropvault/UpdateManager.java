package com.codevibe.dropvault;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class UpdateManager {
    private static final String PREFS = "app_updates";
    private static final String CHANNEL_ID = "app_updates";
    private static final int JOB_ID = 8142;
    private static final ExecutorService EXECUTOR = Executors.newSingleThreadExecutor();
    private static volatile boolean dialogShowing;

    private UpdateManager() {}

    public static void check(Activity activity, boolean userInitiated) {
        EXECUTOR.execute(() -> {
            try {
                Release release = fetchRelease();
                int current = currentVersionCode(activity);
                activity.runOnUiThread(() -> {
                    if (release.versionCode > current && userInitiated) {
                        showDialog(activity, release);
                    } else if (release.versionCode > current) {
                        notifyOnce(activity, release);
                    }
                    else if (userInitiated) Toast.makeText(activity, "已经是最新版本", Toast.LENGTH_SHORT).show();
                });
            } catch (Exception error) {
                if (userInitiated) activity.runOnUiThread(() ->
                    Toast.makeText(activity, "检查更新失败，请稍后重试", Toast.LENGTH_SHORT).show());
            }
        });
    }

    public static void checkAndNotify(Context context, Runnable done) {
        EXECUTOR.execute(() -> {
            try {
                Release release = fetchRelease();
                int current = currentVersionCode(context);
                if (release.versionCode > current) notifyOnce(context, release);
            } catch (Exception ignored) {
            } finally {
                done.run();
            }
        });
    }

    public static void checkAndPrompt(Activity activity) {
        EXECUTOR.execute(() -> {
            try {
                Release release = fetchRelease();
                int current = currentVersionCode(activity);
                if (release.versionCode <= current) return;
                SharedPreferences prefs =
                    activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                if (prefs.getInt("last_auto_prompted", 0) >= release.versionCode) return;
                activity.runOnUiThread(() -> {
                    if (activity.isFinishing() || activity.isDestroyed()) return;
                    prefs.edit().putInt("last_auto_prompted", release.versionCode).apply();
                    showDialog(activity, release);
                });
            } catch (Exception ignored) {
            }
        });
    }

    public static void schedule(Context context) {
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        if (scheduler == null) return;
        scheduler.schedule(new JobInfo.Builder(JOB_ID, new ComponentName(context, UpdateJobService.class))
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(15L * 60L * 1000L)
            .setPersisted(true)
            .build());
    }

    private static void showDialog(Activity activity, Release release) {
        if (dialogShowing) return;
        dialogShowing = true;
        LinearLayout card = new LinearLayout(activity);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(activity, 24), dp(activity, 24), dp(activity, 24), dp(activity, 20));
        card.setBackground(rounded(Color.WHITE, dp(activity, 26)));

        TextView badge = new TextView(activity);
        badge.setText("NEW VERSION");
        badge.setTextColor(Color.rgb(83, 104, 204));
        badge.setTextSize(11);
        badge.setTypeface(Typeface.DEFAULT_BOLD);
        badge.setGravity(Gravity.CENTER);
        badge.setLetterSpacing(0.12f);
        badge.setBackground(rounded(Color.rgb(237, 241, 255), dp(activity, 99)));
        card.addView(badge, new LinearLayout.LayoutParams(dp(activity, 116), dp(activity, 30)));

        TextView title = new TextView(activity);
        title.setText("Witt " + release.versionName);
        title.setTextColor(Color.rgb(24, 34, 52));
        title.setTextSize(25);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams titleParams =
            new LinearLayout.LayoutParams(-1, -2);
        titleParams.topMargin = dp(activity, 18);
        card.addView(title, titleParams);

        TextView subtitle = new TextView(activity);
        subtitle.setText("新版本已经准备好");
        subtitle.setTextColor(Color.rgb(112, 124, 145));
        subtitle.setTextSize(14);
        LinearLayout.LayoutParams subtitleParams =
            new LinearLayout.LayoutParams(-1, -2);
        subtitleParams.topMargin = dp(activity, 5);
        card.addView(subtitle, subtitleParams);

        TextView notes = new TextView(activity);
        notes.setText(release.notes);
        notes.setTextColor(Color.rgb(70, 82, 104));
        notes.setTextSize(14);
        notes.setLineSpacing(dp(activity, 3), 1f);
        notes.setPadding(dp(activity, 15), dp(activity, 14), dp(activity, 15), dp(activity, 14));
        notes.setBackground(rounded(Color.rgb(246, 248, 253), dp(activity, 16)));
        LinearLayout.LayoutParams notesParams =
            new LinearLayout.LayoutParams(-1, -2);
        notesParams.topMargin = dp(activity, 18);
        card.addView(notes, notesParams);

        LinearLayout actions = new LinearLayout(activity);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        actions.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams actionsParams =
            new LinearLayout.LayoutParams(-1, dp(activity, 48));
        actionsParams.topMargin = dp(activity, 20);
        card.addView(actions, actionsParams);

        Button later = actionButton(activity, "稍后", false);
        Button update = actionButton(activity, "立即更新", true);
        LinearLayout.LayoutParams buttonParams =
            new LinearLayout.LayoutParams(0, -1, 1f);
        actions.addView(later, buttonParams);
        LinearLayout.LayoutParams updateParams =
            new LinearLayout.LayoutParams(0, -1, 1.35f);
        updateParams.leftMargin = dp(activity, 10);
        actions.addView(update, updateParams);

        AlertDialog dialog = new AlertDialog.Builder(activity).setView(card).create();
        dialog.setOnDismissListener(ignored -> dialogShowing = false);
        later.setOnClickListener(view -> dialog.dismiss());
        update.setOnClickListener(view -> {
            dialog.dismiss();
            enqueueDownload(activity, release);
        });
        dialog.setOnShowListener(ignored -> {
            Window window = dialog.getWindow();
            if (window == null) return;
            window.setBackgroundDrawableResource(android.R.color.transparent);
            window.setDimAmount(0.5f);
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
            window.setLayout(
                Math.min(activity.getResources().getDisplayMetrics().widthPixels - dp(activity, 34),
                    dp(activity, 420)),
                WindowManager.LayoutParams.WRAP_CONTENT);
        });
        dialog.show();
    }

    private static Button actionButton(Context context, String text, boolean primary) {
        Button button = new Button(context);
        button.setText(text);
        button.setTextSize(14);
        button.setAllCaps(false);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setTextColor(primary ? Color.WHITE : Color.rgb(78, 91, 114));
        button.setGravity(Gravity.CENTER);
        button.setPadding(0, 0, 0, 0);
        button.setBackground(rounded(
            primary ? Color.rgb(87, 91, 230) : Color.rgb(238, 241, 247),
            dp(context, 15)));
        return button;
    }

    private static GradientDrawable rounded(int color, int radiusPx) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(radiusPx);
        return drawable;
    }

    private static int dp(Context context, int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }

    private static void enqueueDownload(Activity activity, Release release) {
        try {
            File directory = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (directory == null) throw new IllegalStateException("No downloads directory");
            String fileName = "drop-vault-" + release.versionName + ".apk";
            File target = new File(directory, fileName);
            if (target.exists() && !target.delete()) throw new IllegalStateException("Cannot remove old download");
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(release.apkUrl))
                .setTitle("Witt " + release.versionName)
                .setDescription("正在下载应用更新")
                .setMimeType("application/vnd.android.package-archive")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(false)
                .setDestinationInExternalFilesDir(activity, Environment.DIRECTORY_DOWNLOADS, fileName);
            long id = ((DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(request);
            activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putLong("download_id", id)
                .putString("download_file", target.getAbsolutePath())
                .putString("download_sha256", release.sha256)
                .apply();
            Toast.makeText(activity, "更新正在后台下载", Toast.LENGTH_LONG).show();
        } catch (Exception error) {
            Toast.makeText(activity, "无法开始下载，请稍后重试", Toast.LENGTH_SHORT).show();
        }
    }

    public static void handleDownloaded(Activity activity, long id) {
        SharedPreferences prefs = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (id < 0 || id != prefs.getLong("download_id", -2L)) return;
        String filePath = prefs.getString("download_file", "");
        String expected = prefs.getString("download_sha256", "");
        EXECUTOR.execute(() -> {
            try {
                File file = new File(filePath);
                if (!file.isFile() || !sha256(file).equalsIgnoreCase(expected)) {
                    throw new IllegalStateException("APK verification failed");
                }
                prefs.edit().putString("pending_file", file.getAbsolutePath()).apply();
                activity.runOnUiThread(() -> install(activity, file));
            } catch (Exception error) {
                activity.runOnUiThread(() ->
                    Toast.makeText(activity, "更新包校验失败，请重新下载", Toast.LENGTH_LONG).show());
            }
        });
    }

    public static void tryInstallPending(Activity activity) {
        String path = activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("pending_file", "");
        if (path.isEmpty()) return;
        File file = new File(path);
        if (file.isFile() && activity.getPackageManager().canRequestPackageInstalls()) install(activity, file);
    }

    private static void install(Activity activity, File file) {
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:" + activity.getPackageName())));
            Toast.makeText(activity, "请允许 Witt 安装应用更新", Toast.LENGTH_LONG).show();
            return;
        }
        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".fileprovider", file);
        activity.startActivity(new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK));
        activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove("pending_file").apply();
    }

    private static void showNotification(Context context, Release release) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "Witt 更新推送", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Witt 新版本提醒");
        manager.createNotificationChannel(channel);
        Intent open = new Intent(context, MainActivity.class)
            .putExtra("open_update", true)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pending = PendingIntent.getActivity(context, 18, open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        manager.notify(81, new Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(Color.rgb(86, 111, 232))
            .setContentTitle("Witt 有新版本")
            .setContentText("版本 " + release.versionName + " 已可更新")
            .setStyle(new Notification.BigTextStyle()
                .bigText("Witt " + release.versionName + " 已可更新\n" + release.notes))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build());
    }

    private static void notifyOnce(Context context, Release release) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (prefs.getInt("last_notified", 0) >= release.versionCode) return;
        showNotification(context, release);
        prefs.edit().putInt("last_notified", release.versionCode).apply();
    }

    private static Release fetchRelease() throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(BuildConfig.UPDATE_URL).openConnection();
        connection.setConnectTimeout(8_000);
        connection.setReadTimeout(8_000);
        connection.setUseCaches(false);
        try {
            if (connection.getResponseCode() != 200) throw new IllegalStateException("Bad update response");
            try (BufferedInputStream input = new BufferedInputStream(connection.getInputStream());
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                int read;
                while ((read = input.read(buffer)) >= 0) output.write(buffer, 0, read);
                JSONObject json = new JSONObject(output.toString("UTF-8"));
                return new Release(
                    json.getInt("versionCode"),
                    json.getString("versionName"),
                    json.getString("apkUrl"),
                    json.getString("sha256").toLowerCase(Locale.ROOT),
                    json.optString("notes", "包含体验改进和问题修复")
                );
            }
        } finally {
            connection.disconnect();
        }
    }

    private static int currentVersionCode(Context context) throws Exception {
        PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return (int) info.getLongVersionCode();
        return info.versionCode;
    }

    private static String sha256(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (FileInputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) >= 0) digest.update(buffer, 0, read);
        }
        StringBuilder result = new StringBuilder();
        for (byte value : digest.digest()) result.append(String.format(Locale.ROOT, "%02x", value));
        return result.toString();
    }

    private static final class Release {
        final int versionCode;
        final String versionName;
        final String apkUrl;
        final String sha256;
        final String notes;
        Release(int versionCode, String versionName, String apkUrl, String sha256, String notes) {
            this.versionCode = versionCode;
            this.versionName = versionName;
            this.apkUrl = apkUrl;
            this.sha256 = sha256;
            this.notes = notes;
        }
    }
}
