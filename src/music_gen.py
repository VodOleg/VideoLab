# Background music with ACE-Step 1.5 (MIT; generated audio may be used commercially).
# Run by src/music.ts inside .cache/ace-step's uv environment:
#   uv run python <this file> <request.json>
# request.json: {"outDir", "name", "caption", "lyrics", "seconds", "bpm", "key", "seeds": [..],
#                "dit": "turbo" | "sft", "lm": null | "0.6B"}
import json
import os
import shutil
import sys

from acestep.handler import AceStepHandler
from acestep.inference import GenerationConfig, GenerationParams, generate_music
from acestep.llm_inference import LLMHandler
from acestep.model_downloader import ensure_lm_model

# DiT variant -> (diffusion steps, guidance, timestep shift). Turbo is distilled to 8 steps without CFG; SFT takes 50 with CFG.
DIT = {"turbo": (8, 1.0, 3.0), "sft": (50, 7.0, 1.0)}


def main() -> None:
    with open(sys.argv[1], encoding="utf-8") as f:
        req = json.load(f)
    dit_name = req.get("dit", "turbo")
    steps, guidance, shift = DIT[dit_name]

    dit = AceStepHandler()
    # The 2B DiT fits a 6GB GPU INT8-quantized, with the VAE and text encoder offloaded
    # (peak ~3.1GB). The DiT stays on the GPU: offloading it costs ~45s per track.
    low_vram = os.environ.get("ACESTEP_LOW_VRAM", "1") == "1"
    status, ok = dit.initialize_service(
        project_root=os.getcwd(),
        config_path=f"acestep-v15-{dit_name}",
        device="auto",
        offload_to_cpu=low_vram,
        offload_dit_to_cpu=False,
        quantization="int8_weight_only" if low_vram else None,
    )
    if not ok:
        sys.exit(f"ACE-Step init failed: {status}")

    # Optional 5Hz LM planner: it turns the caption into audio codes (song structure) before the DiT renders them.
    lm = LLMHandler()
    if req.get("lm"):
        lm_name = f"acestep-5Hz-lm-{req['lm']}"
        checkpoints = os.path.join(os.getcwd(), "checkpoints")
        ok, status = ensure_lm_model(lm_name, checkpoints)
        if not ok:
            sys.exit(f"LM download failed: {status}")
        status, ok = lm.initialize(checkpoint_dir=checkpoints, lm_model_path=lm_name, backend="pt", device="auto", offload_to_cpu=low_vram)
        if not ok:
            sys.exit(f"LM init failed: {status}")

    os.makedirs(req["outDir"], exist_ok=True)
    tmp = os.path.join(req["outDir"], ".tmp")
    for seed in req["seeds"]:
        params = GenerationParams(
            task_type="text2music",
            caption=req["caption"],
            lyrics=req.get("lyrics") or "[Instrumental]",
            instrumental=True,
            duration=req["seconds"],
            bpm=req.get("bpm"),
            keyscale=req.get("key") or "",
            timesignature="4",
            seed=seed,
            inference_steps=steps,
            guidance_scale=guidance,
            shift=shift,
            thinking=bool(req.get("lm")),
            use_cot_caption=False,  # keep our caption; let the LM fill only what's missing
            use_cot_language=False,
        )
        config = GenerationConfig(batch_size=1, use_random_seed=False, seeds=[seed], audio_format="wav")
        result = generate_music(dit, lm, params, config, save_dir=tmp)
        if not result.success:
            sys.exit(f"Generation failed (seed {seed}): {result.error or result.status_message}")
        out = os.path.join(req["outDir"], f"{req['name']}-{seed}.wav")
        shutil.move(result.audios[0]["path"], out)
        print(f"wrote {out}", flush=True)
    shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
