"""Go/no-go checks for switching to the real runner (KG plan, 13:15-13:45)."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Optional

from ..contract import Brain, ValidateBrainResponse
from ..hashing import same_value
from ..runner import default_twinforge_dir


def _effective(compiled: dict) -> list[dict]:
    """compile_check prints the patch; rebuild {target, value} pairs from it for the diff."""
    out = []
    for k, v in (compiled.get("patch") or {}).get("sim", {}).items():
        out.append({"target": f"assign.{k}" if k.startswith("W_") else f"sim.{k}", "value": v, "node_id": "?"})
    for c, fields in (compiled.get("patch") or {}).get("classes", {}).items():
        out += [{"target": f"class.{c}.{f}", "value": v, "node_id": "?"} for f, v in fields.items()]
    for z, fields in (compiled.get("patch") or {}).get("zones", {}).items():
        out += [{"target": f"zone.{z}.{f}", "value": v, "node_id": "?"} for f, v in fields.items()]
    return out


def compile_with_twinforge(paths: list[str], twinforge_dir: Optional[str] = None) -> dict:
    """TwinForge's own compiler on brain files, through tsx (kg/tools/compile_check.mts); no HTTP runner."""
    tf = Path(twinforge_dir) if twinforge_dir else default_twinforge_dir()
    tsx = tf / "node_modules" / ".bin" / "tsx"
    script = Path(__file__).with_name("compile_check.mts")
    if not tsx.exists() or not (tf / "src" / "harness" / "brain.ts").exists():
        raise FileNotFoundError(f"needs {tsx} and {tf}/src/harness/brain.ts (WP-B)")
    p = subprocess.run([str(tsx), str(script), *map(str, paths)], capture_output=True, text=True, timeout=120,
                       env={**os.environ, "TWINFORGE_DIR": str(tf)})
    if p.returncode != 0:
        raise RuntimeError(p.stderr.strip()[-800:])
    return json.loads(p.stdout)


def check_v1(kg, runner, v1_json: str | Path) -> dict:
    """export_brain(1) must compile to the same patch_hash as brains/v1.json (WP-B). Uses the runner's
    /validate_brain, or TwinForge's compiler through tsx when the runner has none. If they differ, lists
    every setting where they do, so the fix (re-seed a fresh database with seed(v1_brain=...)) is obvious."""
    ours = kg.export_brain(1)
    theirs = Brain.model_validate(json.loads(Path(v1_json).read_text()))
    a = runner.validate_brain(ours) if runner is not None else None
    b = runner.validate_brain(theirs) if runner is not None else None
    if a is None or b is None:
        with tempfile.TemporaryDirectory() as d:
            ours_path = Path(d) / "kg_v1.json"
            ours_path.write_text(json.dumps(ours.model_dump(mode="json", exclude_none=True)))
            got = compile_with_twinforge([str(ours_path), str(v1_json)])
        a = ValidateBrainResponse.model_validate(got[str(ours_path)] | {"effective": _effective(got[str(ours_path)])})
        b = ValidateBrainResponse.model_validate(got[str(v1_json)] | {"effective": _effective(got[str(v1_json)])})
        via = "TwinForge compiler via tsx"
    else:
        via = "runner /validate_brain"
    ea = {e.target: e.value for e in a.effective}
    eb = {e.target: e.value for e in b.effective}
    diffs = [{"target": t, "kg": ea.get(t), "v1_json": eb.get(t)} for t in sorted(set(ea) | set(eb))
             if not same_value(ea.get(t), eb.get(t))]
    return {"ok": a.patch_hash == b.patch_hash and not a.locked_edits and not a.rejected, "via": via,
            "kg_patch_hash": a.patch_hash, "v1_json_patch_hash": b.patch_hash,
            "kg_local_patch_hash": kg._local_validation(ours).patch_hash, "diffs": diffs,
            "kg_locked_edits": [x.model_dump() for x in a.locked_edits],
            "kg_rejected": [x.model_dump() for x in a.rejected], "kg_warnings": a.warnings}


def capped_report(kg, split: str = "train") -> dict:
    """Failure types that hit the 25-per-seed cap in recorded shifts (show those flagged on screen)."""
    pipeline = [{"$match": {"capped": True, "split": split, "env_key": kg.env.key}},
                {"$group": {"_id": "$type", "episodes": {"$sum": 1}, "shifts": {"$addToSet": "$shift_id"}}},
                {"$project": {"episodes": 1, "shifts": {"$size": "$shifts"}}}]
    return {d["_id"]: {"episodes": d["episodes"], "shifts": d["shifts"]} for d in kg.c("episodes").aggregate(pipeline)}
