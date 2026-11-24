"""用配置好的 TTS 预合成确认语，写进 work/voice_cache/<voice_id>/。

用法：
    .venv\Scripts\python.exe scripts\build_voice_cache.py --list
    .venv\Scripts\python.exe scripts\build_voice_cache.py
    .venv\Scripts\python.exe scripts\build_voice_cache.py --only ack.collect_blocks
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / "src") not in sys.path:
    sys.path.insert(0, str(ROOT / "src"))

from voxkin.config import load_config
from voxkin.tts import build_tts
from voxkin.voice.cache import SpeechCache
from voxkin.voice.phrase_catalog import catalog_entries


def reference_sha256(path: str) -> str:
    """参考音频的哈希。音色换了哈希就变，缓存要按它判定是否命中。"""
    target = Path(path)
    if not target.is_absolute():
        target = ROOT / target
    if not target.exists():
        return ""
    digest = hashlib.sha256()
    with target.open("rb") as handle:
        for block in iter(lambda: handle.read(65536), b""):
            digest.update(block)
    return digest.hexdigest()


async def build(only: str = "", force: bool = False) -> int:
    config = load_config()
    voice_id = config.voice_cache.voice_id or config.tts.character
    cache = SpeechCache(
        root=config.voice_cache.root,
        voice_id=voice_id,
        expected_engine=config.tts.engine,
    )
    entries = catalog_entries()
    if only:
        entries = [item for item in entries if only in item[0]]
    if not entries:
        print("没有匹配的短语")
        return 1
    tts = build_tts(config.tts)
    await tts.initialize()
    reference = reference_sha256(config.tts.reference_audio)
    built = 0
    try:
        for key, text in entries:
            existing = cache.lookup(key)
            if existing is not None and not force:
                print(f"跳过（已缓存） {key}")
                continue
            chunks = []
            async for pcm in tts.synthesize(text):
                chunks.append(pcm)
            await cache.put(
                key,
                text,
                chunks,
                sample_rate=tts.sample_rate,
                engine=config.tts.engine,
                reference_audio_sha256=reference,
            )
            built += 1
            print(f"已写入 {key}：{text}")
    finally:
        await tts.close()
    print(f"本次生成 {built} 条，缓存目录 {cache.directory}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="预合成确认语缓存")
    parser.add_argument("--only", default="", help="只处理键名里包含该字符串的短语")
    parser.add_argument("--force", action="store_true", help="已有缓存也重新合成")
    parser.add_argument("--list", action="store_true", help="只列出将要合成的短语")
    args = parser.parse_args()
    if args.list:
        for key, text in catalog_entries():
            print(f"{key}\t{text}")
        return 0
    return asyncio.run(build(only=args.only, force=args.force))


if __name__ == "__main__":
    raise SystemExit(main())
