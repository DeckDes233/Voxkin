package dev.voxkin.audio;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;

public final class VoxkinAudioClient implements ClientModInitializer {
    private static AudioSocketClient client;

    @Override
    public void onInitializeClient() {
        String url = System.getProperty("voxkin.audio.url", "ws://127.0.0.1:8765/ws/audio");
        client = new AudioSocketClient(url);
        client.start();
        ClientTickEvents.END_CLIENT_TICK.register(AudioRuntime::tick);
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            if (client != null) {
                client.stop();
            }
            AudioRuntime.shutdown();
        }, "voxkin-audio-shutdown"));
    }
}
