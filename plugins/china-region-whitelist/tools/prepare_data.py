#!/usr/bin/env python3
"""Prepare local province CIDR data for the china-region-whitelist script."""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import shutil
import time
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INDEX = ROOT / "data" / "cncity.md"
DEFAULT_INDEX_URL = "https://raw.githubusercontent.com/metowolf/iplist/master/docs/cncity.md"
DEFAULT_DATA_BASE_URL = "https://raw.githubusercontent.com/metowolf/iplist/master/data/cncity"
DEFAULT_COUNTRY_URL = "https://ftp.apnic.net/stats/apnic/delegated-apnic-latest"
COUNTRY_FILE = "country/CN.txt"

ROW_RE = re.compile(r"^\|([^|]+)\|([^|]+)\|$")
CODE_RE = re.compile(r"/(\d{6})\.txt$")
EXCLUDED_PROVINCE_CODES = {"710000", "810000", "820000"}


def parse_cncity(markdown: str) -> list[dict[str, object]]:
    provinces: list[dict[str, object]] = []
    current: dict[str, object] | None = None

    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        if not line or line == "|---|---|":
            continue

        match = ROW_RE.match(line)
        if not match:
            continue

        name, url = match.group(1).strip(), match.group(2).strip()
        code_match = CODE_RE.search(url)
        if not code_match:
            continue

        code = code_match.group(1)
        entry = {"name": name, "code": code, "file": f"regions/{code}.txt", "url": url}

        if code.endswith("0000"):
            if code == "100000" or code in EXCLUDED_PROVINCE_CODES:
                current = None
                continue
            current = entry
            provinces.append(current)

    return provinces


def download_text(url: str) -> str:
    last_error: Exception | None = None
    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(url, timeout=30) as response:
                return response.read().decode("utf-8")
        except Exception as exc:  # pragma: no cover - network failure path
            last_error = exc
            time.sleep(attempt)
    raise RuntimeError(f"failed to download {url}: {last_error}")


def normalize_region_text(text: str) -> str:
    lines = [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]
    return "\n".join(lines) + "\n"


def parse_apnic_country_ipv4(text: str, country_code: str = "CN") -> list[str]:
    networks: list[ipaddress.IPv4Network] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("|")
        if len(parts) < 7:
            continue
        _registry, cc, resource_type, start, value, _date, status = parts[:7]
        if cc != country_code or resource_type != "ipv4" or status not in {"allocated", "assigned"}:
            continue
        start_ip = ipaddress.IPv4Address(start)
        count = int(value)
        end_ip = ipaddress.IPv4Address(int(start_ip) + count - 1)
        networks.extend(ipaddress.summarize_address_range(start_ip, end_ip))
    return [str(network) for network in ipaddress.collapse_addresses(networks)]


def region_url(code: str, original_url: str, data_base_url: str) -> str:
    if data_base_url:
        return f"{data_base_url.rstrip('/')}/{code}.txt"
    return original_url


def write_region_file(code: str, url: str, regions_dir: Path, force: bool, data_base_url: str) -> None:
    regions_dir.mkdir(parents=True, exist_ok=True)
    target = regions_dir / f"{code}.txt"
    if target.exists() and target.stat().st_size > 0 and not force:
        return
    text = download_text(region_url(code, url, data_base_url))
    target.write_text(normalize_region_text(text), encoding="utf-8")


def write_country_file(data_dir: Path, force: bool, country_url: str) -> None:
    target = data_dir / COUNTRY_FILE
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists() and target.stat().st_size > 0 and not force:
        return
    country_cidrs = parse_apnic_country_ipv4(download_text(country_url))
    if not country_cidrs:
        raise RuntimeError(f"no CN IPv4 CIDRs parsed from {country_url}")
    target.write_text("\n".join(country_cidrs) + "\n", encoding="utf-8")


def iter_entries(provinces: list[dict[str, object]]):
    for province in provinces:
        yield province


def write_regions_tsv(provinces: list[dict[str, object]], target: Path) -> None:
    lines: list[str] = []
    for province_index, province in enumerate(provinces, 1):
        province_code = str(province["code"])
        province_name = str(province["name"])
        lines.append(
            "\t".join(
                [
                    "province",
                    str(province_index),
                    "0",
                    province_code,
                    province_name,
                    province_code,
                    province_name,
                    str(province["file"]),
                ]
            )
        )
    target.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX, help="Local cncity.md path")
    parser.add_argument("--index-url", default=DEFAULT_INDEX_URL, help="Remote cncity.md URL")
    parser.add_argument(
        "--data-base-url",
        default=DEFAULT_DATA_BASE_URL,
        help="Base URL for cncity CIDR files; use an empty value to keep URLs from the index",
    )
    parser.add_argument(
        "--country-url",
        default=DEFAULT_COUNTRY_URL,
        help="APNIC delegated stats URL used to generate data/country/CN.txt",
    )
    parser.add_argument("--output-dir", type=Path, default=ROOT, help="Project-style output directory")
    parser.add_argument("--refresh-index", action="store_true", help="Download the latest cncity index first")
    parser.add_argument("--force", action="store_true", help="Overwrite existing region files")
    parser.add_argument("--ipdb", type=Path, help="Optional local ipipfree.ipdb path to bundle")
    parser.add_argument("--skip-download", action="store_true", help="Only generate regions.json")
    args = parser.parse_args()

    output_dir = args.output_dir
    data_dir = output_dir / "data"
    regions_dir = data_dir / "regions"
    regions_json = data_dir / "regions.json"
    regions_tsv = data_dir / "regions.tsv"
    vendor_dir = output_dir / "vendor"

    if args.refresh_index:
        data_dir.mkdir(parents=True, exist_ok=True)
        markdown = download_text(args.index_url)
        (data_dir / "cncity.md").write_text(markdown, encoding="utf-8")
    else:
        markdown = args.index.read_text(encoding="utf-8")

    provinces = parse_cncity(markdown)
    if not provinces:
        raise SystemExit("No provinces parsed from cncity index")

    if not args.skip_download:
        print("[country] CN 中国")
        write_country_file(data_dir, args.force, args.country_url)
        entries = list(iter_entries(provinces))
        for index, entry in enumerate(entries, 1):
            print(f"[{index}/{len(entries)}] {entry['code']} {entry['name']}")
            write_region_file(
                str(entry["code"]),
                str(entry["url"]),
                regions_dir,
                args.force,
                args.data_base_url,
            )

    metadata = {
        "source": "https://github.com/metowolf/iplist/blob/master/docs/cncity.md",
        "index_url": args.index_url,
        "data_base_url": args.data_base_url,
        "country_url": args.country_url,
        "generated_by": "tools/prepare_data.py",
        "country": {
            "name": "中国",
            "code": "CN",
            "file": COUNTRY_FILE,
            "url": args.country_url,
        },
        "provinces": provinces,
    }
    data_dir.mkdir(parents=True, exist_ok=True)
    regions_json.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    write_regions_tsv(provinces, regions_tsv)

    if args.ipdb:
        if not args.ipdb.exists():
            raise SystemExit(f"ipdb file not found: {args.ipdb}")
        vendor_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy2(args.ipdb, vendor_dir / "ipipfree.ipdb")

    print(f"Wrote {regions_json}")
    print(f"Wrote {regions_tsv}")
    print(f"Province count: {len(provinces)}")
    print(f"Indexed region files: {sum(1 for _ in iter_entries(provinces))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
