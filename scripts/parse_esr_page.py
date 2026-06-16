"""
parse_esr_page.py

Scrapes the Mattermost ESR page to extract the list of current/past ESR
versions and their EOL dates.

Usage:
    from parse_esr_page import parse_esr_versions
    esrs = parse_esr_versions(html_text)
    # returns [{"version": "10.5", "eol_date": "2025-11-15"}, ...]
"""
import re
from typing import List, Dict, Optional
from bs4 import BeautifulSoup


_VER_RE = re.compile(r'v?(\d+)\.(\d+)')
_DATE_RE = re.compile(r'(\d{4}-\d{2}-\d{2})')


def _extract_date(text: str) -> Optional[str]:
    m = _DATE_RE.search(text)
    return m.group(1) if m else None


def parse_esr_versions(html: str) -> List[Dict]:
    """
    Parse the Mattermost ESR HTML page and return a list of ESR versions.

    Tries two strategies:
      1. Find a table with version/EOL columns.
      2. Fall back to regex scanning headings/paragraphs for version patterns.
    """
    soup = BeautifulSoup(html, 'html.parser')
    results: List[Dict] = []
    seen = set()

    # Strategy 1: look for a table
    for table in soup.find_all('table'):
        headers = [th.get_text(strip=True).lower() for th in table.find_all('th')]
        ver_col = next((i for i, h in enumerate(headers) if 'version' in h), None)
        eol_col = next((i for i, h in enumerate(headers) if 'end' in h or 'eol' in h), None)
        if ver_col is None:
            continue
        for row in table.find_all('tr')[1:]:
            cells = row.find_all('td')
            if len(cells) <= ver_col:
                continue
            ver_text = cells[ver_col].get_text(strip=True)
            m = _VER_RE.search(ver_text)
            if not m:
                continue
            key = f"{m.group(1)}.{m.group(2)}"
            if key in seen:
                continue
            seen.add(key)
            eol = None
            if eol_col is not None and len(cells) > eol_col:
                eol = _extract_date(cells[eol_col].get_text(strip=True))
            results.append({"version": key, "eol_date": eol})

    if results:
        return results

    # Strategy 2: scan headings and paragraphs for ESR version mentions
    for tag in soup.find_all(['h2', 'h3', 'h4', 'li', 'p']):
        text = tag.get_text(strip=True)
        m = _VER_RE.search(text)
        if not m:
            continue
        key = f"{m.group(1)}.{m.group(2)}"
        if key in seen:
            continue
        if not any(kw in text.lower() for kw in ['esr', 'extended support', 'long-term']):
            continue
        seen.add(key)
        eol = _extract_date(text)
        results.append({"version": key, "eol_date": eol})

    return results
