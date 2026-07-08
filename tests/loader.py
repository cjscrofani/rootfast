"""Load ETL scripts by file path for unit testing.

The ETL scripts live under sources/*/etl/scripts/ and aren't packaged, so we
import them directly from their paths. All the modules under test import only
the standard library at module scope, so importing them has no side effects
(their filesystem work lives inside main()).
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent


def load(rel_path: str):
    """Import a module from a repo-relative path with a unique module name."""
    path = REPO_ROOT / rel_path
    name = "etl_" + rel_path.replace("/", "_").replace(".py", "").replace("-", "_")
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader, f"could not load {path}"
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module
