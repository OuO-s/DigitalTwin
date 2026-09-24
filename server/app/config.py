from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "server" / "assets"
SITE_PATH = ASSETS / "site.json"
FLOORPLAN_PATH = ASSETS / "floorplans" / "building-06-f07.json"
CAMPUS_LAYOUT_PATH = ASSETS / "campus-layout.json"
DATA_DIR = ROOT / "data"
DB_PATH = DATA_DIR / "twin.sqlite3"


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def site_config() -> dict:
    return read_json(SITE_PATH)


def floorplan_config() -> dict:
    return read_json(FLOORPLAN_PATH)





def campus_layout_config() -> dict:
    return read_json(CAMPUS_LAYOUT_PATH)
