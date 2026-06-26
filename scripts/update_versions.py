#!/usr/bin/env python3
"""
update_versions.py

Fetches the latest Mattermost release data from three sources and merges it
into data/versions.json:

  1. GitHub Releases API  — version list, dates, security fix markers
  2. mattermost/docs RST  — important-upgrade-notes.rst → upgrade notes per version
  3. Mattermost ESR page  — current ESR versions + EOL dates

Run locally:
    pip install -r scripts/requirements.txt
    python scripts/update_versions.py

In GitHub Actions, set the GITHUB_TOKEN env var to avoid rate limiting.
The script writes atomically (temp file + rename) and exits non-zero on failure
so the workflow never commits a partial file.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests

# ── Paths ──────────────────────────────────────────────────────────────────
ROOT = Path(__file__).parent.parent
DATA_FILE = ROOT / "data" / "versions.json"
SEED_FILE = ROOT / "data" / "seed.json"

# ── Sources ────────────────────────────────────────────────────────────────
GITHUB_RELEASES_URL = (
    "https://api.github.com/repos/mattermost/mattermost/releases?per_page=100"
)
UPGRADE_NOTES_URL = (
    "https://raw.githubusercontent.com/mattermost/docs/main"
    "/source/upgrade/important-upgrade-notes.rst"
)
ESR_PAGE_URL = (
    "https://docs.mattermost.com/upgrade/extended-support-release.html"
)
COMPAT_PAGE_URL = (
    "https://docs.mattermost.com/about/server-client-compatibility-matrix.html"
)

# ── Helpers ────────────────────────────────────────────────────────────────
VER_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)$")
BREAKING_MARKER = re.compile(
    r"\*\*(?:Breaking|Important|BREAKING|IMPORTANT)[^*]*\*\*[:\s]+(.+)", re.IGNORECASE
)
SECURITY_MARKER = re.compile(r"(CVE-\d{4}-\d+|security fix|security patch)", re.IGNORECASE)


def parse_ver(v: str) -> tuple[int, int, int] | None:
    m = VER_RE.match(v.strip())
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def ver_str(t: tuple) -> str:
    return ".".join(str(x) for x in t)


def major_minor(v: str) -> str | None:
    t = parse_ver(v)
    return f"{t[0]}.{t[1]}" if t else None


def make_session() -> requests.Session:
    s = requests.Session()
    token = os.environ.get("GITHUB_TOKEN", "")
    if token:
        s.headers["Authorization"] = f"Bearer {token}"
    s.headers["User-Agent"] = "mm-upgrade-advisor/1.0"
    return s


# ── Phase 1: GitHub Releases ────────────────────────────────────────────────

def fetch_github_releases(session: requests.Session) -> list[dict]:
    print("Phase 1: fetching GitHub releases…")
    resp = session.get(GITHUB_RELEASES_URL, timeout=20)
    resp.raise_for_status()
    releases = resp.json()

    result = []
    for rel in releases:
        if rel.get("prerelease") or rel.get("draft"):
            continue
        tag = rel.get("tag_name", "")
        ver = tag.lstrip("v")
        if not parse_ver(ver):
            continue

        body = rel.get("body") or ""
        # Count security fixes in release notes
        security_count = len(SECURITY_MARKER.findall(body))
        # Extract breaking change lines
        breaking = [m.group(1).strip() for m in BREAKING_MARKER.finditer(body)]

        result.append({
            "version": ver,
            "release_date": rel.get("published_at", "")[:10],
            "download_url": rel.get("html_url", ""),
            "security_fix_count_github": security_count,
            "breaking_from_github": breaking,
        })

    print(f"  → {len(result)} releases found")
    return result


# ── Phase 2: Upgrade notes RST ─────────────────────────────────────────────

def fetch_upgrade_notes(session: requests.Session) -> dict[str, str]:
    print("Phase 2: fetching upgrade notes RST…")
    try:
        resp = session.get(UPGRADE_NOTES_URL, timeout=20)
        resp.raise_for_status()
    except Exception as e:
        print(f"  ⚠ Could not fetch upgrade notes: {e}")
        return {}

    try:
        from parse_upgrade_notes import parse_upgrade_notes_rst
        notes = parse_upgrade_notes_rst(resp.text)
        print(f"  → {len(notes)} version notes parsed")
        return notes
    except Exception as e:
        print(f"  ⚠ RST parse failed: {e}")
        return {}


# ── Phase 3: ESR page ───────────────────────────────────────────────────────

def fetch_esr_versions(session: requests.Session, seed_esrs: list[str]) -> list[str]:
    print("Phase 3: fetching ESR version list…")
    try:
        resp = session.get(ESR_PAGE_URL, timeout=20)
        resp.raise_for_status()
    except Exception as e:
        print(f"  ⚠ Could not fetch ESR page: {e} — using seed list")
        return seed_esrs

    try:
        from parse_esr_page import parse_esr_versions
        parsed = parse_esr_versions(resp.text)
        if not parsed:
            print("  ⚠ No ESR versions parsed — using seed list")
            return seed_esrs
        versions = sorted(set(e["version"] for e in parsed), key=lambda v: [int(x) for x in v.split(".")])
        print(f"  → ESR versions: {versions}")
        return versions
    except Exception as e:
        print(f"  ⚠ ESR parse failed: {e} — using seed list")
        return seed_esrs


# ── Phase 4: Compatibility matrix ──────────────────────────────────────────

def fetch_client_compatibility(session: requests.Session, seed_compat: dict) -> dict:
    print("Phase 4: fetching client compatibility matrix…")
    try:
        resp = session.get(COMPAT_PAGE_URL, timeout=20)
        resp.raise_for_status()
    except Exception as e:
        print(f"  ⚠ Could not fetch compatibility page: {e} — using seed data")
        return seed_compat

    try:
        from parse_compatibility import parse_compatibility
        parsed = parse_compatibility(resp.text)
        if not parsed:
            print("  ⚠ No compatibility data parsed — using seed data")
            return seed_compat
        # Merge: scraped data wins, seed fills gaps for majors not found
        merged = dict(seed_compat)
        merged.update(parsed)
        print(f"  → Compatibility entries: {sorted(merged.keys())}")
        return merged
    except Exception as e:
        print(f"  ⚠ Compatibility parse failed: {e} — using seed data")
        return seed_compat


# ── Phase 5: Merge and write ────────────────────────────────────────────────

ESR_VER_MAP: dict[str, str] = {}  # major.minor → type tag, built during merge


def _determine_release_type(version: str, esr_versions: list[str]) -> str:
    mm = major_minor(version)
    if not mm:
        return "regular"
    t = parse_ver(version)
    if t and t[2] == 0:
        # major.minor.0 — check against ESR list
        if mm in esr_versions:
            return "esr"
        if t[1] == 0:
            return "major"
    return "regular"


def merge(
    existing: list[dict],
    github_releases: list[dict],
    upgrade_notes: dict[str, str],
    esr_versions: list[str],
) -> tuple[list[dict], int, int]:
    """
    Merge live data into the existing version list.
    Returns (merged_list, added_count, updated_count).
    """
    # Index existing records by version string
    idx: dict[str, dict] = {r["version"]: r for r in existing}
    added, updated = 0, 0

    for gh in github_releases:
        ver = gh["version"]
        mm = major_minor(ver)
        rec = idx.get(ver)

        if rec is None:
            # New version — create a minimal record
            rec = {
                "version": ver,
                "release_type": _determine_release_type(ver, esr_versions),
                "release_date": gh["release_date"],
                "headline": "",
                "breaking_changes": gh["breaking_from_github"],
                "upgrade_notes": upgrade_notes.get(mm or "", ""),
                "min_pg_version": None,
                "min_mysql_version": None,
                "security_fix_count": gh["security_fix_count_github"],
                "download_url": gh["download_url"],
                "changelog_url": "https://docs.mattermost.com/install/self-managed-changelog.html",
            }
            idx[ver] = rec
            added += 1
        else:
            # Update only fields the script owns — never overwrite manual curation
            changed = False
            if not rec.get("download_url") and gh["download_url"]:
                rec["download_url"] = gh["download_url"]
                changed = True
            if not rec.get("release_date") and gh["release_date"]:
                rec["release_date"] = gh["release_date"]
                changed = True
            # Merge upgrade notes if none exist yet
            if not rec.get("upgrade_notes") and mm and upgrade_notes.get(mm):
                rec["upgrade_notes"] = upgrade_notes[mm]
                changed = True
            if changed:
                updated += 1

    # Also refresh upgrade_notes_by_version with newly fetched RST data
    # (returned separately — caller stores it)

    # Sort by version ascending
    def sort_key(r):
        t = parse_ver(r["version"])
        return t if t else (0, 0, 0)

    merged = sorted(idx.values(), key=sort_key)
    return merged, added, updated


def compute_meta(versions: list[dict], esr_versions: list[str], existing_meta: dict | None = None) -> dict:
    def ver_key(v):
        t = parse_ver(v)
        return t if t else (0, 0, 0)

    all_vers = [r["version"] for r in versions]
    latest = max(all_vers, key=ver_key) if all_vers else ""
    latest_esr = max(
        (r["version"] for r in versions if r.get("release_type") == "esr"),
        key=ver_key,
        default="",
    )
    meta = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "generated_by": "scripts/update_versions.py",
        "latest_version": latest,
        "latest_esr": latest_esr,
        "source_urls": [GITHUB_RELEASES_URL, UPGRADE_NOTES_URL, ESR_PAGE_URL],
    }
    # Preserve manually-set fields from existing meta
    if existing_meta:
        for field in ("bugs_last_reviewed",):
            if existing_meta.get(field):
                meta[field] = existing_meta[field]
    return meta


def load_existing() -> dict[str, Any]:
    if DATA_FILE.exists():
        with DATA_FILE.open() as f:
            return json.load(f)
    with SEED_FILE.open() as f:
        return json.load(f)


def write_atomic(data: dict) -> None:
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(dir=DATA_FILE.parent, suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp_path, DATA_FILE)
    except Exception:
        os.unlink(tmp_path)
        raise


# ── Main ────────────────────────────────────────────────────────────────────

def main() -> int:
    session = make_session()

    # Load baseline
    existing_data = load_existing()
    existing_versions = existing_data.get("versions", [])
    seed_esrs = existing_data.get("esr_versions", [])
    existing_bugs = existing_data.get("known_bugs", [])
    existing_notes_by_ver = existing_data.get("upgrade_notes_by_version", {})
    existing_compat = existing_data.get("client_compatibility") or {}
    # If versions.json has no compat data (e.g. first run after feature was added),
    # seed.json is the authoritative fallback
    if not existing_compat and SEED_FILE.exists():
        with SEED_FILE.open() as _sf:
            existing_compat = json.load(_sf).get("client_compatibility", {})

    # Fetch from sources
    try:
        github_releases = fetch_github_releases(session)
    except Exception as e:
        print(f"FATAL: GitHub releases fetch failed: {e}")
        return 1

    upgrade_notes = fetch_upgrade_notes(session)
    esr_versions = fetch_esr_versions(session, seed_esrs)
    client_compat = fetch_client_compatibility(session, existing_compat)

    # Merge
    merged_versions, added, updated = merge(
        existing_versions, github_releases, upgrade_notes, esr_versions
    )

    # Merge upgrade notes by version (RST wins over seed for new entries)
    merged_notes = dict(existing_notes_by_ver)
    for key, val in upgrade_notes.items():
        if key not in merged_notes:
            merged_notes[key] = val

    # Compose final document
    final = {
        "meta": compute_meta(merged_versions, esr_versions, existing_data.get("meta")),
        "esr_versions": esr_versions if esr_versions else seed_esrs,
        "versions": merged_versions,
        "known_bugs": existing_bugs,  # never overwrite — curated manually
        "client_compatibility": client_compat,
        "upgrade_notes_by_version": merged_notes,
    }

    write_atomic(final)
    print(f"\n✓ data/versions.json updated: +{added} new, ~{updated} refreshed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
