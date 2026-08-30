package com.codevibe.dropvault;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.Base64;
import android.util.Patterns;

import com.jcraft.jsch.ChannelShell;
import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.HostKey;
import com.jcraft.jsch.HostKeyRepository;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.Session;
import com.jcraft.jsch.UserInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Properties;
import java.util.Vector;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

final class LocalSshManager {
    interface Callback {
        void onStatus(String json);
        void onProfiles(String json);
        void onProfileError(String message);
        void onConnected(String json);
        void onOutput(String text);
        void onError(String message);
        void onDisconnected();
        void onSftpList(String json);
        void onSftpError(String message);
        void onSftpComplete(String operation, String path);
    }

    private static final String KEX_ALGORITHMS =
        "ecdh-sha2-nistp256,diffie-hellman-group16-sha512,"
            + "diffie-hellman-group14-sha256,diffie-hellman-group14-sha1";
    private static final String HOST_KEY_ALGORITHMS =
        "ecdsa-sha2-nistp256,rsa-sha2-512,rsa-sha2-256,ssh-rsa";
    private static final String CIPHERS =
        "aes128-gcm@openssh.com,aes256-gcm@openssh.com,aes128-ctr,aes192-ctr,aes256-ctr";
    private static final long[] RECONNECT_DELAYS_SECONDS = { 1L, 2L, 5L, 10L, 20L, 30L };

    private final SharedPreferences hostKeys;
    private final Context context;
    private final LocalSshProfileStore profileStore;
    private final Callback callback;
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private final ExecutorService terminalIo = Executors.newSingleThreadExecutor();
    private final ExecutorService sftpIo = Executors.newSingleThreadExecutor();
    private final ScheduledExecutorService reconnectIo = Executors.newSingleThreadScheduledExecutor();
    private final AtomicInteger generation = new AtomicInteger();
    private final Object lock = new Object();
    private Session client;
    private ChannelShell shell;
    private OutputStream terminalInput;
    private String host = "";
    private String username = "";
    private int port = 22;
    private long connectedAt;
    private boolean connecting;
    private String activeProfileId = "";
    private String reconnectProfileId = "";
    private int reconnectAttempt;
    private boolean reconnectAllowed;
    private boolean shuttingDown;
    private ScheduledFuture<?> reconnectFuture;

    LocalSshManager(Context context, Callback callback) {
        this.context = context.getApplicationContext();
        this.callback = callback;
        // JSch exposes the SSH wire key, while the previous client exposed a Java key object.
        // Use a new store so existing pins are safely re-established instead of mismatching.
        hostKeys = context.getSharedPreferences("witt-local-ssh-host-keys-v2", Context.MODE_PRIVATE);
        profileStore = new LocalSshProfileStore(context);
    }

    void requestStatus() {
        callback.onStatus(statusJson());
    }

    void requestProfiles() {
        callback.onProfiles(profileStore.publicProfilesJson());
    }

    void connect(String requestedHost, String requestedUsername, int requestedPort,
                 String password) {
        connectInternal(requestedHost, requestedUsername, requestedPort, password, "", null,
            false);
    }

    void connectAndRemember(String label, String requestedHost, String requestedUsername,
                            int requestedPort, String password) {
        connectInternal(requestedHost, requestedUsername, requestedPort, password, "",
            label == null ? "" : label, false);
    }

    void connectSaved(String profileId) {
        connectSaved(profileId, false);
    }

    private void connectSaved(String profileId, boolean automaticReconnect) {
        try {
            LocalSshProfileStore.Profile profile = profileStore.get(profileId);
            if (profile == null) {
                if (automaticReconnect) disableReconnect();
                callback.onProfileError("找不到这个服务器配置");
                requestProfiles();
                return;
            }
            connectInternal(profile.host, profile.username, profile.port, profile.password,
                profile.id, null, automaticReconnect);
        } catch (Exception ignored) {
            if (automaticReconnect) disableReconnect();
            callback.onProfileError("保存的密码无法解密，请删除后重新添加");
        }
    }

    void deleteSaved(String profileId) {
        if (profileStore.delete(profileId)) {
            synchronized (lock) {
                if (profileId.equals(activeProfileId)) activeProfileId = "";
                if (profileId.equals(reconnectProfileId)) disableReconnectLocked();
            }
        }
        requestProfiles();
    }

    private void connectInternal(String requestedHost, String requestedUsername, int requestedPort,
                                 String password, String profileId, String rememberLabel,
                                 boolean automaticReconnect) {
        final String nextHost = requestedHost == null ? "" : requestedHost.trim();
        final String nextUsername = requestedUsername == null || requestedUsername.trim().isEmpty()
            ? "root" : requestedUsername.trim();
        boolean validHost = Patterns.IP_ADDRESS.matcher(nextHost).matches()
            || (nextHost.length() <= 253
                && nextHost.matches("(?i)^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"));
        if (!validHost) {
            callback.onError("请输入正确的服务器地址");
            return;
        }
        if (!nextUsername.matches("[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}")) {
            callback.onError("用户名格式不正确");
            return;
        }
        if (requestedPort < 1 || requestedPort > 65535) {
            callback.onError("端口格式不正确");
            return;
        }
        if (password == null || password.isEmpty()) {
            callback.onError("请输入登录密码");
            return;
        }

        if (!automaticReconnect) disableReconnect();
        int nextGeneration = generation.incrementAndGet();
        closeCurrent(false);
        synchronized (lock) {
            connecting = true;
            host = nextHost;
            username = nextUsername;
            port = requestedPort;
            activeProfileId = profileId == null ? "" : profileId;
        }
        executor.execute(() -> openConnection(
            nextGeneration, nextHost, nextUsername, requestedPort, password,
            profileId == null ? "" : profileId, rememberLabel, automaticReconnect));
    }

    private void openConnection(int activeGeneration, String nextHost, String nextUsername,
                                int nextPort, String password, String profileId,
                                String rememberLabel, boolean automaticReconnect) {
        Session nextClient = null;
        ChannelShell nextShell = null;
        byte[] passwordBytes = password.getBytes(StandardCharsets.UTF_8);
        try {
            JSch jsch = new JSch();
            jsch.setHostKeyRepository(new PinnedHostKeyRepository(nextHost, nextPort));
            nextClient = jsch.getSession(nextUsername, nextHost, nextPort);
            nextClient.setPassword(passwordBytes);
            nextClient.setConfig(connectionConfig());
            nextClient.setTimeout(0);
            nextClient.setServerAliveInterval(30_000);
            nextClient.setServerAliveCountMax(3);
            nextClient.connect(15_000);
            nextClient.setPassword(new byte[0]);

            nextShell = (ChannelShell) nextClient.openChannel("shell");
            nextShell.setPty(true);
            nextShell.setPtyType("xterm-256color");
            nextShell.setPtySize(120, 36, 0, 0);
            InputStream terminalOutput = nextShell.getInputStream();
            OutputStream nextInput = nextShell.getOutputStream();
            nextShell.connect(10_000);

            if (activeGeneration != generation.get()) {
                closeResources(nextShell, nextClient);
                return;
            }
            String resolvedProfileId = profileId;
            if (rememberLabel != null) {
                try {
                    LocalSshProfileStore.Profile saved = profileStore.save(
                        rememberLabel, nextHost, nextUsername, nextPort, password);
                    resolvedProfileId = saved.id;
                    callback.onProfiles(profileStore.publicProfilesJson());
                } catch (Exception ignored) {
                    callback.onProfileError("服务器已连接，但密码未能安全保存");
                }
            }
            synchronized (lock) {
                client = nextClient;
                shell = nextShell;
                terminalInput = nextInput;
                connectedAt = System.currentTimeMillis();
                connecting = false;
                activeProfileId = resolvedProfileId;
                reconnectProfileId = resolvedProfileId;
                reconnectAllowed = !resolvedProfileId.isEmpty();
                reconnectAttempt = 0;
                reconnectFuture = null;
            }
            callback.onConnected(statusJson(automaticReconnect));
            executor.execute(() -> readTerminal(activeGeneration, terminalOutput));
        } catch (Exception error) {
            closeResources(nextShell, nextClient);
            if (activeGeneration != generation.get()) return;
            synchronized (lock) { connecting = false; }
            if (automaticReconnect) {
                callback.onOutput("\r\n\u001b[33m[Witt] 自动重连失败，将继续尝试。\u001b[0m\r\n");
                if (generation.compareAndSet(activeGeneration, activeGeneration + 1)) {
                    closeCurrent(false);
                    scheduleReconnect();
                }
            } else {
                callback.onError(connectionMessage(error));
                callback.onDisconnected();
            }
        } finally {
            Arrays.fill(passwordBytes, (byte) 0);
        }
    }

    private Properties connectionConfig() {
        Properties config = new Properties();
        config.put("StrictHostKeyChecking", "yes");
        config.put("PreferredAuthentications", "password,keyboard-interactive");
        config.put("kex", KEX_ALGORITHMS);
        config.put("server_host_key", HOST_KEY_ALGORITHMS);
        config.put("cipher.c2s", CIPHERS);
        config.put("cipher.s2c", CIPHERS);
        config.put("max_input_buffer_size", "1048576");
        return config;
    }

    private boolean verifyHostKey(String hostname, int hostPort, byte[] key) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(key);
            String fingerprint = Base64.encodeToString(digest, Base64.NO_WRAP);
            String preferenceKey = hostname + ":" + hostPort;
            String known = hostKeys.getString(preferenceKey, "");
            if (known == null || known.isEmpty()) {
                hostKeys.edit().putString(preferenceKey, fingerprint).apply();
                return true;
            }
            return MessageDigest.isEqual(
                known.getBytes(StandardCharsets.UTF_8),
                fingerprint.getBytes(StandardCharsets.UTF_8));
        } catch (Exception ignored) {
            return false;
        }
    }

    private final class PinnedHostKeyRepository implements HostKeyRepository {
        private final String hostname;
        private final int hostPort;

        PinnedHostKeyRepository(String hostname, int hostPort) {
            this.hostname = hostname;
            this.hostPort = hostPort;
        }

        @Override public int check(String ignoredHost, byte[] key) {
            return verifyHostKey(hostname, hostPort, key) ? OK : CHANGED;
        }

        @Override public void add(HostKey hostkey, UserInfo userinfo) {}
        @Override public void remove(String host, String type) {}
        @Override public void remove(String host, String type, byte[] key) {}
        @Override public String getKnownHostsRepositoryID() { return "Witt pinned host keys"; }
        @Override public HostKey[] getHostKey() { return new HostKey[0]; }
        @Override public HostKey[] getHostKey(String host, String type) { return new HostKey[0]; }
    }

    private void readTerminal(int activeGeneration, InputStream stream) {
        try (InputStreamReader reader = new InputStreamReader(stream, StandardCharsets.UTF_8)) {
            char[] buffer = new char[4096];
            int count;
            while (activeGeneration == generation.get() && (count = reader.read(buffer)) >= 0) {
                if (count > 0) callback.onOutput(new String(buffer, 0, count));
            }
        } catch (Exception ignored) {
        } finally {
            handleUnexpectedDisconnect(activeGeneration);
        }
    }

    void send(String input) {
        if (input == null || input.isEmpty() || input.length() > 32 * 1024) return;
        final int activeGeneration = generation.get();
        terminalIo.execute(() -> {
            if (activeGeneration != generation.get()) return;
            OutputStream output;
            synchronized (lock) { output = terminalInput; }
            if (output == null) {
                callback.onError("服务器连接已断开");
                return;
            }
            try {
                output.write(input.getBytes(StandardCharsets.UTF_8));
                output.flush();
            } catch (Exception error) {
                callback.onError("终端输入发送失败");
                handleUnexpectedDisconnect(activeGeneration);
            }
        });
    }

    void resize(int columns, int rows) {
        if (columns < 10 || columns > 500 || rows < 5 || rows > 300) return;
        final int activeGeneration = generation.get();
        terminalIo.execute(() -> {
            if (activeGeneration != generation.get()) return;
            ChannelShell currentShell;
            synchronized (lock) { currentShell = shell; }
            if (currentShell == null) return;
            try {
                currentShell.setPtySize(columns, rows, 0, 0);
            } catch (Exception ignored) {}
        });
    }

    void listSftp(String requestedPath) {
        sftpIo.execute(() -> {
            ChannelSftp channel = null;
            try {
                channel = openSftp();
                String path = channel.realpath(requestedPath == null || requestedPath.isEmpty()
                    ? "." : requestedPath);
                @SuppressWarnings("unchecked")
                Vector<ChannelSftp.LsEntry> listed = channel.ls(path);
                List<ChannelSftp.LsEntry> entries = new java.util.ArrayList<>(listed);
                entries.removeIf(entry -> ".".equals(entry.getFilename())
                    || "..".equals(entry.getFilename()));
                entries.sort(Comparator
                    .comparing((ChannelSftp.LsEntry entry) -> !entry.getAttrs().isDir())
                    .thenComparing(entry -> entry.getFilename().toLowerCase()));
                JSONArray files = new JSONArray();
                for (ChannelSftp.LsEntry entry : entries) {
                    files.put(new JSONObject()
                        .put("name", entry.getFilename())
                        .put("directory", entry.getAttrs().isDir())
                        .put("link", entry.getAttrs().isLink())
                        .put("size", entry.getAttrs().getSize())
                        .put("modifiedAt", entry.getAttrs().getMTime() * 1000L));
                }
                callback.onSftpList(new JSONObject().put("path", path)
                    .put("entries", files).toString());
            } catch (Exception ignored) {
                callback.onSftpError("无法读取远程目录");
            } finally {
                closeSftp(channel);
            }
        });
    }

    void downloadSftp(String remotePath, Uri destination) {
        if (destination == null || remotePath == null || remotePath.isEmpty()) return;
        sftpIo.execute(() -> {
            ChannelSftp channel = null;
            try (OutputStream output = context.getContentResolver()
                    .openOutputStream(destination, "w")) {
                if (output == null) throw new IllegalStateException("missing output");
                channel = openSftp();
                channel.get(remotePath, output);
                output.flush();
                callback.onSftpComplete("download", remotePath);
            } catch (Exception ignored) {
                callback.onSftpError("文件下载失败");
            } finally {
                closeSftp(channel);
            }
        });
    }

    void uploadSftp(Uri source, String remoteDirectory, String requestedName) {
        if (source == null) return;
        final String name = requestedName == null ? "file" : requestedName.replace('/', '_');
        sftpIo.execute(() -> {
            ChannelSftp channel = null;
            String remotePath = joinRemotePath(remoteDirectory, name);
            try (InputStream input = context.getContentResolver().openInputStream(source)) {
                if (input == null) throw new IllegalStateException("missing input");
                channel = openSftp();
                channel.put(input, remotePath);
                callback.onSftpComplete("upload", remotePath);
                listSftp(remoteDirectory);
            } catch (Exception ignored) {
                callback.onSftpError("文件上传失败");
            } finally {
                closeSftp(channel);
            }
        });
    }

    private ChannelSftp openSftp() throws Exception {
        Session currentClient;
        synchronized (lock) { currentClient = client; }
        if (currentClient == null || !currentClient.isConnected()) {
            throw new IllegalStateException("SSH disconnected");
        }
        ChannelSftp channel = (ChannelSftp) currentClient.openChannel("sftp");
        channel.connect(10_000);
        return channel;
    }

    private void closeSftp(ChannelSftp channel) {
        try { if (channel != null) channel.disconnect(); } catch (Exception ignored) {}
    }

    private String joinRemotePath(String directory, String name) {
        String base = directory == null || directory.isEmpty() ? "." : directory;
        return (base.endsWith("/") ? base : base + "/") + name;
    }

    private void handleUnexpectedDisconnect(int activeGeneration) {
        if (!generation.compareAndSet(activeGeneration, activeGeneration + 1)) return;
        closeCurrent(false);
        callback.onDisconnected();
        scheduleReconnect();
    }

    private void scheduleReconnect() {
        final String profileId;
        final int attempt;
        final long delaySeconds;
        synchronized (lock) {
            if (shuttingDown || !reconnectAllowed || reconnectProfileId.isEmpty()) return;
            if (reconnectFuture != null && !reconnectFuture.isDone()) return;
            profileId = reconnectProfileId;
            attempt = ++reconnectAttempt;
            delaySeconds = RECONNECT_DELAYS_SECONDS[Math.min(
                attempt - 1, RECONNECT_DELAYS_SECONDS.length - 1)];
            activeProfileId = profileId;
            reconnectFuture = reconnectIo.schedule(() -> {
                synchronized (lock) {
                    reconnectFuture = null;
                    if (shuttingDown || !reconnectAllowed
                            || !profileId.equals(reconnectProfileId)) return;
                }
                callback.onOutput("\r\n\u001b[36m[Witt] 正在自动重连…\u001b[0m\r\n");
                connectSaved(profileId, true);
            }, delaySeconds, TimeUnit.SECONDS);
        }
        callback.onOutput("\r\n\u001b[33m[Witt] 连接已中断，" + delaySeconds
            + " 秒后自动重连（第 " + attempt + " 次）。\u001b[0m\r\n");
        callback.onStatus(statusJson());
    }

    private void disableReconnect() {
        synchronized (lock) { disableReconnectLocked(); }
    }

    private void disableReconnectLocked() {
        reconnectAllowed = false;
        reconnectProfileId = "";
        reconnectAttempt = 0;
        if (reconnectFuture != null) {
            reconnectFuture.cancel(false);
            reconnectFuture = null;
        }
    }

    void disconnect() {
        disableReconnect();
        generation.incrementAndGet();
        closeCurrent(true);
    }

    void shutdown() {
        synchronized (lock) {
            shuttingDown = true;
            disableReconnectLocked();
        }
        generation.incrementAndGet();
        closeCurrent(false);
        reconnectIo.shutdownNow();
        terminalIo.shutdownNow();
        sftpIo.shutdownNow();
        executor.shutdownNow();
    }

    private void closeCurrent(boolean notify) {
        ChannelShell currentShell;
        Session currentClient;
        boolean wasActive;
        synchronized (lock) {
            currentShell = shell;
            currentClient = client;
            wasActive = currentShell != null || currentClient != null || connecting;
            shell = null;
            client = null;
            terminalInput = null;
            connecting = false;
            connectedAt = 0L;
            activeProfileId = "";
        }
        closeResources(currentShell, currentClient);
        if (notify && wasActive) callback.onDisconnected();
    }

    private void closeResources(ChannelShell currentShell, Session currentClient) {
        try { if (currentShell != null) currentShell.disconnect(); } catch (Exception ignored) {}
        try { if (currentClient != null) currentClient.disconnect(); } catch (Exception ignored) {}
    }

    private String statusJson() {
        return statusJson(false);
    }

    private String statusJson(boolean reconnected) {
        synchronized (lock) {
            try {
                return new JSONObject()
                    .put("connected", client != null && client.isConnected())
                    .put("connecting", connecting)
                    .put("host", host)
                    .put("username", username)
                    .put("port", port)
                    .put("profileId", activeProfileId)
                    .put("connectedAt", connectedAt)
                    .put("reconnecting", reconnectFuture != null || reconnectAttempt > 0)
                    .put("reconnected", reconnected)
                    .toString();
            } catch (Exception ignored) {
                return "{\"connected\":false}";
            }
        }
    }

    private String connectionMessage(Exception error) {
        String detail = String.valueOf(error.getMessage());
        if (detail.matches("(?is).*(auth fail|authentication|permission denied).*")) {
            return "用户名或密码不正确";
        }
        if (detail.matches("(?is).*refused.*")) return "目标服务器拒绝连接";
        if (detail.matches("(?is).*timeout|.*timed out.*")) return "连接超时，请检查 IP 和端口";
        if (detail.matches("(?is).*unknownhost|.*unresolved.*")) return "无法解析服务器地址";
        if (detail.matches("(?is).*algorithm negotiation.*")) return "服务器 SSH 算法不兼容";
        if (detail.matches("(?is).*hostkey|.*host key|.*fingerprint.*")) {
            return "服务器身份指纹已变化，已拒绝连接";
        }
        return "无法连接服务器，请检查 IP、端口和账号";
    }
}
