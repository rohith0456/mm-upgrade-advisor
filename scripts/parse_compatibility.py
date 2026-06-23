"""
parse_compatibility.py

Scrapes the Mattermost server-client compatibility matrix page and returns
a dict mapping server major version (as string) to minimum desktop and mobile
app versions.

Returns: {"11": {"desktop_min": "5.10", "mobile_min": "2.18"}, ...}
"""
import re
from typing import Dict


def parse_compatibility(html: str) -> Dict[str, Dict[str, str]]:
    try:
        from bs4 import BeautifulSoup
    except ImportError:
        return {}

    soup = BeautifulSoup(html, "html.parser")
    result: Dict[str, Dict[str, str]] = {}

    # Find the compatibility table — look for a table with "Server" and "Desktop" headers
    for table in soup.find_all("table"):
        headers = [th.get_text(strip=True).lower() for th in table.find_all("th")]
        if not any("server" in h for h in headers):
            continue

        # Find column indices
        server_col = next((i for i, h in enumerate(headers) if "server" in h), None)
        desktop_col = next((i for i, h in enumerate(headers) if "desktop" in h), None)
        mobile_col = next((i for i, h in enumerate(headers) if "mobile" in h), None)

        if server_col is None or (desktop_col is None and mobile_col is None):
            continue

        for row in table.find_all("tr"):
            cells = row.find_all(["td", "th"])
            if len(cells) <= max(filter(None, [server_col, desktop_col, mobile_col])):
                continue

            server_text = cells[server_col].get_text(strip=True)
            # Extract major version from strings like "9.x", "10.x", "v11", "11.x"
            m = re.search(r"(\d+)", server_text)
            if not m:
                continue
            major = m.group(1)
            if major == "0":
                continue

            entry: Dict[str, str] = {}
            if desktop_col is not None and desktop_col < len(cells):
                dt = cells[desktop_col].get_text(strip=True)
                dv = re.search(r"(\d+\.\d+)", dt)
                if dv:
                    entry["desktop_min"] = dv.group(1)

            if mobile_col is not None and mobile_col < len(cells):
                mt = cells[mobile_col].get_text(strip=True)
                mv = re.search(r"(\d+\.\d+)", mt)
                if mv:
                    entry["mobile_min"] = mv.group(1)

            if entry and major not in result:
                result[major] = entry

        if result:
            break  # found the right table

    return result
