package dev.voxkin.audio;

import net.minecraft.client.sound.AudioStream;

import javax.sound.sampled.AudioFormat;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.concurrent.ConcurrentLinkedQueue;

public final class PcmStream implements AudioStream {
    private static final AudioFormat FORMAT = new AudioFormat(32000.0f, 16, 1, true, false);

    private final ConcurrentLinkedQueue<byte[]> chunks = new ConcurrentLinkedQueue<>();
    private ByteBuffer current;
    private int queuedBytes;

    public void offer(byte[] data) {
        if (data.length == 0) {
            return;
        }
        chunks.add(data);
        queuedBytes += data.length;
    }

    public boolean hasData() {
        return queuedBytes > 0;
    }

    public void clear() {
        chunks.clear();
        current = null;
        queuedBytes = 0;
    }

    @Override
    public AudioFormat getFormat() {
        return FORMAT;
    }

    @Override
    public ByteBuffer read(int size) throws IOException {
        if (size <= 0) {
            return ByteBuffer.allocate(0);
        }
        ByteBuffer output = ByteBuffer.allocate(size);
        while (output.hasRemaining()) {
            if (current == null || !current.hasRemaining()) {
                byte[] next = chunks.poll();
                if (next == null) {
                    break;
                }
                current = ByteBuffer.wrap(next);
            }
            int copy = Math.min(output.remaining(), current.remaining());
            output.put(current.array(), current.position(), copy);
            current.position(current.position() + copy);
            queuedBytes -= copy;
        }
        if (output.position() == 0) {
            return ByteBuffer.allocate(size);
        }
        output.flip();
        return output;
    }

    @Override
    public void close() {
        clear();
    }
}
