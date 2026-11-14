#!/usr/bin/env python3
"""Check publishing exclusions and boot an isolated prebuilt package."""
import fnmatch
from pathlib import Path
import os
import shutil
import socket
import subprocess
import tempfile
import time
import tomllib
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
patterns = [
    line.strip() for line in (ROOT / ".replitignore").read_text().splitlines()
    if line.strip() and not line.lstrip().startswith("#")
]


def excluded(path):
    # The project uses simple exclusions, no negated patterns.
    for pattern in patterns:
        rooted = pattern.startswith("/")
        pattern = pattern.strip("/")
        candidates = [path, *[str(p) for p in Path(path).parents if str(p) != "."]]
        if not rooted:
            candidates += path.split("/")
        if any(fnmatch.fnmatchcase(candidate, pattern) for candidate in candidates):
            return True
    return False


def main():
    config = tomllib.loads((ROOT / ".replit").read_text())["deployment"]
    assert config["build"] == ["sh", "scripts/build-deployment.sh"]
    assert config["run"] == ["sh", "./start.sh", "5000", "--prebuilt"]
    for path in ["node_modules/echarts/package.json", "node_modules/exceljs/package.json",
                 "node_modules/pdfjs-dist/build/pdf.mjs", "vendor/autoload.php"]:
        assert not excluded(path), f"Publishing excludes required dependency: {path}"
    for path in ["data/police.db", "data/master.key", "data/vault/private.enc",
                 "data.backup", "backup.spbk", "generated-artifacts/test.jpg"]:
        assert excluded(path), f"Publishing must exclude private/generated file: {path}"

    with tempfile.TemporaryDirectory(prefix="smartpolice-package-") as directory:
        package = Path(directory)

        def ignore(parent, names):
            relative = Path(parent).relative_to(ROOT)
            return [name for name in names if excluded((relative / name).as_posix())]

        # Copy only application files and built dependencies, never working data.
        for name in ["src", "public", "scripts", "bin", "node_modules", "vendor"]:
            shutil.copytree(ROOT / name, package / name, ignore=ignore)
        for name in ["start.sh", "schema.sql", "package.json", "package-lock.json"]:
            shutil.copy2(ROOT / name, package / name)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        env = dict(os.environ, SMART_POLICE_DATA=str(package / "isolated-data"),
                   SP_ONEDRIVE_ROSTER_SYNC="0")
        with (package / "startup.log").open("w+") as log:
            process = subprocess.Popen(["sh", "./start.sh", str(port), "--prebuilt"],
                                       cwd=package, env=env, stdout=log, stderr=log)
            try:
                for _ in range(80):
                    assert process.poll() is None, "Prebuilt startup exited early"
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=2) as response:
                            assert response.status == 200
                        break
                    except OSError:
                        time.sleep(.1)
                else:
                    raise AssertionError("Homepage readiness check timed out")
                for route in ["/api.php?a=csrf", "/chart-runtime.php"]:
                    with urllib.request.urlopen(f"http://127.0.0.1:{port}{route}", timeout=10) as response:
                        assert response.status == 200, route
            finally:
                process.terminate()
                process.wait(timeout=10)
                log.seek(0)
                print(log.read()[-1500:])
    print("PASS: publishing retains dependencies, excludes private data, and prebuilt startup returns HTTP 200")


if __name__ == "__main__":
    main()
