#!/usr/bin/env python3
"""Citizen service lifecycle, privacy, file validation and recovery on disposable data."""
import base64
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
from zoneinfo import ZoneInfo

from backup_recovery import Client, PASSPHRASE

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=")


def pdf_text(content):
    return subprocess.check_output(["pdftotext", "-layout", "-", "-"], input=content).decode()


def multipart(values, files):
    chunks = []
    for name, value in values.items():
        chunks.append(f'--TestBoundary\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    for name, filename, mime, content in files:
        chunks.append(f'--TestBoundary\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\nContent-Type: {mime}\r\n\r\n'.encode() + content + b'\r\n')
    return b''.join(chunks) + b'--TestBoundary--\r\n'


def main():
    with tempfile.TemporaryDirectory(prefix="sp-services-") as temp:
        root = Path(temp)
        data = root / "data"
        env = dict(os.environ, SMART_POLICE_DATA=str(data), SP_ONEDRIVE_ROSTER_SYNC="0")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        log = tempfile.TemporaryFile()
        server = subprocess.Popen(["php", "-d", "upload_max_filesize=12M", "-d", "post_max_size=44M",
                                   "-S", f"127.0.0.1:{port}", "-t", "public"],
                                  env=env, stdout=subprocess.DEVNULL, stderr=log, start_new_session=True)
        try:
            url = f"http://127.0.0.1:{port}/api.php"
            admin, citizen, other, officer, second, anonymous = [Client(url) for _ in range(6)]
            for _ in range(50):
                try:
                    if anonymous.call("csrf")[0] == 200:
                        break
                except OSError:
                    time.sleep(.1)
            assert admin.call("setup", dict(name="Service Admin", username="serviceadmin", email="services@admin.co.za", password="Admin#26"))[0] == 200
            signup_fields = dict(name="Missing Camera", username="missingcamera", role="citizen", password="Citi#26",
                                 email="missingcamera@gmail.com", residential_address="1 Test Street, Cape Town",
                                 phone="821234567", face_consent="yes")
            assert anonymous.call("register", raw=multipart(signup_fields, []))[0] == 400, "Citizen signup must require an attached camera capture"
            no_photo_consent = dict(signup_fields)
            no_photo_consent.pop("face_consent")
            assert anonymous.call("register", raw=multipart(no_photo_consent, [("selfie", "signup.png", "image/png", PNG)]))[0] == 400
            for name, client in [("firstofficer", officer), ("secondofficer", second)]:
                assert admin.call("user_create", dict(name=name, username=name, role="officer", password="Offic#26"))[0] == 200
                assert client.call("login", dict(username=name, password="Offic#26", role="officer"))[0] == 200
            for name, client in [("requestcitizen", citizen), ("othercitizen", other)]:
                assert client.call("register", dict(name=name, username=name, password="Citi#26"))[0] == 200
                assert client.call("login", dict(username=name, password="Citi#26", role="citizen"))[0] == 200
            admin_users = admin.call("state")[2]["users"]
            login_fields = {"username":"requestcitizen","password":"Citi#26","role":"citizen"}
            assert anonymous.call("login", raw=multipart(login_fields, []))[0] == 400, "Citizen login requires a camera image on the server"
            assert anonymous.call("login", raw=multipart(login_fields, [("login_capture","fake.png","image/png",b"not an image")]))[0] == 400
            assert anonymous.call("phone_otp_send", {})[0] == 401
            assert officer.call("phone_otp_send", {})[0] == 403
            assert citizen.call("phone_otp_send", {}, token="invalid")[0] == 403
            sent = citizen.call("phone_otp_send", {})
            assert sent[0] == 200 and sent[2]["message"] == "Code sent" and sent[2]["demo"] is True
            assert citizen.call("phone_otp_send", {})[0] == 429
            assert other.call("phone_otp_verify", {"code":sent[2]["demo_code"]})[0] == 400
            assert citizen.call("phone_otp_verify", {"code":"wrong"})[0] == 400
            assert citizen.call("phone_otp_verify", {"code":sent[2]["demo_code"]})[0] == 200
            assert citizen.call("phone_otp_verify", {"code":sent[2]["demo_code"]})[0] == 400
            assert not citizen.call("state")[2]["me"]["two_step_enabled"], "Demo must not change real two-step security"
            citizen_account = next(user for user in admin_users if user["username"] == "requestcitizen")
            assert citizen_account["face_photo_available"] == 1
            citizen_photo = admin.call(f"user_face_preview&id={citizen_account['id']}&preview=1")
            assert citizen_photo[0] == 200 and citizen_photo[2] == PNG
            assert citizen_photo[1]["Content-Type"] == "image/png" and "no-store" in citizen_photo[1]["Cache-Control"]
            assert citizen.call(f"user_face_preview&id={citizen_account['id']}&preview=1")[0] == 403
            assert officer.call(f"user_face_preview&id={citizen_account['id']}&preview=1")[0] == 403
            with sqlite3.connect(data / "police.db") as db:
                encrypted_photo = db.execute("SELECT face_vault FROM users WHERE id=?", (citizen_account["id"],)).fetchone()[0]
            assert encrypted_photo and (data / "vault" / encrypted_photo).read_bytes() != PNG
            denied_update = citizen.call("face_photo_update", raw=multipart({}, [("selfie","new-photo.png","image/png",PNG)]))
            assert denied_update[0] == 400, "Updating a Citizen photo requires explicit consent"
            update_fields = {"face_consent":"yes"}
            assert citizen.call("face_photo_update", raw=multipart(update_fields,[("selfie","new-photo.png","image/png",PNG)]))[0] == 200
            with sqlite3.connect(data / "police.db") as db:
                updated_photo = db.execute("SELECT face_vault FROM users WHERE id=?", (citizen_account["id"],)).fetchone()[0]
            assert updated_photo and updated_photo != encrypted_photo and not (data / "vault" / encrypted_photo).exists()
            assert admin.call(f"user_face_preview&id={citizen_account['id']}&preview=1")[2] == PNG
            fields = dict(kind="affidavit", id_number="TEST-ID-001", race="Self-described test entry",
                          reason="I need a statement record for a lost item.",
                          statement="This is an isolated test statement of more than twenty characters.", consent="yes")
            files = [("id_proof", "identity.png", "image/png", PNG), ("selfie", "selfie.png", "image/png", PNG)]
            signup_vaults = {path.name for path in (data / "vault").glob("*.enc")}

            def submit(client=citizen, values=None, uploads=None, token=None):
                return client.call("request_create", raw=multipart(fields if values is None else values, files if uploads is None else uploads), token=token)

            assert submit(anonymous)[0] == 401
            assert submit(officer)[0] == 403
            assert submit(token="invalid")[0] == 403
            for changes in [dict(consent=""), dict(kind="bad"), dict(id_number="<script>"),
                            dict(reason="short"), dict(statement="short"), dict(race="x" * 81)]:
                assert submit(values=dict(fields, **changes))[0] == 400, changes
            assert submit(uploads=files[:1])[0] == 400
            assert submit(uploads=[files[0], ("selfie", "selfie.png", "image/png", b"not an image")])[0] == 400
            assert submit(uploads=[files[0], ("selfie", "selfie.php", "image/png", PNG)])[0] == 400
            assert submit(uploads=[files[0], ("selfie", "selfie.png", "image/png", PNG + b"x" * (10 * 1024 * 1024))])[0] == 400
            assert citizen.call("state")[2]["citizenStats"]["service_requests"] == 0
            assert {path.name for path in (data / "vault").glob("*.enc")} == signup_vaults, "Rejected submissions must not leave sensitive orphan files"
            fields["statement"] += "\n" + "\n".join(f"Statement paragraph {i}: all affidavit details must appear in the full downloaded report." for i in range(80)) + "\nEND OF FULL AFFIDAVIT STATEMENT"
            result = submit()
            assert result[0] == 200, result
            affidavit_id = result[2]["id"]
            request = citizen.call("state")[2]["requests"][0]
            assert request["details"] == {k: fields[k] for k in ["id_number", "race", "reason", "statement"]}
            assert len(request["files"]) == 2 and request["has_receipt"] and not request["has_result"]
            assert all("vault" not in key for key in request), "Vault paths must not leak"
            own_file = request["files"][0]["id"]
            receipt = citizen.call(f"request_download&id={affidavit_id}&pdf=receipt")
            assert receipt[0] == 200 and receipt[2].startswith(b"%PDF-")
            receipt_hash = hashlib.sha256(receipt[2]).hexdigest()
            assert b"Pending review" in receipt[2] and b"TEST-ID-001" in receipt[2]
            assert citizen.call(f"request_download&id={affidavit_id}&pdf=result")[0] == 404
            assert other.call(f"request_download&id={affidavit_id}&file_id={own_file}")[0] == 404
            assert other.call("state")[2]["requests"] == []
            queued = officer.call("state")[2]["requests"][0]
            assert "details" not in queued and queued["files"] == [] and not queued["has_receipt"] and "citizen_face_available" not in queued
            assert "TEST-ID-001" not in json.dumps(queued)
            assert officer.call(f"request_download&id={affidavit_id}&file_id={own_file}")[0] == 404
            preview_url = f"request_download&id={affidavit_id}&file_id={own_file}&preview=1"
            assert anonymous.call(preview_url)[0] == 401
            assert citizen.call(preview_url)[0] == 403
            assert officer.call(preview_url)[0] == 404
            assert admin.call(preview_url)[0] == 200
            assert citizen.call("request_claim", dict(id=affidavit_id))[0] == 403
            assert admin.call("request_claim", dict(id=affidavit_id))[0] == 403
            assert officer.call("request_claim", dict(id=affidavit_id))[0] == 200
            assert second.call("request_claim", dict(id=affidavit_id))[0] == 409
            assert second.call("citizen_flag", dict(request_id=affidavit_id, reason="Suspicious account activity needs review."))[0] == 403, "Only the assigned Officer may flag a request's Citizen"
            assert officer.call("citizen_flag", dict(request_id=affidavit_id, reason="Too short"))[0] == 400
            assert officer.call("citizen_flag", dict(request_id=affidavit_id, reason="Suspicious account activity needs review."))[0] == 200
            assert "review_flag_reason" not in citizen.call("state")[2]["requests"][0], "Citizen must not see internal review-flag notes"
            flagged_user = next(u for u in admin.call("state")[2]["users"] if u["id"] == citizen_account["id"])
            assert flagged_user["review_flag_reason"] == "Suspicious account activity needs review."
            assert flagged_user["review_flagged_by_name"] == "firstofficer"
            assert officer.call("citizen_flag_clear", {"id": citizen_account["id"]})[0] == 403, "Officers cannot clear Admin review flags"
            assert admin.call("citizen_flag_clear", {"id": citizen_account["id"]})[0] == 200
            assert next(u for u in admin.call("state")[2]["users"] if u["id"] == citizen_account["id"])["review_flag_reason"] is None
            assert not second.call("state")[2]["requests"]
            assigned_request = next(r for r in officer.call("state")[2]["requests"] if r["id"] == affidavit_id)
            assert assigned_request["citizen_face_available"] == 1
            assert officer.call(f"request_face_preview&id={affidavit_id}&preview=1")[0:3:2] == (200, PNG)
            assert second.call(f"request_face_preview&id={affidavit_id}&preview=1")[0] == 404
            assert other.call(f"request_face_preview&id={affidavit_id}&preview=1")[0] == 403
            assert officer.call(f"request_download&id={affidavit_id}&file_id={own_file}")[2] == PNG
            preview = officer.call(preview_url)
            assert preview[0] == 200 and preview[2] == PNG
            assert preview[1]["Content-Type"] == "image/png" and preview[1]["Content-Disposition"].startswith("inline;")
            assert "no-store" in preview[1]["Cache-Control"] and preview[1]["X-Content-Type-Options"] == "nosniff"
            assert "sandbox" in preview[1]["Content-Security-Policy"]
            assert second.call(preview_url)[0] == 404
            assert officer.call(f"request_download&id={affidavit_id}&file_id=999999&preview=1")[0] == 404
            review = dict(id=affidavit_id, decision="approve", note="Identity and statement manually reviewed.")
            assert second.call("request_review", review)[0] == 403
            assert admin.call("request_review", review)[0] == 400, "Admin approval also requires explicit review confirmations"
            assert officer.call("request_review", review)[0] == 400
            assert officer.call("request_review", dict(review, identity_checked="yes", documents_checked="yes"))[0] == 200
            assert officer.call("request_review", dict(review, identity_checked="yes", documents_checked="yes"))[0] == 409
            approved = citizen.call(f"request_download&id={affidavit_id}&pdf=result")
            assert approved[0] == 200 and approved[2].startswith(b"%PDF-")
            if os.environ.get("SERVICE_PDF_SNAPSHOT_DIR"):
                snapshot_dir = Path(os.environ["SERVICE_PDF_SNAPSHOT_DIR"])
                snapshot_dir.mkdir(parents=True, exist_ok=True)
                (snapshot_dir / "affidavit-report.pdf").write_bytes(approved[2])
            assert officer.call(f"request_download&id={affidavit_id}&pdf=result&preview=1")[2] == approved[2]
            approved_text = pdf_text(approved[2])
            for text in ["Affidavit Report", "END OF FULL AFFIDAVIT STATEMENT", "Statement paragraph 79:", "DIGITAL APPROVAL STAMP", "Electronic signature: F firstofficer", "(officer)", "SHA-256", "statutory certification", "TEST-ID-001"]:
                assert text in approved_text, text
            assert approved_text.count("\f") > 1, "A long affidavit must include all report pages"
            assert "affidavit-report.pdf" in approved[1]["Content-Disposition"]
            approved_state = next(r for r in citizen.call("state")[2]["requests"] if r["id"] == affidavit_id)
            assert approved_state["result_format"] == "stamped_document"
            assert abs(time.time() - approved_state["reviewed_at"]) < 30
            assert hashlib.sha256(citizen.call(f"request_download&id={affidavit_id}&pdf=receipt")[2]).hexdigest() == receipt_hash, "Submission receipt must stay immutable"
            pdf = subprocess.check_output(["php", "-r", 'require "src/pdf.php"; echo record_pdf("Test original", ["Source file"], "2026-01-01");'])
            copy_pdf = subprocess.check_output(["php", "-r", 'require "src/pdf.php"; echo record_pdf("Submitted copy", ["Visible submitted copy"], "2026-01-01");'])
            cert_fields = dict(kind="certification",id_number=fields["id_number"],race="",document_type="Identity document",consent="yes")
            cert_files = files[1:] + [("original", "source.pdf", "application/pdf", pdf), ("copy", "copy.pdf", "application/pdf", copy_pdf)]
            for bad_type in ["", "Unknown", "<script>"]:
                assert submit(values=dict(cert_fields,document_type=bad_type),uploads=cert_files)[0] == 400
            for missing in ["selfie","original","copy"]:
                assert submit(values=cert_fields,uploads=[f for f in cert_files if f[0]!=missing])[0] == 400
            cert = submit(values=cert_fields, uploads=cert_files)
            assert cert[0] == 200, cert
            cert_id = cert[2]["id"]
            assert officer.call("request_claim", dict(id=cert_id))[0] == 200
            assert officer.call("request_review", dict(id=cert_id, decision="reject", note="The copy needs a clearer scan."))[0] == 200
            rejected = next(r for r in citizen.call("state")[2]["requests"] if r["id"] == cert_id)
            assert rejected["status"] == "Rejected" and rejected["note"] == "The copy needs a clearer scan."
            assert rejected["details"]["document_type"] == "Identity document" and rejected["details"]["reason"] == ""
            assert {f["kind"] for f in rejected["files"]} == {"selfie","original","copy"}
            assert citizen.call(f"request_download&id={cert_id}&pdf=result")[0] == 404
            assert citizen.call(f"request_download&id={cert_id}&file_id={own_file}")[0] == 404, "Attachment IDs cannot cross requests"
            original = next(f for f in rejected["files"] if f["kind"] == "original")
            assert citizen.call(f"request_download&id={cert_id}&file_id={original['id']}")[2] == pdf
            # Successful certification also records source/copy fingerprints without modifying files.
            cert_ok = submit(values=dict(cert_fields,document_type="Matric"), uploads=cert_files)[2]["id"]
            assert officer.call("request_claim", dict(id=cert_ok))[0] == 200
            assert officer.call("request_review", dict(review, id=cert_ok, identity_checked="yes", documents_checked="yes"))[0] == 200
            cert_pdf = citizen.call(f"request_download&id={cert_ok}&pdf=result")[2]
            cert_text = pdf_text(cert_pdf)
            cert_state = next(r for r in citizen.call("state")[2]["requests"] if r["id"] == cert_ok)
            stamped_time = datetime.fromtimestamp(cert_state["reviewed_at"], ZoneInfo("Africa/Johannesburg"))
            assert f"Approved by firstofficer (officer)" in cert_text
            assert "Electronic signature: F firstofficer" in cert_text, "Certification stamp must use the actual approving Officer's initial and surname"
            assert f"Date and time: {stamped_time.strftime('%Y-%m-%d %H:%M:%S SAST (+02:00)')}" in cert_text, "Certification stamp must show the approval's current Johannesburg date and time"
            assert hashlib.sha256(pdf).hexdigest() in cert_text and "copy.pdf" in cert_text and "Document type: Matric" in cert_text and "REASON" not in cert_text
            assert "Visible submitted copy" in cert_text and "Test original" not in cert_text and "DIGITAL APPROVAL STAMP" in cert_text, "The result must include the submitted COPY, not the original or just an approval register"
            assert "Source SHA-256: " + hashlib.sha256(copy_pdf).hexdigest() in cert_text
            copy_info = next(f for f in citizen.call("state")[2]["requests"] if f["id"] == cert_ok)["files"]
            copy_id = next(f["id"] for f in copy_info if f["kind"] == "copy")
            assert citizen.call(f"request_download&id={cert_ok}&file_id={copy_id}")[2] == copy_pdf
            # Existing databases backfill the actual Officer reviewer when upgrading.
            with sqlite3.connect(data / "police.db") as db:
                db.execute("ALTER TABLE service_requests DROP COLUMN result_format")
                db.execute("ALTER TABLE service_requests DROP COLUMN reviewer_id")
            migrated = admin.call("state")
            assert migrated[0] == 200 and all(r["reviewer_id"] == r["officer_id"] for r in migrated[2]["requests"])
            before_admin = admin.call("backup_archive", dict(password="Admin#26", passphrase=PASSPHRASE, confirm=PASSPHRASE))
            assert before_admin[0] == 200
            current_archive, legacy_archive = root / "current.spbk", root / "legacy-reviewer.spbk"
            current_archive.write_bytes(before_admin[2])
            fixture = subprocess.run(["php","tests/backup_fixture.php",str(current_archive),str(legacy_archive),"legacy-request-reviewer"],
                                     input=PASSPHRASE.encode(),capture_output=True,timeout=60)
            assert fixture.returncode == 0, fixture.stdout + fixture.stderr
            legacy_restored = root / "legacy-restored"
            legacy = subprocess.run(["php","tools/restore.php","restore",str(legacy_archive),"--replace-data"],input=PASSPHRASE.encode(),
                                    env=dict(env,SMART_POLICE_DATA=str(legacy_restored)),capture_output=True,timeout=60)
            assert legacy.returncode == 0, legacy.stdout + legacy.stderr
            migration = subprocess.run(["php","-r","require 'src/lib.php'; db();"],env=dict(env,SMART_POLICE_DATA=str(legacy_restored)),capture_output=True,timeout=30)
            assert migration.returncode == 0, migration.stderr
            with sqlite3.connect(legacy_restored / "police.db") as db:
                assert db.execute("SELECT COUNT(*) FROM service_requests WHERE reviewer_id=officer_id AND reviewed_at IS NOT NULL").fetchone()[0] == 3
            admin_rejected = submit(values=dict(cert_fields,document_type="Qualification"), uploads=cert_files)[2]["id"]
            assert officer.call("request_claim", dict(id=admin_rejected))[0] == 200
            assert admin.call("request_review", dict(id=admin_rejected,decision="reject",note="The uploaded copy is incomplete; please resubmit."))[0] == 200
            assert officer.call("request_review", dict(review,id=admin_rejected,identity_checked="yes",documents_checked="yes"))[0] == 409
            admin_approved = submit(values=dict(cert_fields,document_type="Others"), uploads=cert_files)[2]["id"]
            assert admin.call("request_review", dict(review,id=admin_approved,identity_checked="yes",documents_checked="yes"))[0] == 200
            admin_record = citizen.call(f"request_download&id={admin_approved}&pdf=result")
            assert admin_record[0] == 200
            admin_text = pdf_text(admin_record[2])
            assert "Service Admin" in admin_text and "(admin)" in admin_text and "Electronic signature: S Admin" in admin_text
            admin_result = next(r for r in citizen.call("state")[2]["requests"] if r["id"] == admin_approved)
            assert admin_result["officer_id"] is None and admin_result["reviewer_role"] == "admin"
            assert all(r["id"] != admin_approved for r in second.call("state")[2]["requests"]), "Completed unassigned requests are not an Officer claim queue"
            assert admin.call("request_review", dict(review,id=admin_approved,identity_checked="yes",documents_checked="yes"))[0] == 409
            stats = citizen.call("state")[2]["citizenStats"]
            assert stats == dict(total_cases=0, open_cases=0, service_requests=5, pending_requests=0, approved_requests=3, active_sos=0, total_submissions=5), stats
            oversight = admin.call("state")[2]
            assert len(oversight["requests"]) == 5 and all("details" in r for r in oversight["requests"])
            assert any(a["action"] == "request.approve" for a in oversight["audit"])
            assert admin.call(f"request_download&id={affidavit_id}&pdf=result")[0] == 200
            assert b"TEST-ID-001" not in (data / "police.db").read_bytes(), "Identity details must be encrypted at rest"
            # The complete encrypted recovery archive includes source files and immutable PDFs.
            backup = admin.call("backup_archive", dict(password="Admin#26", passphrase=PASSPHRASE, confirm=PASSPHRASE))
            assert backup[0] == 200, backup
            archive = root / "services.spbk"
            archive.write_bytes(backup[2])
            clean = root / "restored"
            restored = subprocess.run(["php", "tools/restore.php", "restore", str(archive), "--replace-data"], input=PASSPHRASE.encode(),
                                      env=dict(env, SMART_POLICE_DATA=str(clean)), capture_output=True, timeout=60)
            assert restored.returncode == 0, restored.stdout + restored.stderr
            with sqlite3.connect(clean / "police.db") as db:
                assert db.execute("SELECT COUNT(*) FROM service_requests").fetchone()[0] == 5
                assert db.execute("SELECT COUNT(*) FROM request_files").fetchone()[0] == 14
            assert sorted(p.name for p in (clean / "vault").glob("*.enc")) == sorted(p.name for p in (data / "vault").glob("*.enc"))
            # A missing required source file must invalidate backup, not silently lose identity proof.
            with sqlite3.connect(data / "police.db") as db:
                path = db.execute("SELECT vault FROM request_files LIMIT 1").fetchone()[0]
            (data / "vault" / path).unlink()
            assert admin.call("backup_archive", dict(password="Admin#26", passphrase=PASSPHRASE, confirm=PASSPHRASE))[0] == 500
            print("PASS: standalone service lifecycle, private ID/camera files, Officer and Admin decisions, attributed immutable PDFs, reviewer migration, accurate stats and full recovery")
        finally:
            os.killpg(server.pid, signal.SIGTERM)
            server.wait(timeout=5)
            log.close()


if __name__ == "__main__":
    main()
