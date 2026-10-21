from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
from pathlib import Path

from voxkin.audio.capture import Microphone
from voxkin.audio.wav import arrays_to_wav_bytes
from voxkin.config import DEFAULT_CONFIG_PATH, load_config
from voxkin.logging_setup import setup_logging
from voxkin.server import StudioServer
from voxkin.stt.vad import VadSegmenter
from voxkin.stt.whisper import WhisperSTT
from voxkin.voice.loop import VoiceLoop


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="voxkin", description="沃心 Voxkin 实时语音伙伴")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("serve", help="启动 Voxkin Studio 控制终端")
    sub.add_parser("doctor", help="检查运行环境与引擎状态")

    say = sub.add_parser("say", help="用一句话驱动完整链路")
    say.add_argument("text")

    tts = sub.add_parser("tts", help="只合成语音并写入 WAV")
    tts.add_argument("text")
    tts.add_argument("--out", type=Path, default=Path("work/tts_preview.wav"))

    stt = sub.add_parser("stt", help="识别一个 16kHz WAV 文件")
    stt.add_argument("file", type=Path)

    mic = sub.add_parser("mic", help="麦克风实时对话")
    mic.add_argument("--seconds", type=float, default=30.0)

    bench = sub.add_parser("bench", help="连续多轮延迟基准")
    bench.add_argument("--turns", type=int, default=5)
    bench.add_argument("--text", default="你好，今天我们一起去做点什么？")
    bench.add_argument("--json", type=Path, default=None)
    return parser


async def run_serve(config) -> None:
    from aiohttp import web
    from voxkin.runtime import Runtime

    logger = setup_logging()
    runtime = await Runtime.create(config)
    await runtime.start()
    studio = StudioServer(runtime, config_path=DEFAULT_CONFIG_PATH)
    app = studio.build()
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, config.server.host, config.server.port)
    await site.start()
    logger.info("Voxkin Studio 已启动: http://%s:%s", config.server.host, config.server.port)
    try:
        await asyncio.Event().wait()
    finally:
        await runtime.close()
        await runner.cleanup()


async def run_say(config, text: str) -> None:
    from voxkin.runtime import Runtime

    runtime = await Runtime.create(config)
    await runtime.start()
    try:
        summary = await runtime.pipeline.respond(text)
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    finally:
        await runtime.close()


async def run_tts(config, text: str, out: Path) -> None:
    from voxkin.tts import build_tts

    tts = build_tts(config.tts)
    started = time.perf_counter()
    await tts.initialize()
    load_done = time.perf_counter()
    chunks = []
    first_audio: float | None = None
    async for pcm in tts.synthesize(text):
        if first_audio is None:
            first_audio = time.perf_counter()
        chunks.append(pcm)
    finished = time.perf_counter()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(arrays_to_wav_bytes(chunks, tts.sample_rate))
    print(
        json.dumps(
            {
                "load_ms": round((load_done - started) * 1000, 1),
                "first_audio_ms": round(((first_audio or finished) - load_done) * 1000, 1),
                "total_ms": round((finished - load_done) * 1000, 1),
                "out": str(out),
            },
            ensure_ascii=False,
        )
    )


def run_stt(config, path: Path) -> None:
    stt = WhisperSTT(config.stt)
    stt.load()
    result = stt.transcribe_file(path)
    print(json.dumps(result, ensure_ascii=False, indent=2))


async def run_mic(config, seconds: float) -> None:
    from voxkin.runtime import Runtime

    runtime = await Runtime.create(config)
    await runtime.start()
    loop = VoiceLoop(
        pipeline=runtime.pipeline,
        stt=runtime.stt,
        vad=VadSegmenter.from_config(config.stt),
        microphone=Microphone(sample_rate=config.stt.sample_rate, device=config.audio.device),
        emit=runtime.hub.publish,
    )
    task = asyncio.create_task(loop.run())
    try:
        await asyncio.sleep(seconds)
    finally:
        loop.stop()
        task.cancel()
        await runtime.close()


async def run_bench(config, turns: int, text: str, out: Path | None) -> None:
    from voxkin.events import percentile
    from voxkin.runtime import Runtime

    runtime = await Runtime.create(config)
    await runtime.start()
    results = []
    try:
        for index in range(turns):
            summary = await runtime.pipeline.respond(f"{text}（第 {index + 1} 轮）")
            results.append(summary)
            print(json.dumps(summary, ensure_ascii=False))
    finally:
        await runtime.close()
    fields = ("stt_ms", "llm_ttft_ms", "first_sentence_ms", "tts_first_audio_ms", "first_audible_ms")
    aggregate = {}
    for name in fields:
        values = [r[name] for r in results if r.get(name) is not None]
        aggregate[name] = {
            "p50": percentile(values, 0.5),
            "p90": percentile(values, 0.9),
            "min": min(values) if values else None,
            "max": max(values) if values else None,
        }
    report = {"turns": turns, "aggregate": aggregate, "results": results}
    print(json.dumps(aggregate, ensure_ascii=False, indent=2))
    if out is not None:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")


def run_doctor(config) -> None:
    from voxkin.runtime import Runtime

    report = {
        "config_path": str(DEFAULT_CONFIG_PATH),
        "llm": {
            "base_url": config.llm.base_url,
            "model": config.llm.model,
            "api_key_configured": bool(config.llm.resolve_api_key()),
        },
        "tts": {
            "model_dir": config.tts.model_dir,
            "model_dir_exists": Path(config.tts.model_dir).exists(),
            "reference_audio": config.tts.reference_audio,
            "reference_exists": Path(config.tts.reference_audio).exists(),
        },
        "audio_output": config.audio.output,
        "input_devices": Microphone.list_devices(),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    config = load_config(args.config)
    if args.command == "serve":
        asyncio.run(run_serve(config))
    elif args.command == "say":
        asyncio.run(run_say(config, args.text))
    elif args.command == "tts":
        asyncio.run(run_tts(config, args.text, args.out))
    elif args.command == "stt":
        run_stt(config, args.file)
    elif args.command == "mic":
        asyncio.run(run_mic(config, args.seconds))
    elif args.command == "bench":
        asyncio.run(run_bench(config, args.turns, args.text, args.json))
    elif args.command == "doctor":
        run_doctor(config)
    else:
        raise SystemExit(f"未知命令: {args.command}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
