package dev.voxkin.audio;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;

public final class AudioSocketClient {
    private final URI uri;
    private final HttpClient http = HttpClient.newHttpClient();
    private final StringBuilder textBuffer = new StringBuilder();
    private volatile boolean running = true;
    private volatile WebSocket socket;
    private volatile int pendingBytes;

    public AudioSocketClient(String url) {
        this.uri = URI.create(url);
    }

    public void start() {
        Thread thread = new Thread(this::loop, "voxkin-audio-socket");
        thread.setDaemon(true);
        thread.start();
    }

    private void loop() {
        while (running) {
            CountDownLatch closed = new CountDownLatch(1);
            try {
                WebSocket opened = http.newWebSocketBuilder()
                        .buildAsync(uri, new Listener(closed))
                        .join();
                socket = opened;
                System.out.println("[voxkin-audio] 已连接 " + uri);
                closed.await();
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                break;
            } catch (Exception error) {
                System.out.println("[voxkin-audio] 连接失败: " + error.getMessage());
            } finally {
                WebSocket current = socket;
                socket = null;
                pendingBytes = 0;
                textBuffer.setLength(0);
                if (current != null) {
                    current.abort();
                }
                AudioRuntime.requestFlush();
            }
            if (!running) {
                break;
            }
            try {
                Thread.sleep(3000);
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        AudioRuntime.shutdown();
    }

    public void stop() {
        running = false;
        WebSocket current = socket;
        if (current != null) {
            current.abort();
        }
        AudioRuntime.shutdown();
    }

    private void handleText(String text) {
        JsonObject payload;
        try {
            payload = JsonParser.parseString(text).getAsJsonObject();
        } catch (RuntimeException error) {
            System.out.println("[voxkin-audio] 无法解析控制消息: " + text);
            return;
        }
        String type = payload.has("type") ? payload.get("type").getAsString() : "";
        switch (type) {
            case "welcome" -> System.out.println("[voxkin-audio] 采样率 " + payload.get("sample_rate").getAsInt());
            case "pcm" -> pendingBytes = payload.get("bytes").getAsInt();
            case "flush" -> AudioRuntime.requestFlush();
            case "pong" -> {
            }
            default -> {
            }
        }
    }

    private final class Listener implements WebSocket.Listener {
        private final CountDownLatch closed;

        private Listener(CountDownLatch closed) {
            this.closed = closed;
        }

        @Override
        public void onOpen(WebSocket webSocket) {
            webSocket.request(1);
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            textBuffer.append(data);
            if (last) {
                String message = textBuffer.toString();
                textBuffer.setLength(0);
                handleText(message);
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onBinary(WebSocket webSocket, java.nio.ByteBuffer data, boolean last) {
            byte[] chunk = new byte[data.remaining()];
            data.get(chunk);
            if (pendingBytes > 0) {
                AudioRuntime.enqueue(chunk);
                pendingBytes = Math.max(0, pendingBytes - chunk.length);
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket webSocket, int statusCode, String reason) {
            closed.countDown();
            return null;
        }

        @Override
        public void onError(WebSocket webSocket, Throwable error) {
            System.out.println("[voxkin-audio] 连接错误: " + error.getMessage());
            closed.countDown();
        }
    }
}
