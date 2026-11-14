#!/usr/bin/env python3
"""End-to-end API checks using an isolated temporary SQLite database."""
import http.cookiejar
import base64
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

SIGNUP_PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=")


def signup_multipart(values, field="selfie"):
    values = dict(values, face_consent="yes") if field == "selfie" else dict(values)
    chunks = []
    for name, value in values.items():
        chunks.append(f'--TestBoundary\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    chunks.append(f'--TestBoundary\r\nContent-Disposition: form-data; name="{field}"; filename="camera-photo.png"\r\nContent-Type: image/png\r\n\r\n'.encode() + SIGNUP_PNG + b'\r\n')
    return b''.join(chunks) + b'--TestBoundary--\r\n'


def main():
    global opener, csrf_token
    csrf_token = ""
    with tempfile.TemporaryDirectory(prefix="smart-police-test-") as root:
        data = str(Path(root) / "data")
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        env = dict(os.environ, SMART_POLICE_DATA=data, SP_ONEDRIVE_ROSTER_SYNC="0")
        server = subprocess.Popen(
            ["php", "-S", f"127.0.0.1:{port}", "-t", "public"],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        base = f"http://127.0.0.1:{port}/api.php"

        def request(path, payload=None, jar=None, raw=None):
            global opener, csrf_token
            if jar is not None:
                opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
            headers = {}
            if path == "a=register" and payload is not None and payload.get("role", "citizen") == "citizen":
                headers["Content-Type"] = "multipart/form-data; boundary=TestBoundary"
                body = signup_multipart(payload)
            elif path == "a=login" and payload is not None:
                headers["Content-Type"] = "multipart/form-data; boundary=TestBoundary"
                body = signup_multipart(payload, "login_capture")
            elif raw is not None:
                headers["Content-Type"] = "multipart/form-data; boundary=TestBoundary"
                body = raw
            elif payload is not None:
                headers["Content-Type"] = "application/json"
                body = json.dumps(payload).encode()
            else:
                body = None
            if payload is not None or raw is not None:
                with opener.open(base + "?a=csrf") as r:
                    csrf_token = json.load(r).get("csrf") or ""
                headers["X-CSRF"] = csrf_token
            req = urllib.request.Request(base + "?" + path, body, headers)
            try:
                with opener.open(req) as r:
                    return r.status, r.headers, r.read()
            except urllib.error.HTTPError as e:
                return e.code, e.headers, e.read()

        def fields(op, values, jar):
            global opener, csrf_token
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
            with opener.open(base + "?a=csrf") as r:
                state = json.load(r)
            csrf_token = state.get("csrf") or ""
            return request("a=" + op, values, jar=jar)

        def assert_pdf(result, phrase):
            status, headers, pdf = result
            assert status == 200 and headers.get_content_type() == "application/pdf", (status, headers)
            assert pdf.startswith(b"%PDF-1.4") and pdf.endswith(b"%%EOF\n"), pdf[:30]
            assert phrase.encode() in pdf, phrase
            return pdf

        try:
            for _ in range(50):
                try:
                    opener = urllib.request.build_opener()
                    with opener.open(base + "?a=csrf", timeout=1):
                        break
                except Exception:
                    time.sleep(.1)
            else:
                raise AssertionError("PHP test server did not start")

            jar_admin = http.cookiejar.CookieJar()
            status, _, _ = request("a=register", {"name": "Early", "username": "early", "password": "pass"}, jar_admin)
            assert status == 409, "Citizen registration must wait for initial admin setup"
            status, _, body = request("a=setup", {"name": "Admin Person", "username": "admin1", "email": "admin@admin.co.za", "password": "Admin#26"}, jar_admin)
            assert status == 200
            csrf_token = json.loads(body)["csrf"]
            assert fields("user_create", {"name": "Officer One", "username": "officer1",
                                           "role": "officer", "password": "Offic#26"}, jar_admin)[0] == 200
            assert fields("logout", {}, jar_admin)[0] == 200

            jar_citizen = http.cookiejar.CookieJar()
            status, _, body = request("a=register", {"name": "Citizen One", "username": "citizen1",
                                                      "password": "Citi#26", "email": "citizen1@gmail.com",
                                                      "residential_address": "1 Test Street, Cape Town",
                                                      "phone": "821234567"}, jar=jar_citizen)
            assert status == 200 and json.loads(body)["approval_status"] == "active"
            assert fields("login", {"username": "citizen1", "password": "Citi#26",
                                     "role": "officer"}, jar_citizen)[0] == 403
            assert fields("login", {"username": "citizen1", "password": "Citi#26",
                                       "role": "citizen"}, jar_citizen)[0] == 200
            assert fields("login", {"username": "admin1", "password": "Admin#26",
                                      "role": "admin"}, jar_admin)[0] == 200
            admin_state = json.loads(fields("state", {}, jar_admin)[2])
            citizen_id = next(user["id"] for user in admin_state["users"] if user["username"] == "citizen1")
            assert fields("user_approval", {"id": citizen_id, "decision": "approve"}, jar_admin)[0] == 409
            assert fields("logout", {}, jar_admin)[0] == 200
            assert fields("login", {"username": "citizen1", "password": "Citi#26",
                                      "role": "citizen"}, jar_citizen)[0] == 200
            status, _, body = fields("report", {"title": "Test incident", "type": "Theft",
                                                 "description": "Isolated API smoke test.",
                                                 "location": "Test location"}, jar_citizen)
            assert status == 200, body
            with opener.open(base + "?a=state") as r:
                case_id = json.load(r)["cases"][0]["id"]
            for filename, content in [("notes.txt", b"Private case document for review."), ("active.html", b"<html><script>parent.document.body.textContent='unsafe';</script></html>")]:
                upload = (b"--TestBoundary\r\nContent-Disposition: form-data; name=\"case_id\"\r\n\r\n"
                          + str(case_id).encode() + b"\r\n--TestBoundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\""
                          + filename.encode() + b"\"\r\nContent-Type: application/octet-stream\r\n\r\n" + content + b"\r\n--TestBoundary--\r\n")
                assert request("a=evidence_upload", raw=upload, jar=jar_citizen)[0] == 200
            raw = (b"--TestBoundary\r\nContent-Disposition: form-data; name=\"case_id\"\r\n\r\n"
                   + str(case_id).encode() + b"\r\n--TestBoundary\r\nContent-Disposition: form-data; "
                   b"name=\"text\"\r\n\r\nThis is an isolated affidavit test statement with enough words.\r\n"
                   b"--TestBoundary--\r\n")
            assert request("a=affidavit_upload", raw=raw, jar=jar_citizen)[0] == 200
            status, _, body = fields("sos", {"lat": -33.9249, "lng": 18.4241}, jar_citizen)
            assert status == 200, body
            sos_id = json.loads(body)["id"]

            jar_officer = http.cookiejar.CookieJar()
            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar_officer))
            assert fields("login", {"username": "officer1", "password": "Offic#26",
                                     "role": "officer"}, jar_officer)[0] == 200
            assert fields("assign", {"case_id": case_id}, jar_officer)[0] == 200
            with opener.open(base + "?a=state") as r:
                case = json.load(r)["cases"][0]
            affidavit_id = case["affidavits"][0]["id"]
            for evidence in case["evidence"]:
                preview_path = f"a=download&t=evidence&id={evidence['id']}&preview=1"
                viewed = request(preview_path, jar=jar_officer)
                assert viewed[0] == (200 if evidence["filename"] == "notes.txt" else 415), viewed
                assert request(preview_path, jar=jar_citizen)[0] == 403
            assert fields("login", {"username":"admin1","password":"Admin#26","role":"admin"}, jar_admin)[0] == 200
            assert fields("user_create", {"name":"Second Officer","username":"officer2","role":"officer","password":"Offic#26"}, jar_admin)[0] == 200
            jar_second = http.cookiejar.CookieJar()
            assert fields("login", {"username":"officer2","password":"Offic#26","role":"officer"}, jar_second)[0] == 200
            assert request(preview_path, jar=jar_second)[0] == 404, "Another Officer must not preview an assigned case"
            preview = request(f"a=download&t=affidavit&id={affidavit_id}&preview=1", jar=jar_officer)
            assert preview[0] == 200 and preview[1]["Content-Type"].startswith("text/plain") and b"isolated affidavit" in preview[2]
            assert request(f"a=download&t=affidavit&id={affidavit_id}&preview=1", jar=jar_citizen)[0] == 403
            assert fields("affidavit_certify", {"id": affidavit_id}, jar_officer)[0] == 200
            assert fields("sos_ack", {"id": sos_id}, jar_officer)[0] == 200

            with opener.open(base + "?a=state") as r:
                staff_state = json.load(r)
            assert staff_state["sos"][0]["status"] == "Responding"
            with opener.open(base + f"?a=download&t=affidavit&id={affidavit_id}") as r:
                stamped = r.read()
            assert stamped.startswith(b"%PDF-1.4")
            preview = request(f"a=download&t=affidavit&id={affidavit_id}&preview=1", jar=jar_officer)
            assert preview[0] == 200 and preview[2] == stamped and preview[1]["Content-Type"] == "application/pdf"

            opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar_citizen))
            assert fields("sos_update", {"id": sos_id, "lat": -33.9251, "lng": 18.4243},
                          jar_citizen)[0] == 200
            assert_pdf(request(f"a=case_pdf&id={case_id}", jar=jar_citizen), "CASE")
            status, _, body = request("a=backup_pdf", jar=jar_citizen)
            assert status == 403, body

            assert_pdf(request("a=backup_pdf", jar=jar_admin), "RECORD BACKUP")
            print("PASS: setup lockout, role-specific login, case/affidavit, live responding SOS, access controls and timestamped PDFs")
        finally:
            server.terminate()
            server.wait(timeout=5)


if __name__ == "__main__":
    main()
