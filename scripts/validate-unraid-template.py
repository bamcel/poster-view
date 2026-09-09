"""Validate the repository metadata required by Unraid Community Applications."""

from __future__ import annotations

import struct
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parents[1]
REQUIRED_TEMPLATE_FIELDS = (
    "Name",
    "Repository",
    "Overview",
    "Project",
    "Support",
    "TemplateURL",
    "Icon",
)


def fail(message: str) -> None:
    raise ValueError(message)


def required_text(root: ET.Element, field: str, source: Path) -> str:
    value = (root.findtext(field) or "").strip()
    if not value:
        fail(f"{source}: <{field}> must not be empty")
    return value


def require_http_url(value: str, field: str, source: Path) -> None:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        fail(f"{source}: <{field}> must be an absolute HTTP(S) URL")


def validate_profile() -> None:
    source = ROOT / "ca_profile.xml"
    root = ET.parse(source).getroot()
    if root.tag != "CommunityApplications":
        fail(f"{source}: root element must be <CommunityApplications>")
    required_text(root, "Profile", source)
    for field in ("Icon", "WebPage"):
        require_http_url(required_text(root, field, source), field, source)


def validate_png(path: Path, expected_size: int) -> None:
    with path.open("rb") as image:
        if image.read(8) != b"\x89PNG\r\n\x1a\n":
            fail(f"{path}: expected a PNG image")
        length = struct.unpack(">I", image.read(4))[0]
        if image.read(4) != b"IHDR" or length < 8:
            fail(f"{path}: missing PNG IHDR")
        width, height = struct.unpack(">II", image.read(8))
    if (width, height) != (expected_size, expected_size):
        fail(f"{path}: expected {expected_size}x{expected_size}, got {width}x{height}")


def validate_template(source: Path) -> None:
    root = ET.parse(source).getroot()
    if root.tag != "Container" or root.attrib.get("version") != "2":
        fail(f'{source}: root must be <Container version="2">')
    values = {field: required_text(root, field, source) for field in REQUIRED_TEMPLATE_FIELDS}
    for field in ("Project", "Support", "TemplateURL", "Icon"):
        require_http_url(values[field], field, source)
    if ":" not in values["Repository"]:
        fail(f"{source}: <Repository> must include an image tag")

    names: set[str] = set()
    targets: set[str] = set()
    for config in root.findall("Config"):
        name = (config.attrib.get("Name") or "").strip()
        target = (config.attrib.get("Target") or "").strip()
        if not name or not target:
            fail(f"{source}: every <Config> needs Name and Target attributes")
        if name in names or target in targets:
            fail(f"{source}: duplicate Config name or target: {name} / {target}")
        names.add(name)
        targets.add(target)


def main() -> int:
    try:
        validate_profile()
        templates = sorted((ROOT / "templates").glob("*.xml"))
        if not templates:
            fail("templates/: at least one Docker template XML file is required")
        for template in templates:
            validate_template(template)
        validate_png(ROOT / "icon.png", 512)
    except (ET.ParseError, OSError, ValueError) as error:
        print(f"Unraid metadata validation failed: {error}", file=sys.stderr)
        return 1
    print(f"Validated ca_profile.xml, {len(templates)} Docker template(s), and 512px icon.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
