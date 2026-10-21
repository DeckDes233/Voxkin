import argparse
import shutil
from pathlib import Path

import yaml


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="把音色权重接入 GPT-SoVITS 运行包并写入推理配置")
    parser.add_argument("--bundle", type=Path, required=True, help="GPT-SoVITS 运行包根目录")
    parser.add_argument("--ckpt", type=Path, required=True, help="GPT 权重 .ckpt")
    parser.add_argument("--pth", type=Path, required=True, help="SoVITS 权重 .pth")
    parser.add_argument("--ref-audio", type=Path, required=True, help="参考音频 wav")
    parser.add_argument("--device", default="cuda", help="cuda 或 cpu")
    parser.add_argument("--half", action="store_true", help="使用半精度（cuda 推荐）")
    parser.add_argument("--version", default="v2Pro", choices=["v1", "v2", "v2Pro", "v2ProPlus", "v3", "v4"])
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    bundle = args.bundle.resolve()
    if not (bundle / "api_v2.py").exists():
        raise SystemExit(f"不是有效的 GPT-SoVITS 运行包: {bundle}")
    if not args.ckpt.exists() or not args.pth.exists():
        raise SystemExit("权重文件不存在")
    if not args.ref_audio.exists():
        raise SystemExit(f"参考音频不存在: {args.ref_audio}")

    weights_dir = bundle / "GPT_weights"
    vits_dir = bundle / "SoVITS_weights"
    weights_dir.mkdir(exist_ok=True)
    vits_dir.mkdir(exist_ok=True)
    ckpt_target = weights_dir / args.ckpt.name
    pth_target = vits_dir / args.pth.name
    shutil.copy2(args.ckpt, ckpt_target)
    shutil.copy2(args.pth, pth_target)

    config_path = bundle / "GPT_SoVITS" / "configs" / "tts_infer.yaml"
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    config["custom"] = {
        "bert_base_path": "GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large",
        "cnhuhbert_base_path": "GPT_SoVITS/pretrained_models/chinese-hubert-base",
        "device": args.device,
        "is_half": bool(args.half),
        "t2s_weights_path": f"GPT_weights/{ckpt_target.name}",
        "version": args.version,
        "vits_weights_path": f"SoVITS_weights/{pth_target.name}",
    }
    config_path.write_text(
        yaml.safe_dump(config, allow_unicode=True, sort_keys=False), encoding="utf-8"
    )

    print("权重已复制:")
    print(" ", ckpt_target)
    print(" ", pth_target)
    print("推理配置已写入:", config_path)
    print("参考音频:", args.ref_audio.resolve())
    print()
    print("启动命令:")
    print(
        f'cd "{bundle}" && runtime\\python.exe api_v2.py -a 127.0.0.1 -p 9880 '
        f'-c GPT_SoVITS\\configs\\tts_infer.yaml'
    )


if __name__ == "__main__":
    main()
