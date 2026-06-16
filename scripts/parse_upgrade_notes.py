"""
parse_upgrade_notes.py

Parses the Mattermost important-upgrade-notes.rst file from GitHub into a
dict mapping "major.minor" → plain-text upgrade note.

Usage:
    from parse_upgrade_notes import parse_upgrade_notes_rst
    notes = parse_upgrade_notes_rst(rst_text)
"""
import re
from typing import Dict


_RST_DIRECTIVE = re.compile(r'\.\. \w[^:]*::.*')
_RST_REF = re.compile(r':ref:`[^`]+`')
_RST_ROLE = re.compile(r':\w+:`([^`]+)`')
_BLANK = re.compile(r'\n{3,}')

# Section heading patterns for Mattermost upgrade notes
_HEADING_PATTERNS = [
    re.compile(r'(?:Release\s+)?[Vv]?(\d+)\.(\d+)\s+(?:Release|ESR|release)?', re.IGNORECASE),
    re.compile(r'[Vv]?(\d+)\.(\d+)\.(\d+)\s+(?:Release)?', re.IGNORECASE),
]


def _clean_rst(text: str) -> str:
    """Strip RST markup to readable plain text."""
    text = _RST_DIRECTIVE.sub('', text)
    text = _RST_REF.sub('', text)
    text = _RST_ROLE.sub(r'\1', text)
    # Remove underline/overline decoration lines (===, ---, ~~~, etc.)
    text = re.sub(r'^[=\-~^#"\'`+*]{3,}\s*$', '', text, flags=re.MULTILINE)
    text = _BLANK.sub('\n\n', text)
    return text.strip()


def _extract_version(title: str):
    """Extract (major, minor) from a section title like 'Release v10.5' or '9.10 Release'."""
    for pat in _HEADING_PATTERNS:
        m = pat.search(title)
        if m:
            return int(m.group(1)), int(m.group(2))
    return None


def _extract_bullets(rst_body: str, max_items: int = 5) -> str:
    """
    Extract bullet-point lines from an RST body section.
    Falls back to the first 300 chars of cleaned prose if no bullets found.
    """
    bullets = []
    for line in rst_body.splitlines():
        stripped = line.strip()
        if stripped.startswith('- ') or stripped.startswith('* '):
            text = _clean_rst(stripped[2:]).strip()
            if len(text) > 8:
                bullets.append(text)
        if len(bullets) >= max_items:
            break

    if bullets:
        return '\n'.join(f'- {b}' for b in bullets)

    # No bullets — return trimmed prose
    cleaned = _clean_rst(rst_body)
    return cleaned[:300]


def parse_upgrade_notes_rst(rst_text: str) -> Dict[str, str]:
    """
    Split an RST document on section-heading underlines and extract
    upgrade notes per 'major.minor' key.

    Returns dict like {"9.10": "- CSRF enforcement...", "10.0": "- PostgreSQL 13..."}
    """
    notes: Dict[str, str] = {}

    # Split into sections by RST section underlines (lines of repeated chars)
    underline_re = re.compile(r'^([=\-~^#"\'`+*])\1{2,}\s*$', re.MULTILINE)
    positions = [m.start() for m in underline_re.finditer(rst_text)]

    if not positions:
        return notes

    # Walk back from each underline to find the preceding title line
    sections = []
    for pos in positions:
        pre = rst_text.rfind('\n', 0, pos)
        title_start = rst_text.rfind('\n', 0, pre) + 1 if pre > 0 else 0
        title = rst_text[title_start:pre].strip()
        sections.append((pos, title))

    # Extract body between consecutive underlines
    for i, (pos, title) in enumerate(sections):
        ver = _extract_version(title)
        if not ver:
            continue
        key = f"{ver[0]}.{ver[1]}"
        body_start = rst_text.find('\n', pos) + 1
        body_end = sections[i + 1][0] if i + 1 < len(sections) else len(rst_text)
        raw_body = rst_text[body_start:body_end]
        body = _extract_bullets(raw_body)
        if body and key not in notes:
            notes[key] = body

    return notes
