package dev.voxkin.audio;

import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioSystem;
import javax.sound.sampled.LineUnavailableException;
import javax.sound.sampled.SourceDataLine;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

public final class PcmPlayer implements AutoCloseable {
    private static final int SAMPLE_RATE = 32000;
    private static final int QUEUE_CAPACITY = 96;

    private final ArrayBlockingQueue<byte[]> queue = new ArrayBlockingQueue<>(QUEUE_CAPACITY);
    private final Thread worker;
    private volatile boolean running = true;
    private volatile float volume = 1.0f;
    private volatile SourceDataLine line;

    public PcmPlayer() {
        this.worker = new Thread(this::run, "voxkin-audio-player");
        this.worker.setDaemon(true);
        this.worker.start();
    }

    private void run() {
        AudioFormat format = new AudioFormat(SAMPLE_RATE, 16, 1, true, false);
        try (SourceDataLine opened = AudioSystem.getSourceDataLine(format)) {
            opened.open(format);
            opened.start();
            this.line = opened;
            while (running) {
                byte[] chunk = queue.poll(200, TimeUnit.MILLISECONDS);
                if (chunk == null) {
                    continue;
                }
                byte[] scaled = applyVolume(chunk);
                opened.write(scaled, 0, scaled.length);
            }
        } catch (LineUnavailableException error) {
            throw new IllegalStateException("无法打开音频输出设备", error);
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        } finally {
            this.line = null;
        }
    }

    private byte[] applyVolume(byte[] data) {
        float current = volume;
        if (current == 1.0f) {
            return data;
        }
        byte[] output = new byte[data.length];
        for (int index = 0; index + 1 < data.length; index += 2) {
            short sample = (short) ((data[index] & 0xff) | (data[index + 1] << 8));
            int scaled = Math.max(Short.MIN_VALUE, Math.min(Short.MAX_VALUE, (int) (sample * current)));
            output[index] = (byte) (scaled & 0xff);
            output[index + 1] = (byte) ((scaled >> 8) & 0xff);
        }
        return output;
    }

    public void setVolume(float volume) {
        this.volume = Math.max(0.0f, Math.min(1.0f, volume));
    }

    public void enqueue(byte[] data) {
        if (!queue.offer(data)) {
            queue.poll();
            queue.offer(data);
        }
    }

    public void flush() {
        queue.clear();
        SourceDataLine current = line;
        if (current != null) {
            current.flush();
        }
    }

    @Override
    public void close() {
        running = false;
        worker.interrupt();
        SourceDataLine current = line;
        if (current != null) {
            current.stop();
            current.close();
        }
    }
}
