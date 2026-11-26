package com.codevibe.dropvault;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Manages the foreground Server-Sent Events (SSE) subscription for the active conversation,
 * handling exponential backoff reconnects and Activity pause/resume transitions.
 */
final class ConversationEventStream {
    interface ConnectionOpener {
        HttpURLConnection open(String endpoint, String method) throws Exception;
    }

    interface TokenCheck {
        boolean hasToken();
    }

    interface Listener {
        void onSnapshot(String data);
        void onDelta(String data);
    }

    private final ExecutorService executor;
    private final ConnectionOpener connectionOpener;
    private final TokenCheck tokenCheck;
    private final Listener listener;
    private final AtomicInteger generation = new AtomicInteger();

    private volatile boolean foreground = true;
    private volatile String conversationId = "";
    private volatile HttpURLConnection activeConnection;

    ConversationEventStream(ExecutorService executor, ConnectionOpener connectionOpener,
                            TokenCheck tokenCheck, Listener listener) {
        this.executor = executor;
        this.connectionOpener = connectionOpener;
        this.tokenCheck = tokenCheck;
        this.listener = listener;
    }

    void subscribe(String id) {
        if (id == null || !id.matches("[a-f0-9-]{36}")) return;
        conversationId = id;
        restart();
    }

    void restart() {
        int currentGen = generation.incrementAndGet();
        disconnectActive();
        String targetId = conversationId;
        if (!foreground || targetId.isEmpty() || !tokenCheck.hasToken()) return;
        executor.execute(() -> runLoop(targetId, currentGen));
    }

    void unsubscribe() {
        conversationId = "";
        generation.incrementAndGet();
        disconnectActive();
    }

    void onResume() {
        foreground = true;
        if (!conversationId.isEmpty()) restart();
    }

    void onPause() {
        foreground = false;
        generation.incrementAndGet();
        disconnectActive();
    }

    private void disconnectActive() {
        HttpURLConnection current = activeConnection;
        activeConnection = null;
        if (current != null) current.disconnect();
    }

    private void runLoop(String targetId, int currentGen) {
        long retryDelayMs = 1_000L;
        while (foreground && currentGen == generation.get() && targetId.equals(conversationId)) {
            HttpURLConnection connection = null;
            try {
                connection = connectionOpener.open(
                    "chat/conversations/" + targetId + "/events", "GET");
                connection.setReadTimeout(0);
                connection.setRequestProperty("Accept", "text/event-stream");
                connection.setRequestProperty("Cache-Control", "no-cache");
                activeConnection = connection;
                int status = connection.getResponseCode();
                if (status != 200) {
                    if (status == 401 || status == 403 || status == 404) return;
                    throw new IllegalStateException("SSE status " + status);
                }
                retryDelayMs = 1_000L;
                readStream(connection.getInputStream(), targetId, currentGen);
            } catch (Exception ignored) {
                // A foreground reconnect immediately receives a fresh snapshot, so no event is lost.
            } finally {
                if (activeConnection == connection) activeConnection = null;
                if (connection != null) connection.disconnect();
            }
            if (!foreground || currentGen != generation.get() || !targetId.equals(conversationId)) {
                return;
            }
            try {
                Thread.sleep(retryDelayMs);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return;
            }
            retryDelayMs = Math.min(15_000L, retryDelayMs * 2L);
        }
    }

    private void readStream(InputStream stream, String targetId, int currentGen) throws Exception {
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(stream, StandardCharsets.UTF_8))) {
            String event = "message";
            StringBuilder data = new StringBuilder();
            String line;
            while (foreground && currentGen == generation.get() &&
                    targetId.equals(conversationId) &&
                    (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    if (data.length() > 0) dispatch(event, data.toString());
                    event = "message";
                    data.setLength(0);
                } else if (line.startsWith("event:")) {
                    event = line.substring(6).trim();
                } else if (line.startsWith("data:")) {
                    if (data.length() > 0) data.append('\n');
                    data.append(line.substring(5).trim());
                }
            }
        }
    }

    private void dispatch(String event, String data) {
        if ("snapshot".equals(event)) {
            listener.onSnapshot(data);
        } else if ("delta".equals(event)) {
            listener.onDelta(data);
        }
    }
}
