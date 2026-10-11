"""The playbook: human habits sourced from short video clips, plus the four SOP paragraphs.

Each habit is one thing a warehouse worker does on film, written up so the brain can act on it.
The pipeline (kg/README.md "The phone call (Person C)", project record "The clips") works
clip-first: pick free stock footage, then write the habit and the setting it maps to so the text
fits what the clip really shows. Every habit names a *lever group* (`c:lever/<group>`, see
kg/registry.py LEVER_GROUPS) and, where a setting expresses the habit, a `suggests` map of
one real registry target to a value inside its [min, max]. The `yielding` group has no setting
yet, so its habit carries an empty `suggests` and says so: that is the capability gap the demo
points at.

The KG owns only the `helpful` / `harmful` counters (gate.add_habit strips them); everything else
here is Person C's content and may be re-seeded freely, which is why `seed()` is idempotent.

Clip sources and licences: harness/clips/README.md. All clips are Pexels (Pexels License: free
for commercial use, no attribution required, no AI-training use); `source` on each habit repeats
title, author, licence and page URL so the demo can credit the videographer on screen.

Run from the repo root:
    harness/.venv/bin/python -m harness.playbook
"""
from __future__ import annotations

import os
import sys

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from kg.ontology import SKELETON_ZONES, TASK_TYPES  # noqa: E402
from kg.registry import by_target  # noqa: E402

PEXELS_LICENSE = "Pexels License"

# Zone node ids that exist in the skeleton (kg/ontology.py SKELETON_ZONES: B, C, D, M).
_ZONES = [f"zone:{z}" for z in SKELETON_ZONES]
_GROUND_ZONES = [f"zone:{z}" for z in SKELETON_ZONES if z != "M"]


def _tasks(task_type: str, zones=SKELETON_ZONES) -> list[str]:
    assert task_type in TASK_TYPES, task_type
    return [f"task:{z}:{task_type}" for z in zones]


def _clip(video_id: int, filename: str, t0: float, t1: float) -> dict:
    return {"uri": f"https://videos.pexels.com/video-files/{video_id}/{filename}", "t0": t0, "t1": t1}


def _source(title: str, author: str, page_url: str) -> dict:
    return {"title": title, "author": author, "license": PEXELS_LICENSE, "page_url": page_url}


# ── habits ───────────────────────────────────────────────────────────────────────────────────────

HABITS: list[dict] = [
    {
        "habit_id": "habit:stairs-when-lift-busy",
        "text": "Crossing an office atrium, a person walks straight to the open staircase and climbs it on foot "
                "instead of standing at the lift. The stairs are right there, so the wait is the thing to avoid.",
        "clip": _clip(12820607, "12820607-uhd_2560_1440_25fps.mp4", 0.0, 8.0),
        "steps": [
            "Arrive at the floor-change point (lift lobby in zone C).",
            "Look at the lift queue; if two or more are already waiting, do not join it.",
            "Walk to the west stairs and climb to the mezzanine.",
        ],
        "lever_group": "c:lever/floor_change",
        "applies_to": ["zone:M", "zone:C"],
        "suggests": {"sim.STAIR_MIN_LIFT_QUEUE": 2},
        "narration": "If two people are already waiting for the lift, I just take the stairs.",
        "source": _source("Man Walking in an Office Building", "Fnesan",
                          "https://www.pexels.com/video/man-walking-in-an-office-building-12820607/"),
    },
    {
        "habit_id": "habit:empty-handed-on-stairs",
        "text": "A man climbs a long flight of stairs carrying only a backpack, both hands free on the way up. "
                "People take the stairs when they are not carrying anything; with a load in their arms they wait "
                "for the lift.",
        "clip": _clip(5658034, "5658034-hd_1920_1080_24fps.mp4", 0.0, 12.0),
        "steps": [
            "Before choosing the stairs, check what you are carrying.",
            "If you hold a tote, go to the lift lobby and ride the lift.",
            "Only climb the west stairs when empty-handed.",
        ],
        "lever_group": "c:lever/floor_change",
        "applies_to": ["zone:M", "zone:C"],
        "suggests": {"sim.STAIR_MAX_LOAD": 0},
        "narration": "I never carry anything heavy up the stairs; if my hands are full I take the lift.",
        "source": _source("A Man Climbing the Stairs", "Pat Whelen",
                          "https://www.pexels.com/video/a-man-climbing-the-stairs-5658034/"),
    },
    {
        "habit_id": "habit:slow-near-blind-corner",
        "text": "A worker carries a cardboard box down a narrow warehouse aisle between tall shelves, walking "
                "at an easy pace and easing off as he nears the end of the aisle where he cannot see round "
                "the racking.",
        "clip": _clip(4292299, "4292299-uhd_2560_1440_25fps.mp4", 0.0, 8.5),
        "steps": [
            "Carry the tote close to the body and keep a steady walking pace in the aisle.",
            "Start slowing earlier than usual when approaching an aisle end or a blind corner.",
            "Only return to full speed once the cross-aisle is visible and clear.",
        ],
        "lever_group": "c:lever/motion",
        "applies_to": _tasks("TRANSPORT") + _tasks("PICK"),
        # locked: class motion settings need a human approval (a call) before they may differ from v1
        "suggests": {"sim.PERC_SLOW": 3.2},
        "narration": "I slow down a few steps before a blind corner, because I can't see who's coming the other way.",
        "source": _source("Man Working inside the Warehouse", "Tiger Lily",
                          "https://www.pexels.com/video/man-working-inside-the-warehouse-4292299/"),
    },
    {
        "habit_id": "habit:back-off-head-on",
        "text": "A delivery courier stands to one side of a hallway door with his bag, waiting for the person "
                "on the other side rather than pushing through. He gives way quickly and does not stand "
                "nose-to-nose in the doorway.",
        "clip": _clip(7701955, "7701955-uhd_2732_1440_25fps.mp4", 0.0, 12.0),
        "steps": [
            "When you meet someone head-on in a doorway or a one-lane aisle, stop.",
            "Step back and to the side within a few seconds rather than holding your ground.",
            "Let the other party pass, then continue.",
        ],
        "lever_group": "c:lever/waiting",
        "applies_to": _ZONES,
        "suggests": {"sim.WAIT_BACKOFF_TICKS": 50},
        "narration": "If I meet someone head-on in a doorway, I step back right away instead of waiting them out.",
        "source": _source("Man Waiting In Front of a Door", "MART PRODUCTION",
                          "https://www.pexels.com/video/man-waiting-in-front-of-a-door-7701955/"),
    },
    {
        "habit_id": "habit:clear-nearby-shelves-first",
        "text": "A warehouseman parks his cart at the shelf and pulls boxes from the levels in front of him, "
                "working one bay at a time and loading the cart before moving on. He does not cross the "
                "warehouse for a single box.",
        "clip": _clip(7019236, "7019236-uhd_2732_1440_25fps.mp4", 0.0, 20.0),
        "steps": [
            "Take the pick nearest to where you already stand.",
            "Clear the boxes in the current bay (shelf levels 1 to 4) before walking to another aisle.",
            "Only then head to the next bay or the pack station.",
        ],
        "lever_group": "c:lever/dispatch",
        "applies_to": _tasks("PICK"),
        "suggests": {"assign.W_DISTANCE": 0.5},
        "narration": "I pick what's closest to me first and clear the bay before I go anywhere else.",
        "source": _source("A Warehouseman Getting Boxes from the Storage Using Shopping Cart", "cottonbro studio",
                          "https://www.pexels.com/video/a-warehouseman-getting-boxes-from-the-storage-"
                          "using-shopping-cart-7019236/"),
    },
    {
        "habit_id": "habit:yield-to-loaded-forklift",
        "text": "Workers on foot keep clear of the aisle while a forklift carrying a load of timber drives "
                "through the warehouse; the loaded machine has the right of way and the people wait at the "
                "side until it has passed.",
        "clip": _clip(4727768, "4727768-hd_1920_1080_30fps.mp4", 0.0, 15.0),
        "steps": [
            "When a loaded cart or forklift approaches, stop at the side of the aisle.",
            "Let the loaded vehicle pass first; an empty walker yields to a loaded one.",
            "Resume only when its path is clear.",
        ],
        "lever_group": "c:lever/yielding",
        "applies_to": _tasks("TRANSPORT", [z for z in SKELETON_ZONES if z != "M"]),
        # Capability gap: no registry setting expresses "give way to the loaded robot". The engine's
        # wait/backoff rules are symmetric (sim.WAIT_* fire for whichever robot blocked first) and the
        # yielding lever group is empty on purpose (kg/registry.py LEVER_GROUP_LABELS). Leave this
        # empty until the runner adds a yield-priority setting; the demo shows it as the open gap.
        "suggests": {},
        "gap": "No setting expresses load-aware yielding yet; the yielding lever group is empty on purpose.",
        "narration": "When a loaded forklift is coming through, I stop and let it pass; I'm empty-handed, it isn't.",
        "source": _source("Video Footage Of Hardware Warehouse", "Luday Leguen",
                          "https://www.pexels.com/video/video-footage-of-hardware-warehouse-4727768/"),
    },
]


# ── SOPs ─────────────────────────────────────────────────────────────────────────────────────────

SOPS: dict[str, str] = {
    "PICK": (
        "A pick starts at the task's bay: walk the aisle to the bay, confirm the location label, and take "
        "the tote from the shelf level the order names, level 1 being the floor level and level 4 the "
        "highest reachable one. Lift level 3 and 4 totes with the arm raised and the body square to the "
        "shelf, never while turning. Carry one tote at a time at walking pace and keep to the right of the "
        "aisle. For mezzanine picks in zone M, go up by the lift lobby in zone C or the west stairs, and "
        "check the lift queue before deciding."
    ),
    "REPLENISH": (
        "Replenishment moves stock from the receiving dock in zone D to the shelf locations that have run "
        "low. Collect the tote at the dock, check the destination label, and place it on the exact level "
        "listed, filling level 1 and 2 first so heavy items stay low. On the mezzanine, replenish from the "
        "lift side so a loaded tote never goes up the west stairs. Leave the aisle clear of empty cartons "
        "before moving to the next location."
    ),
    "TRANSPORT": (
        "Transport carries a tote between zones, usually from a pick bay to the pack station or between "
        "ground zones B, C and D. Walk at normal speed in open aisles, slow before blind corners and at "
        "aisle ends, and give way to a loaded cart or forklift. When a route crosses floors, use the lift "
        "lobby in zone C when the queue is short and the west stairs only when empty-handed. If blocked "
        "head-on, step aside within a few seconds rather than waiting for the other side to move."
    ),
    "RETURN": (
        "A return is the empty-handed trip back after a drop: go to the next assigned task if one is waiting, "
        "otherwise walk to the parking spots so you are not standing in a live aisle. Check the battery on "
        "the way; if it is low, go to the chargers in zone C and plug in before taking another job. Returns "
        "from the mezzanine may use the west stairs because nothing is being carried. Keep to the side of "
        "the aisle so loaded traffic can pass."
    ),
}


# ── validation and seeding ───────────────────────────────────────────────────────────────────────

def validate(habits: list[dict] = HABITS) -> list[str]:
    """Every suggested target must be a real registry setting and its value must sit inside [min, max].
    Returns a list of problems (empty when all is well)."""
    reg = by_target()
    problems = []
    for h in habits:
        group = h["lever_group"].removeprefix("c:lever/")
        for target, value in (h.get("suggests") or {}).items():
            s = reg.get(target)
            if s is None:
                problems.append(f"{h['habit_id']}: unknown setting {target}")
                continue
            if not (s.min <= value <= s.max):
                problems.append(f"{h['habit_id']}: {target}={value} outside [{s.min}, {s.max}]")
            if s.group != group:
                problems.append(f"{h['habit_id']}: {target} belongs to {s.group}, not {group}")
            if s.integer and float(value) != int(value):
                problems.append(f"{h['habit_id']}: {target} is whole-number, got {value}")
    return problems


def seed(gate) -> dict:
    """Upsert every habit (via gate.add_habit, which keeps the KG's counters) and every SOP paragraph.
    Idempotent: running it twice leaves the same documents. Returns ids and a count of SOPs written."""
    problems = validate()
    if problems:
        raise ValueError("playbook has invalid suggestions: " + "; ".join(problems))
    ids = []
    for h in HABITS:
        h = dict(h)
        habit_id = h.pop("habit_id")
        text = h.pop("text")
        ids.append(gate.add_habit(habit_id, text, **h))
    sops = gate.c("sop_docs")
    for task_type, text in SOPS.items():
        sops.update_one({"_id": f"sop:{task_type}"}, {"$set": {"task_type": task_type, "text": text}}, upsert=True)
    return {"habits": ids, "sops": len(SOPS)}


if __name__ == "__main__":
    import kg

    kg.load_dotenv()
    gate = kg.connect("gate", with_runner=False)
    print(seed(gate))
