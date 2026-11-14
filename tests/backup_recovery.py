#!/usr/bin/env python3
"""Full encrypted recovery against disposable storage; never opens working data."""
import hashlib
import fcntl
import http.cookiejar
import json
import os
from pathlib import Path
import socket
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request


PASSPHRASE = "isolated recovery passphrase 56789"
SIGNUP_PNG = __import__("base64").b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=")


def multipart(values, files):
    chunks = []
    for name, value in values.items():
        chunks.append(f'--TestBoundary\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for name, filename, mime, content in files:
        chunks.append(f'--TestBoundary\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + content + b'\r\n')
    return b''.join(chunks) + b'--TestBoundary--\r\n'


class Client:
    signup_counter = 0

    def __init__(self, base):
        self.base = base
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, action, values=None, raw=None, token=None, timeout=60):
        if action == "register" and values is not None and values.get("role", "citizen") == "citizen":
            values = dict(values)
            skip_contact_defaults = values.pop("_skip_contact_defaults", False)
            if not skip_contact_defaults:
                Client.signup_counter += 1
                values.setdefault("email", f"citizen{Client.signup_counter}@gmail.com")
                values.setdefault("residential_address", "1 Test Street, Cape Town")
                values.setdefault("phone", "821234567")
            values["face_consent"] = "yes"
            raw = multipart(values, [("selfie", "signup-photo.png", "image/png", SIGNUP_PNG)])
            values = None
        if action == "login" and values is not None:
            raw = multipart(values, [("login_capture", "login.png", "image/png", SIGNUP_PNG)])
            values = None
        headers = {}
        data = None
        if values is not None or raw is not None:
            csrf = self.call("csrf")[2]["csrf"] if token is None else token
            headers["X-CSRF"] = csrf
            if raw is not None:
                headers["Content-Type"] = "multipart/form-data; boundary=TestBoundary"
                data = raw
            else:
                headers["Content-Type"] = "application/json"
                data = json.dumps(values).encode()
        req = urllib.request.Request(self.base + "?a=" + action, data, headers)
        try:
            response = self.opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            body = response.read()
            if response.headers.get_content_type() == "application/json":
                body = json.loads(body)
            return response.status, response.headers, body


def main():
    with tempfile.TemporaryDirectory(prefix="sp-recovery-test-") as root:
        root = Path(root)
        data = root / "data"
        data.mkdir(mode=0o700)
        env = dict(os.environ, SMART_POLICE_DATA=str(data), PHP_CLI_SERVER_WORKERS="4", SP_ONEDRIVE_ROSTER_SYNC="0")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        base = f"http://127.0.0.1:{port}/api.php"
        server = None
        server_log = tempfile.TemporaryFile()

        def start():
            nonlocal server
            server = subprocess.Popen(
                ["php", "-d", "upload_max_filesize=12M", "-d", "post_max_size=14M",
                 "-S", f"127.0.0.1:{port}", "-t", "public"], env=env,
                stdout=subprocess.DEVNULL, stderr=server_log, start_new_session=True)
            for _ in range(50):
                try:
                    if Client(base).call("csrf")[0] == 200:
                        return
                except OSError:
                    time.sleep(.1)
            raise AssertionError("Server failed to start")

        def stop():
            nonlocal server
            if server is not None:
                os.killpg(server.pid, signal.SIGTERM)
                server.wait(timeout=5)
                server = None

        def cli(action, path, password=PASSPHRASE, target=data, replace=True):
            args = ["php", "tools/restore.php", action, str(path)]
            if action == "restore" and replace:
                args.append("--replace-data")
            return subprocess.run(args, input=password.encode(), capture_output=True,
                                  env=dict(env, SMART_POLICE_DATA=str(target)), timeout=60)

        def fingerprint():
            return {str(p.relative_to(data)): hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in data.rglob("*") if p.is_file()}

        try:
            start()
            admin, citizen, officer, anonymous = [Client(base) for _ in range(4)]
            assert admin.call("setup", dict(name="Recovery Admin", username="recoveryadmin", email="recovery@admin.co.za", password="Admin#26"))[0] == 200
            assert admin.call("user_create", dict(name="Recovery Officer", username="recoveryofficer",
                                                 role="officer", password="Offic#26"))[0] == 200
            response = citizen.call("register", dict(name="Recovery Citizen", username="recoverycitizen",
                                                      password="Citi#26"))
            assert response[0] == 200 and response[2]["approval_status"] == "active"
            assert citizen.call("login", dict(username="recoverycitizen", password="Citi#26"))[0] == 200
            users = admin.call("state")[2]["users"]
            citizen_id = next(user["id"] for user in users if user["username"] == "recoverycitizen")
            assert citizen.call("login", dict(username="recoverycitizen", password="Citi#26"))[0] == 200
            assert officer.call("login", dict(username="recoveryofficer", password="Offic#26"))[0] == 200
            # Real API requests respect the operator/backup exclusive lock.
            with open(str(data) + ".lock", "r+b") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                release = threading.Timer(.5, lambda: fcntl.flock(lock, fcntl.LOCK_UN))
                release.start()
                before = time.monotonic()
                assert citizen.call("state")[0] == 200
                assert time.monotonic() - before >= .4, "API bypassed exclusive storage lock"
                release.join()
            assert citizen.call("report", dict(title="Recovery case", type="Theft",
                                               description="Complete recovery fixture", location="Test only"))[0] == 200
            case_id = citizen.call("state")[2]["cases"][0]["id"]
            evidence = bytes(range(256)) * 20000  # exceeds a stalled socket's send buffer
            raw = (b'--TestBoundary\r\nContent-Disposition: form-data; name="case_id"\r\n\r\n'
                   + str(case_id).encode() + b'\r\n--TestBoundary\r\nContent-Disposition: form-data; '
                   b'name="file"; filename="proof.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'
                   + evidence + b'\r\n--TestBoundary--\r\n')
            assert citizen.call("evidence_upload", raw=raw)[0] == 200
            statement = "This is the full original sworn statement for the recovery test."
            raw = (b'--TestBoundary\r\nContent-Disposition: form-data; name="case_id"\r\n\r\n'
                   + str(case_id).encode() + b'\r\n--TestBoundary\r\nContent-Disposition: form-data; '
                   b'name="text"\r\n\r\n' + statement.encode() + b'\r\n--TestBoundary--\r\n')
            assert citizen.call("affidavit_upload", raw=raw)[0] == 200
            assert officer.call("assign", dict(case_id=case_id))[0] == 200
            case = officer.call("state")[2]["cases"][0]
            affidavit_id = case["affidavits"][0]["id"]
            evidence_id = case["evidence"][0]["id"]
            assert officer.call("affidavit_certify", dict(id=affidavit_id))[0] == 200
            stamped = officer.call(f"download&t=affidavit&id={affidavit_id}")[2]
            assert stamped.startswith(b"%PDF")
            assert citizen.call("sos", dict(lat=-33.9, lng=18.4))[0] == 200
            assert admin.call("backup_pdf")[0] == 200
            assert citizen.call(f"case_pdf&id={case_id}")[0] == 200
            payload = dict(passphrase=PASSPHRASE, confirm=PASSPHRASE, password="Admin#26")
            assert anonymous.call("backup_archive", payload)[0] == 401
            assert citizen.call("backup_archive", payload)[0] == 403
            assert officer.call("backup_archive", payload)[0] == 403
            assert admin.call("backup_archive")[0] == 405
            assert admin.call("backup_archive", payload, token="bad-token")[0] == 403
            assert admin.call("backup_archive", dict(payload, passphrase="short", confirm="short"))[0] == 400
            assert admin.call("backup_archive", dict(payload, confirm="not matching"))[0] == 400
            assert admin.call("backup_archive", dict(payload, passphrase=PASSPHRASE + "\n", confirm=PASSPHRASE + "\n"))[0] == 400
            assert admin.call("backup_archive", dict(payload, password="wrong"))[0] == 403
            # Incomplete storage must never produce a successful archive.
            vault_file = next((data / "vault").glob("*.enc"))
            hidden = root / "held.enc"
            vault_file.rename(hidden)
            assert admin.call("backup_archive", payload)[0] == 500
            hidden.rename(vault_file)
            assert not list(root.glob("data.recovery-*")), "failed creation leaked staging"
            # Interrupted-process workspaces expire; rollback copies are never auto-deleted.
            stale = root / ("data.recovery-" + "a" * 24)
            stale.mkdir(mode=0o700)
            (stale / "sensitive.tmp").write_text("test-only interrupted snapshot")
            os.utime(stale, (time.time() - 90000, time.time() - 90000))
            status, headers, archive = admin.call("backup_archive", payload)
            assert status == 200, archive
            assert headers.get("Cache-Control") == "no-store"
            assert headers.get_content_type() == "application/octet-stream"
            assert archive.startswith(b"SPBK\x01\r\n")
            assert statement.encode() not in archive and b"SQLite format" not in archive
            saved = root / "backup.spbk"
            saved.write_bytes(archive)
            assert not list(root.glob("data.recovery-*")), "successful creation leaked staging"
            old_epoch = (data / "session.epoch").read_bytes()
            master_key = (data / "master.key").read_bytes()
            vault = {p.name: p.read_bytes() for p in (data / "vault").iterdir()}
            with sqlite3.connect(data / "police.db") as db:
                expected = {t: db.execute(f"SELECT * FROM {t}").fetchall() for t in
                            ["users", "cases", "case_events", "evidence", "affidavits", "sos", "pdf_exports"]}
            # A slow reader must not monopolize case storage. Use a real multi-
            # worker HTTP server and stop reading a >5 MB encrypted response.
            token = admin.call("csrf")[2]["csrf"]
            cookie_request = urllib.request.Request(base)
            admin.jar.add_cookie_header(cookie_request)
            body = json.dumps(payload).encode()
            slow = socket.socket()
            slow.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
            slow.settimeout(20)
            slow.connect(("127.0.0.1", port))
            try:
                slow.sendall((f"POST /api.php?a=backup_archive HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                              f"Cookie: {cookie_request.get_header('Cookie')}\r\nX-CSRF: {token}\r\n"
                              f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n"
                              "Connection: close\r\n\r\n").encode() + body)
                response_headers = b""
                while not response_headers.endswith(b"\r\n\r\n"):
                    response_headers += slow.recv(1)
                    assert len(response_headers) < 16384
                assert b"200 OK" in response_headers, response_headers
                assert list(root.glob("data.recovery-*")), "download was not stalled in its workspace"
                before = time.monotonic()
                assert officer.call("sos_resolve", dict(id=1), timeout=3)[0] == 200
                status, _, new_sos = citizen.call("sos", dict(lat=-33.9, lng=18.4), timeout=3)
                assert status == 200 and new_sos["id"] != 1, "new SOS could not be created"
                assert citizen.call("sos_update", dict(id=new_sos["id"], lat=-33.91, lng=18.41), timeout=3)[0] == 200
                assert admin.call("state", timeout=3)[0] == 200, "stream retained the admin session lock"
                assert time.monotonic() - before < 3
            finally:
                # RST interrupts the transfer rather than allowing a buffered
                # graceful close to keep it alive; the endpoint must still clean up.
                import struct
                slow.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
                slow.close()
            for _ in range(50):
                if not list(root.glob("data.recovery-*")):
                    break
                time.sleep(.1)
            assert not list(root.glob("data.recovery-*")), "interrupted download leaked staging"
            assert citizen.call("sos_update", dict(id=new_sos["id"], lat=-33.9, lng=18.4), timeout=3)[0] == 200
            stop()
            frozen = fingerprint()
            verified = cli("verify", saved)
            assert verified.returncode == 0, verified.stderr
            assert fingerprint() == frozen, "verify altered working data"
            # Archives predating staff approvals still verify and restore, then migrate on first use.
            legacy = root / "legacy.spbk"
            fixture = subprocess.run(["php", "tests/backup_fixture.php", str(saved), str(legacy), "legacy-schema"],
                                     input=PASSPHRASE.encode(), capture_output=True, timeout=30)
            assert fixture.returncode == 0, fixture.stdout + fixture.stderr
            legacy_verify = cli("verify", legacy)
            assert legacy_verify.returncode == 0, legacy_verify.stdout + legacy_verify.stderr
            legacy_data = root / "legacy-data"
            assert cli("restore", legacy, target=legacy_data).returncode == 0
            migration = subprocess.run(["php", "-r", "require 'src/lib.php'; db();"], capture_output=True,
                                      env=dict(env, SMART_POLICE_DATA=str(legacy_data)), timeout=10)
            assert migration.returncode == 0, migration.stderr
            with sqlite3.connect(legacy_data / "police.db") as db:
                assert db.execute("SELECT COUNT(*) FROM users WHERE approval_status='active'").fetchone()[0] == 3
                columns = {row[1] for row in db.execute("PRAGMA table_info(users)")}
                assert {"email", "residential_address", "phone"} <= columns
            assert fingerprint() == frozen, "legacy archive migration altered working data"
            # Wrong password, tampering, truncation, and appended bytes cannot replace data.
            result = cli("restore", saved, password="wrong but long passphrase")
            assert result.returncode != 0
            assert cli("restore", saved, replace=False).returncode == 2
            damaged = bytearray(archive)
            damaged[len(damaged) // 2] ^= 0x80
            for name, content in [("tamper", damaged), ("truncated", archive[:-21]),
                                  ("trailing", archive + b"extra")]:
                bad = root / f"{name}.spbk"
                bad.write_bytes(content)
                result = cli("restore", bad)
                assert result.returncode != 0, name
                assert fingerprint() == frozen, name + " changed working data"
            for mode in ["traversal", "duplicate", "checksum", "missing-key", "missing-evidence",
                         "wrong-key", "bad-db", "nonempty-final"]:
                bad = root / f"{mode}.spbk"
                fixture = subprocess.run(["php", "tests/backup_fixture.php", str(saved), str(bad), mode],
                                         input=PASSPHRASE.encode(), capture_output=True, timeout=30)
                assert fixture.returncode == 0, fixture.stderr
                result = cli("restore", bad)
                assert result.returncode != 0, mode
                assert fingerprint() == frozen, mode + " changed working data"
                assert not (root / "escape").exists()
            assert not list(root.glob("data.recovery-*")), "rejections leaked staging"
            assert not list(root.glob("data.rollback-*")), "rejections renamed live data"
            # Clean installation is independent of the original master key or sessions.
            clean = root / "clean"
            result = cli("restore", saved, target=clean)
            assert result.returncode == 0, result.stderr
            assert (clean / "master.key").read_bytes() == master_key
            # Introduce post-snapshot data, then prove full replacement and rollback preservation.
            with sqlite3.connect(data / "police.db") as db:
                db.execute("UPDATE cases SET title='AFTER SNAPSHOT'")
            result = cli("restore", saved)
            assert result.returncode == 0, result.stderr
            rollback = next(root.glob("data.rollback-*"))
            with sqlite3.connect(rollback / "police.db") as db:
                assert db.execute("SELECT title FROM cases").fetchone()[0] == "AFTER SNAPSHOT"
            assert (data / "session.epoch").read_bytes() != old_epoch
            assert (data / "master.key").read_bytes() == master_key
            assert {p.name: p.read_bytes() for p in (data / "vault").iterdir()} == vault
            with sqlite3.connect(data / "police.db") as db:
                for table, rows in expected.items():
                    assert db.execute(f"SELECT * FROM {table}").fetchall() == rows, table
                assert db.execute("SELECT COUNT(*) FROM admin_lock").fetchone()[0] == 0
                assert db.execute("SELECT COUNT(*) FROM audit WHERE action='backup.restore'").fetchone()[0] == 1
            assert (data.stat().st_mode & 0o777) == 0o700
            assert ((data / "master.key").stat().st_mode & 0o777) == 0o600
            start()
            assert admin.call("state")[0] == 401, "old admin session survived recovery"
            assert citizen.call("state")[0] == 401, "old citizen session survived recovery"
            assert officer.call("state")[0] == 401, "old officer session survived recovery"
            assert citizen.call("login", dict(username="recoverycitizen", password="Citi#26"))[0] == 200
            assert citizen.call(f"download&t=evidence&id={evidence_id}")[2] == evidence
            assert citizen.call(f"download&t=affidavit&id={affidavit_id}")[2] == stamped
            assert admin.call("login", dict(username="recoveryadmin", password="Admin#26"))[0] == 200
            state = admin.call("state")[2]
            assert state["cases"][0]["title"] == "Recovery case"
            assert any(row["action"] == "backup.restore" for row in state["audit"])
            print("PASS: admin encrypted backup; access/CSRF/password checks; complete restored records and vault; "
                  "12 failure cases preserve working data; clean-install restore; rollback and session invalidation; "
                  "stalled/interrupted downloads preserve SOS and admin availability")
        finally:
            stop()
            if sys.exc_info()[0] is not None:
                server_log.seek(0)
                print(server_log.read().decode(), file=sys.stderr)
            server_log.close()


if __name__ == "__main__":
    main()
