package dev.voxkin.audio;

import net.fabricmc.api.ClientModInitializer;

public final class VoxkinAudioClient implements ClientModInitializer {
    private static AudioSocketClient client;

    @Override
    public void onInitializeClient() {
        String url = System.getProperty("voxkin.audio.url", "ws://127.0.0.1:8765/ws/audio");
        client = new AudioSocketClient(url);
        client.start();
        Runtime.getRuntime().addShutdownHook(new Thread(() -> {
            if (client != null) {
                client.stop();
            }
        }, "voxkin-audio-shutdown"));
    }
}
