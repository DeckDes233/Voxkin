package dev.voxkin.audio;

import dev.voxkin.audio.mixin.SoundManagerAccessor;
import dev.voxkin.audio.mixin.SoundSystemAccessor;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.AbstractClientPlayerEntity;
import net.minecraft.client.sound.SoundEngine;
import net.minecraft.client.sound.SoundSystem;
import net.minecraft.client.sound.Source;
import net.minecraft.sound.SoundCategory;
import net.minecraft.util.math.Vec3d;

import java.util.List;

public final class AudioRuntime {
    private static final PcmStream STREAM = new PcmStream();
    private static final String BOT_NAME = System.getProperty("voxkin.audio.bot", "Voxkin");

    private static SoundEngine engine;
    private static Source source;
    private static boolean flushRequested;
    private static Vec3d position = Vec3d.ZERO;

    private AudioRuntime() {
    }

    public static void enqueue(byte[] data) {
        STREAM.offer(data);
    }

    public static void requestFlush() {
        flushRequested = true;
    }

    public static void tick(MinecraftClient client) {
        if (client.world == null) {
            return;
        }
        if (flushRequested) {
            flushRequested = false;
            stopSource();
            STREAM.clear();
        }
        if (source == null) {
            if (!STREAM.hasData()) {
                return;
            }
            createSource(client);
            if (source == null) {
                return;
            }
        }
        updatePosition(client);
        source.setPosition(position);
        float volume = client.options.getSoundVolume(SoundCategory.VOICE);
        source.setVolume(Math.max(0.0f, volume));
        source.tick();
    }

    private static void createSource(MinecraftClient client) {
        try {
            SoundSystem system = ((SoundManagerAccessor) client.getSoundManager()).getSoundSystem();
            engine = ((SoundSystemAccessor) system).getSoundEngine();
            Source created = engine.createSource(SoundEngine.RunMode.STREAMING);
            created.setRelative(false);
            created.setAttenuation(1.0f);
            created.setVolume(1.0f);
            created.setPosition(position);
            created.setStream(STREAM);
            created.play();
            source = created;
        } catch (RuntimeException error) {
            System.out.println("[voxkin-audio] 无法创建空间声源: " + error.getMessage());
            source = null;
        }
    }

    private static void updatePosition(MinecraftClient client) {
        List<AbstractClientPlayerEntity> players = client.world.getPlayers();
        for (AbstractClientPlayerEntity player : players) {
            if (player.getName().getString().equals(BOT_NAME)) {
                position = player.getPos().add(0.0, 1.6, 0.0);
                return;
            }
        }
    }

    private static void stopSource() {
        if (source == null) {
            return;
        }
        try {
            source.stop();
            source.close();
            if (engine != null) {
                engine.release(source);
            }
        } catch (RuntimeException error) {
            System.out.println("[voxkin-audio] 释放声源失败: " + error.getMessage());
        } finally {
            source = null;
            engine = null;
        }
    }

    public static void shutdown() {
        flushRequested = false;
        STREAM.clear();
        stopSource();
    }
}
