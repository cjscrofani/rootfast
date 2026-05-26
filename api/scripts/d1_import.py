"""Push a SQL file to Cloudflare D1 via the same import API wrangler uses,
but use system curl for the R2 PUT (Node 25's fetch + large stream uploads
is broken).

Usage:
    /usr/bin/python3 api/scripts/d1_import.py <path/to/data.sql>

Reads the OAuth token from ~/Library/Preferences/.wrangler/config/default.toml
and the database id from api/wrangler.toml.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API_ROOT = Path(__file__).resolve().parent.parent
WRANGLER_TOML = API_ROOT / "wrangler.toml"
WRANGLER_AUTH = Path.home() / "Library/Preferences/.wrangler/config/default.toml"
ACCOUNT_ID = "e38f0657c24eb89e672015c02cfa8df8"
CF_API = "https://api.cloudflare.com/client/v4"


def get_token() -> str:
    txt = WRANGLER_AUTH.read_text()
    m = re.search(r'oauth_token\s*=\s*"([^"]+)"', txt)
    if not m:
        sys.exit("oauth_token not found in wrangler config")
    return m.group(1)


def get_db_id() -> str:
    txt = WRANGLER_TOML.read_text()
    m = re.search(r'database_id\s*=\s*"([^"]+)"', txt)
    if not m:
        sys.exit("database_id not found in wrangler.toml")
    return m.group(1)


def md5_file(path: Path) -> str:
    h = hashlib.md5()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cf_post(path: str, body: dict, token: str) -> dict:
    url = f"{CF_API}{path}"
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        sys.exit(f"CF API {path} failed: {e.code} {body}")


def curl_put(url: str, file_path: Path) -> str:
    """PUT a file to a presigned URL via system curl. Returns the etag header."""
    # -D - dumps headers to stdout so we can capture etag from the response.
    # --upload-file streams the file, fully respects 100-continue, and
    # works around the broken pipe we hit with --data-binary @file.
    proc = subprocess.run(
        [
            "/usr/bin/curl",
            "--silent",
            "--show-error",
            "--fail-with-body",
            "--http1.1",
            "--retry", "3",
            "--retry-all-errors",
            "--max-time", "1800",
            "-H", "Expect:",
            "--upload-file", str(file_path),
            "-D", "-",
            "-o", "/dev/null",
            url,
        ],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0:
        sys.exit(f"curl PUT failed (exit={proc.returncode}): {proc.stderr}\n{proc.stdout}")
    # Parse etag from response headers
    for line in proc.stdout.splitlines():
        if line.lower().startswith("etag:"):
            return line.split(":", 1)[1].strip().strip('"')
    sys.exit(f"No etag in PUT response headers:\n{proc.stdout}")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("Usage: d1_import.py <path/to/file.sql>")
    file_path = Path(sys.argv[1]).resolve()
    if not file_path.exists():
        sys.exit(f"File not found: {file_path}")

    token = get_token()
    db_id = get_db_id()
    size_mb = file_path.stat().st_size / (1024 * 1024)
    print(f"Importing {file_path.name} ({size_mb:.1f} MB) into D1 {db_id}")

    print("  computing md5…", flush=True)
    etag = md5_file(file_path)
    print(f"  md5={etag}")

    base = f"/accounts/{ACCOUNT_ID}/d1/database/{db_id}"

    # 1. Init: ask D1 for a presigned upload URL
    print("  → POST init", flush=True)
    init = cf_post(f"{base}/import", {"action": "init", "etag": etag}, token)
    result = init["result"]
    if "upload_url" in result:
        upload_url = result["upload_url"]
        filename = result["filename"]
        print(f"  upload_url received, filename={filename}")

        # 2. PUT via curl
        print("  → PUT (via curl)…", flush=True)
        t0 = time.time()
        put_etag = curl_put(upload_url, file_path)
        print(f"  PUT done in {time.time()-t0:.1f}s, etag={put_etag}")

        # 3. Ingest
        print("  → POST ingest", flush=True)
        first = cf_post(
            f"{base}/import",
            {"action": "ingest", "filename": filename, "etag": etag},
            token,
        )
        response = first["result"]
    else:
        # Already uploaded - the init response itself is the first poll response
        print("  file already on D1 side, jumping to poll")
        response = result

    # 4. Poll until complete
    poll_n = 0
    while True:
        for line in (response.get("messages") or []):
            print(f"  🌀 {line}", flush=True)
        status = response.get("status")
        print(f"  [poll {poll_n}] status={status!r} at_bookmark={response.get('at_bookmark')!r}", flush=True)
        if status == "complete":
            print("  ✓ ingest complete", flush=True)
            meta = response.get("meta", {})
            print(f"  rows read={meta.get('rows_read')} written={meta.get('rows_written')} duration={meta.get('duration')}ms", flush=True)
            break
        if status == "error":
            sys.exit(f"  ✗ ingest errored: {response.get('errors')}")
        bookmark = response.get("at_bookmark") or ""
        time.sleep(3)
        poll = cf_post(
            f"{base}/import",
            {"action": "poll", "current_bookmark": bookmark},
            token,
        )
        if poll_n < 2:
            print(f"  [raw poll response] {json.dumps(poll)[:500]}", flush=True)
        response = poll.get("result") or poll
        if not isinstance(response, dict):
            print(f"  ✗ unexpected response shape: {poll}", flush=True)
            break
        poll_n += 1


if __name__ == "__main__":
    main()
