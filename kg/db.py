"""Collections, indexes and per-collection permissions.

Two database users, one MongoClient each:
  improver  custom role: find on every improver-visible collection, insert/update where the
            evaluator writes (brain_nodes, gate_runs, shifts, episodes), no remove, and nothing
            at all on heldout_* (privileges only add, so it simply never gets them)
  gate      readWrite on the database

On Atlas, users and roles can't be created with createUser/createRole over a driver
connection (Atlas rolls them back), so `atlas_cli_commands()` prints the Atlas CLI
commands instead. `create_roles_and_users()` is for a self-managed MongoDB (local
Docker, tests).
"""
from __future__ import annotations

from typing import Optional

from pymongo import ASCENDING, MongoClient
from pymongo.database import Database
from pymongo.errors import CollectionInvalid, OperationFailure

COLLECTIONS = ["brain_nodes", "brain_versions", "envelope", "concepts", "gate_runs", "shifts", "episodes",
               "playbook", "heldout_results", "heldout_seeds"]
GATE_ONLY = ["heldout_results", "heldout_seeds"]

#: what the improver's custom role grants, per collection (section 3 of the KG plan)
IMPROVER_PRIVILEGES = {
    "brain_nodes": ["find", "insert", "update"],
    "brain_versions": ["find"],
    "envelope": ["find"],
    "concepts": ["find"],
    "gate_runs": ["find", "insert", "update"],   # record_proposal / record_shifts run on the evaluator side
    "shifts": ["find", "insert", "update"],
    "episodes": ["find", "insert", "update"],
    "playbook": ["find"],
}

INDEXES = {
    "brain_nodes": [[("parent_id", ASCENDING), ("kind", ASCENDING), ("since", ASCENDING)], [("key", ASCENDING)]],
    "brain_versions": [[("version", ASCENDING)]],
    "gate_runs": [[("base_patch_hash", ASCENDING)], [("env.spec_hash_or_epoch", ASCENDING)],
                  [("edits.target", ASCENDING)], [("env_key", ASCENDING), ("base_patch_hash", ASCENDING)],
                  [("cand_patch_hash", ASCENDING)]],
    "shifts": [[("env_key", ASCENDING), ("patch_hash", ASCENDING), ("split", ASCENDING)]],
    "episodes": [[("shift_id", ASCENDING), ("type", ASCENDING), ("zone", ASCENDING)]],
    "heldout_results": [[("gate_run_id", ASCENDING)]],
}


def ensure_schema(db: Database) -> list[str]:
    """Create missing collections and indexes. Idempotent. Needs the gate (or an admin) user."""
    made = []
    existing = set(db.list_collection_names())
    for name in COLLECTIONS:
        if name not in existing:
            try:
                db.create_collection(name)
                made.append(name)
            except CollectionInvalid:
                pass
    for coll, specs in INDEXES.items():
        for keys in specs:
            db[coll].create_index(keys)
    return made


def improver_role_privileges(db_name: str) -> list[dict]:
    return [{"resource": {"db": db_name, "collection": c}, "actions": acts} for c, acts in IMPROVER_PRIVILEGES.items()]


def create_roles_and_users(admin: MongoClient, db_name: str, improver_pw: str, gate_pw: str,
                           prefix: str = "") -> dict:
    """Self-managed MongoDB only. Creates (or updates) role `<prefix>kgImprover` and users
    `<prefix>improver` / `<prefix>gate` in the admin database."""
    adb = admin["admin"]
    role = f"{prefix}kgImprover"
    privs = improver_role_privileges(db_name)
    try:
        adb.command("createRole", role, privileges=privs, roles=[])
    except OperationFailure as e:
        if e.code != 51002:  # role already exists
            raise
        adb.command("updateRole", role, privileges=privs, roles=[])
    users = {f"{prefix}improver": (improver_pw, [{"role": role, "db": "admin"}]),
             f"{prefix}gate": (gate_pw, [{"role": "readWrite", "db": db_name}])}
    for user, (pw, roles) in users.items():
        try:
            adb.command("createUser", user, pwd=pw, roles=roles)
        except OperationFailure as e:
            if e.code != 51003:  # user already exists
                raise
            adb.command("updateUser", user, pwd=pw, roles=roles)
    return {"role": role, "users": list(users)}


def atlas_cli_commands(db_name: str = "kg", project_id: str = "<PROJECT_ID>") -> list[str]:
    """Atlas CLI commands for the same role and users (needs Project Owner; roles take ~30 s on M0/Flex)."""
    privs = ",".join(f"{a.upper()}@{db_name}.{c}" for c, acts in IMPROVER_PRIVILEGES.items() for a in acts)
    return [
        f"atlas customDbRoles create kgImprover --privilege '{privs}' --projectId {project_id}",
        f"atlas dbusers create --username improver --password '<IMPROVER_PW>' --role kgImprover --projectId {project_id}",
        f"atlas dbusers create --username gate --password '<GATE_PW>' --role readWrite@{db_name} --projectId {project_id}",
    ]


def connect(uri: str, db_name: str, app: str = "kg") -> Database:
    client = MongoClient(uri, appname=app, tz_aware=True, uuidRepresentation="standard")
    return client[db_name]


def probe_heldout_denied(db: Database) -> Optional[str]:
    """The firewall check: returns None when this user is denied on heldout_results, else what it saw."""
    try:
        db["heldout_results"].find_one({})
    except OperationFailure as e:
        if e.code == 13 or "not authorized" in str(e).lower() or "unauthorized" in str(e).lower():
            return None
        raise
    return "readable: this user can read heldout_results"
