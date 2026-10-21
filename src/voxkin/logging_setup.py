from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

LOG_DIR = Path("logs")


def setup_logging(level: str = "INFO", log_file: Path | None = None) -> logging.Logger:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    target = log_file or LOG_DIR / "voxkin.log"
    logger = logging.getLogger("voxkin")
    logger.setLevel(level)
    logger.propagate = False
    if logger.handlers:
        return logger
    formatter = logging.Formatter(
        "%(asctime)s %(levelname)s %(name)s %(message)s", datefmt="%H:%M:%S"
    )
    file_handler = RotatingFileHandler(
        target, maxBytes=4 * 1024 * 1024, backupCount=3, encoding="utf-8"
    )
    file_handler.setFormatter(formatter)
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    logger.addHandler(file_handler)
    logger.addHandler(console)
    return logger


def tail_log(lines: int = 200, log_file: Path | None = None) -> list[str]:
    target = log_file or LOG_DIR / "voxkin.log"
    if not target.exists():
        return []
    with target.open("r", encoding="utf-8", errors="replace") as handle:
        content = handle.readlines()
    return [line.rstrip("\n") for line in content[-lines:]]
