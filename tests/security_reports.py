#!/usr/bin/env python3
"""Validate requirements using only disposable accounts, files and SQLite storage."""
import csv
from datetime import datetime
import io
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
from zoneinfo import ZoneInfo
from backup_recovery import Client


def main():
    with tempfile.TemporaryDirectory(prefix="sp-security-reports-") as root:
        data = Path(root) / "data"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        server = subprocess.Popen(["php", "-S", f"127.0.0.1:{port}", "-t", "public"],
                                  env=dict(os.environ, SMART_POLICE_DATA=str(data), SP_ONEDRIVE_ROSTER_SYNC="0"),
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        base = f"http://127.0.0.1:{port}/api.php"
        admin, citizen, second, officer, anonymous, guest = [Client(base) for _ in range(6)]
        def approve_signup(username):
            users = admin.call("state")[2]["users"]
            account_id = next(user["id"] for user in users if user["username"] == username)
            return admin.call("user_approval", dict(id=account_id, decision="approve"))[0]
        try:
            for _ in range(50):
                try:
                    if anonymous.call("csrf")[0] == 200:
                        break
                except OSError:
                    time.sleep(.1)
            else:
                raise AssertionError("Test server did not start")
            # A fresh session without a CSRF token cannot create the first admin.
            assert Client(base).call("setup", dict(name="Test Admin", username="admin", email="admin@admin.co.za", password="Admin#26"), token="")[0] == 403
            assert admin.call("setup", dict(name="Test Admin", username="admin", email="admin@admin.co.za", password="tiny"))[0] == 400
            weak_setup = admin.call("setup", dict(name="Test Admin", username="admin", email="admin@admin.co.za", password="000000"))
            assert weak_setup[0] == 400 and "Weak Password" in weak_setup[2]["error"]
            assert admin.call("setup", dict(name="Test Admin", username="admin", email="admin@other.co.za", password="Admin#26"))[0] == 400
            assert admin.call("setup", dict(name="Test Admin", username="admin", password="Admin#26"))[0] == 400
            assert admin.call("setup", dict(name="Test Admin", username="admin", email="admin@admin.co.za", password="Admin#26"))[0] == 200
            roster_state = admin.call("state")[2]["registrationRoster"]
            assert roster_state["synced"] is False and roster_state["web_url"] is None
            assert anonymous.call("registration_roster_sync", {})[0] == 401
            disabled_sync = admin.call("registration_roster_sync", {})
            assert disabled_sync[0] == 502 and "disabled" in disabled_sync[2]["error"]
            assert admin.call("user_create", dict(name="Officer Test", username="officer", role="officer", password="tiny"))[0] == 400
            weak_staff = admin.call("user_create", dict(name="Officer Test", username="officer", role="officer", password="00000"))
            assert weak_staff[0] == 400 and "Weak Password" in weak_staff[2]["error"]
            assert admin.call("user_create", dict(name="Officer Test", username="officer", role="officer", password="Offic#26"))[0] == 200
            assert admin.call("user_create", dict(name="Admin Two", username="admin2", role="admin", password="Admin#26"))[0] == 400
            assert admin.call("user_create", dict(name="Admin Two", username="admin2", role="admin", email="admin@other.co.za", password="Admin#26"))[0] == 400
            assert admin.call("user_create", dict(name="Admin Two", username="admin2", role="admin", email="second@admin.co.za", password="Admin#26"))[0] == 200
            assert admin.call("user_create", dict(name="Admin Three", username="admin3", role="admin", email="second@admin.co.za", password="Admin#26"))[0] == 409
            assert admin.call("user_create", dict(name="Admin Three", username="admin3", role="admin", email="third@admin.co.za", password="Admin#26"))[0] == 200
            assert admin.call("user_create", dict(name="Admin Four", username="admin4", role="admin", email="fourth@admin.co.za", password="Admin#26"))[0] == 200
            assert citizen.call("register", dict(name="Test Citizen", username="citizen", password="tiny"))[0] == 400
            weak_citizen = citizen.call("register", dict(name="Test Citizen", username="weakcitizen", password="00000000"))
            assert weak_citizen[0] == 400 and "Weak Password" in weak_citizen[2]["error"]
            assert citizen.call("register", dict(name="Test Citizen", username="missingcontact", password="Citi#26", _skip_contact_defaults=True))[0] == 400
            assert citizen.call("register", dict(name="Test Citizen", username="badmail", email="citizen@example.com", residential_address="1 Test Street", phone="821234567", password="Citi#26"))[0] == 400
            assert citizen.call("register", dict(name="Test Citizen", username="badphone", email="contact@gmail.com", residential_address="1 Test Street", phone="0821234567", password="Citi#26"))[0] == 400
            assert citizen.call("register", dict(name="Test Citizen", username="badaddress", email="contact@gmail.com", residential_address=" ", phone="821234567", password="Citi#26"))[0] == 400
            response = citizen.call("register", dict(name="Test Citizen", username="citizen", password="Citi#26"))
            assert response[0] == 200 and response[2]["approval_status"] == "active"
            assert citizen.call("register", dict(name="Test Citizen", username="citizen", password="Citi#26"))[0] == 409
            assert citizen.call("login", dict(username="citizen", password="Citi#26", role="citizen"))[0] == 200
            citizen_state = citizen.call("state")
            assert citizen_state[0] == 200 and "registrationRoster" not in citizen_state[2]
            citizen_id = next(u["id"] for u in admin.call("state")[2]["users"] if u["username"] == "citizen")
            citizen_account = next(u for u in admin.call("state")[2]["users"] if u["username"] == "citizen")
            assert citizen_account["email"].endswith("@gmail.com")
            assert citizen_account["phone"] == "+27821234567" and citizen_account["residential_address"] == "1 Test Street, Cape Town"
            assert admin.call("user_approval", dict(id=citizen_id, decision="approve"))[0] == 409
            assert admin.call("user_approval", dict(id=citizen_id, decision="approve"))[0] == 409
            for client in [citizen, second]:
                assert client.call("login", dict(username="citizen", password="Citi#26", role="citizen"))[0] == 200
            assert officer.call("login", dict(username="officer", password="Offic#26", role="officer"))[0] == 200
            assert admin.call("user_password_reset", dict(id=1, password="Reset5"))[0] == 400, "Admin cannot reset own password through staff reset"
            assert anonymous.call("user_password_reset", dict(id=2, password="Reset5"))[0] == 401
            assert citizen.call("user_password_reset", dict(id=2, password="Reset5"))[0] == 403
            assert officer.call("user_password_reset", dict(id=2, password="Reset5"))[0] == 403
            assert admin.call("user_password_reset", dict(id=2, password="tiny"))[0] == 400
            assert admin.call("user_password_reset", dict(id=2, password="Reset5"))[0] == 200
            assert officer.call("state")[0] == 401, "Staff password reset must invalidate active sessions"
            assert officer.call("login", dict(username="officer", password="Offic#26", role="officer"))[0] == 401
            assert officer.call("login", dict(username="officer", password="Reset5", role="officer"))[0] == 200
            officer_id = next(u["id"] for u in admin.call("state")[2]["users"] if u["username"] == "officer")
            assert admin.call("officer_suspend", dict(id=officer_id, decision="suspend", reason="short"))[0] == 400
            assert guest.call("officer_suspend", dict(id=officer_id, decision="suspend", reason="Repeated policy breach"))[0] == 401
            assert citizen.call("officer_suspend", dict(id=officer_id, decision="suspend", reason="Repeated policy breach"))[0] == 403
            assert admin.call("officer_suspend", dict(id=citizen_id, decision="suspend", reason="Repeated policy breach"))[0] == 400
            assert admin.call("officer_suspend", dict(id=officer_id, decision="suspend", reason="Repeated policy breach"))[0] == 200
            suspended_state = admin.call("state")[2]
            suspended_officer = next(u for u in suspended_state["users"] if u["id"] == officer_id)
            assert suspended_officer["suspended"] == 1 and suspended_officer["suspension_reason"] == "Repeated policy breach"
            assert officer_id not in [o["id"] for o in suspended_state["officers"]]
            assert officer.call("state")[0] == 401, "Suspending an officer must end an active session"
            assert officer.call("login", dict(username="officer", password="Reset5", role="officer"))[0] == 403
            assert admin.call("officer_suspend", dict(id=officer_id, decision="reinstate"))[0] == 200
            assert officer.call("login", dict(username="officer", password="Reset5", role="officer"))[0] == 200
            reinstated = next(u for u in admin.call("state")[2]["users"] if u["id"] == officer_id)
            assert reinstated["suspended"] == 0 and reinstated["suspension_reason"] == "Repeated policy breach"
            # All roles can be suspended, but only by another active Admin.
            reason = "Account suspended pending a policy review."
            assert admin.call("user_suspend", dict(id=1, decision="suspend", reason=reason))[0] == 400
            assert guest.call("user_suspend", dict(id=citizen_id, decision="suspend", reason=reason))[0] == 401
            assert citizen.call("user_suspend", dict(id=officer_id, decision="suspend", reason=reason))[0] == 403
            assert admin.call("user_suspend", dict(id=citizen_id, decision="suspend", reason=""))[0] == 400
            assert admin.call("user_suspend", dict(id=citizen_id, decision="suspend", reason=reason), token="wrong")[0] == 403
            assert admin.call("user_suspend", dict(id=citizen_id, decision="suspend", reason=reason))[0] == 200
            assert citizen.call("state")[0] == 401
            assert citizen.call("login", dict(username="citizen", password="Citi#26", role="citizen"))[0] == 403
            assert admin.call("state")[2]["stats"]["activeCitizens"] == 0
            assert admin.call("user_suspend", dict(id=citizen_id, decision="reinstate"))[0] == 200
            assert citizen.call("login", dict(username="citizen", password="Citi#26", role="citizen"))[0] == 200
            # Reinstatement must not revive a session that never polled while suspended.
            assert admin.call("user_suspend", dict(id=citizen_id, decision="suspend", reason=reason))[0] == 200
            assert admin.call("user_suspend", dict(id=citizen_id, decision="reinstate"))[0] == 200
            assert citizen.call("state")[0] == 401
            assert citizen.call("login", dict(username="citizen", password="Citi#26", role="citizen"))[0] == 200
            initial_admin_count = admin.call("state")[2]["stats"]["activeAdmins"]
            added = admin.call("admin_add", dict(name="Added Administrator", username="addedadmin", email="added@admin.co.za"))[2]
            added_id = added["id"]
            setup_token = added["setup_fragment"].split("/")[-1]
            added_client = Client(base)
            assert admin.call("user_suspend", dict(id=added_id, decision="suspend", reason=reason))[0] == 200
            assert added_client.call("admin_setup_info", dict(token=setup_token))[0] != 200
            assert admin.call("user_suspend", dict(id=added_id, decision="reinstate"))[0] == 200
            assert added_client.call("admin_setup_complete", dict(token=setup_token, password="Admin#26", confirm="Admin#26"))[0] == 200
            assert admin.call("user_suspend", dict(id=added_id, decision="suspend", reason=reason))[0] == 200
            assert added_client.call("login", dict(username="addedadmin", password="Admin#26", role="admin"))[0] == 403
            assert admin.call("state")[2]["stats"]["activeAdmins"] == initial_admin_count
            assert admin.call("user_suspend", dict(id=added_id, decision="reinstate"))[0] == 200
            assert admin.call("logout", {})[0] == 200
            assert added_client.call("login", dict(username="addedadmin", password="Admin#26", role="admin"))[0] == 200
            assert added_client.call("user_suspend", dict(id=added_id, decision="suspend", reason=reason))[0] == 400
            assert added_client.call("logout", {})[0] == 200
            assert admin.call("login", dict(username="admin", password="Admin#26", role="admin"))[0] == 200
            assert anonymous.call("register", dict(name="Open Username", username="Simphiwe30", password="Open#26"))[0] == 200
            assert anonymous.call("login", dict(username="Simphiwe30", password="Open#26", role="citizen"))[0] == 200
            assert anonymous.call("register", dict(name="Open Username", username="Citizen #1 🌍", password="Open#26"))[0] == 200
            assert anonymous.call("login", dict(username="Citizen #1 🌍", password="Open#26", role="citizen"))[0] == 200
            assert anonymous.call("register", dict(name="Open Username", username="x", password="Open#26"))[0] == 200
            assert anonymous.call("register", dict(name="Open Username", username="é" * 80, password="Open#26"))[0] == 200
            assert anonymous.call("register", dict(name="Open Username", username="é" * 81, password="Open#26"))[0] == 400
            assert anonymous.call("register", dict(name="Open Username", username="bad\u0000name", password="Open#26"))[0] == 400
            for index, password in enumerate(["1234", "12345", "12345678", "123456789", "é" * 5, "😀" * 8]):
                expected = 200 if 5 <= len(password) <= 8 else 400
                assert anonymous.call("register", dict(name="Length Test", username=f"length{index}", role="citizen", password=password))[0] == expected
            pending_clients = {}
            for role in ["officer", "admin"]:
                pending = Client(base)
                signup = dict(name=f"ZZ Pending {role}", username=f"pending_{role}", role=role, password="Staff#26", approval_status="active")
                if role == "admin": signup["email"] = "signup@admin.co.za"
                response = pending.call("register", signup)
                assert response[0] == 200 and response[2]["approval_status"] == "pending"
                assert pending.call("login", dict(username=f"pending_{role}", role=role, password="Staff#26"))[0] == 403
                assert pending.call("state")[0] == 401
                pending_clients[role] = pending
            state = admin.call("state")[2]
            ids = {u["username"]: u["id"] for u in state["users"]}
            pending_id = ids["pending_officer"]
            assert pending_id not in [o["id"] for o in state["officers"]]
            for unauthorized, expected in [(guest, 401), (citizen, 403), (officer, 403)]:
                response = unauthorized.call("user_approval", dict(id=pending_id, decision="approve"))
                assert response[0] == expected, (expected, response[0], response[2])
            assert admin.call("user_approval", dict(id=pending_id, decision="approve"), token="invalid")[0] == 403
            assert admin.call("user_approval", dict(id=pending_id, decision="approve"))[0] == 200
            assert admin.call("user_approval", dict(id=pending_id, decision="approve"))[0] == 409
            assert pending_clients["officer"].call("login", dict(username="pending_officer", role="officer", password="Staff#26"))[0] == 200
            assert pending_clients["officer"].call("login", dict(username="pending_officer", role="admin", password="Staff#26"))[0] == 403
            assert admin.call("user_approval", dict(id=ids["pending_admin"], decision="reject"))[0] == 200
            assert pending_clients["admin"].call("login", dict(username="pending_admin", role="admin", password="Staff#26"))[0] == 403
            assert admin.call("user_approval", dict(id=ids["admin"], decision="reject"))[0] == 409
            assert state["users"][0]["email"] == "admin@admin.co.za"
            for payload in [
                dict(title=" ", type="Theft", description="Long enough description."),
                dict(title="Valid title", type="Invented", description="Long enough description."),
                dict(title="Valid title", type="Theft", description="Short"),
                dict(title="x" * 121, type="Theft", description="Long enough description."),
                dict(title=["not text"], type="Theft", description="Long enough description.")
            ]:
                assert citizen.call("report", payload)[0] == 400, payload
            assert citizen.call("report", dict(title="=DANGEROUS()", type="Theft", description="Real database test record."))[0] == 200
            case_id = citizen.call("state")[2]["cases"][0]["id"]
            visible_case = next(item for item in officer.call("state")[2]["cases"] if item["id"] == case_id)
            assert visible_case["citizen_email"].endswith("@gmail.com")
            assert visible_case["citizen_phone"] == "+27821234567"
            assert visible_case["citizen_address"] == "1 Test Street, Cape Town"
            assert officer.call("assign", dict(case_id=case_id))[0] == 200
            sos_response = citizen.call("sos", dict(lat=-33.9, lng=18.4))
            assert sos_response[0] == 200
            assert citizen.call("sos_update", dict(id=sos_response[2]["id"], lat=-33.91, lng=18.41))[0] == 200
            assert any(event["action"] == "sos.location_update" for event in admin.call("state")[2]["audit"])
            today = datetime.now(ZoneInfo("Africa/Johannesburg")).strftime("%Y-%m-%d")
            for kind in ["cases", "status", "officers", "sos", "audit"]:
                route = f"operational_report&type={kind}&from={today}&to={today}"
                for unauthorized, expected in [(guest, 401), (citizen, 403), (officer, 403)]:
                    assert unauthorized.call(route)[0] == expected
                code, headers, pdf = admin.call(route + "&format=pdf")
                assert code == 200 and headers.get_content_type() == "application/pdf"
                assert pdf.startswith(b"%PDF-1.4") and pdf.endswith(b"%%EOF\n")
                assert b"Generated:" in pdf and today.encode() in pdf
                code, headers, content = admin.call(route + "&format=csv")
                assert code == 200 and headers.get_content_type() == "text/csv"
                rows = list(csv.reader(io.StringIO(content.decode())))
                assert rows[0][0] == "Report" and rows[1][0] == "Generated"
                assert len(rows) >= 7, kind
                if kind == "cases":
                    assert rows[6][1] == "'=DANGEROUS()", rows
                if kind == "officers":
                    assert rows[6][2:] == ["1", "1", "0"], rows
            empty = admin.call("operational_report&type=cases&format=pdf&from=2000-01-01&to=2000-01-01")
            assert b"No matching records." in empty[2]
            for query in ["from=2026-02-30", "from=bad", "from=2026-02-02&to=2026-01-01", "type=other", "format=exe"]:
                assert admin.call("operational_report&" + query)[0] == 400, query
            for unauthorized, expected in [(guest, 401), (citizen, 403), (officer, 403)]:
                assert unauthorized.call("settings_pdf")[0] == expected
                assert unauthorized.call("pdf_export_download&id=1")[0] == expected
            code, headers, settings_pdf = admin.call("settings_pdf")
            assert code == 200 and headers.get_content_type() == "application/pdf"
            assert settings_pdf.startswith(b"%PDF-1.4") and b"SETTINGS AND SYNC" in settings_pdf
            saved_exports = admin.call("state")[2]["pdfExports"]
            settings_export = next(item for item in saved_exports if item["filename"].startswith("smart-police-settings-sync-"))
            code, headers, saved_pdf = admin.call(f"pdf_export_download&id={settings_export['id']}")
            assert code == 200 and headers.get_content_type() == "application/pdf" and saved_pdf == settings_pdf
            assert citizen.call("password_change", dict(old="wrong", new="New#2026"))[0] == 400
            assert citizen.call("password_change", dict(old="Citi#26", new="tiny"))[0] == 400
            assert citizen.call("password_change", dict(old="Citi#26", new="New#2026"))[0] == 200
            assert citizen.call("state")[0] == 200
            assert second.call("state")[0] == 401, "Password change must invalidate other signed-in sessions"
            assert second.call("login", dict(username="citizen", password="Citi#26"))[0] == 401
            assert second.call("login", dict(username="citizen", password="New#2026"))[0] == 200
            # Repeated failures are limited even for an unknown username.
            for _ in range(5):
                assert guest.call("login", dict(username="unknown", password="Wrong5"))[0] == 401
            assert guest.call("login", dict(username="unknown", password="Wrong5"))[0] == 429
            assert guest.call("login", dict(username="unknown", password="four"))[0] == 400
            assert guest.call("login", dict(username="unknown", password="Nine#Chars"))[0] == 400
            assert admin.call("password_change", dict(old="Admin#26", new="AdmNew26"))[0] == 200
            assert admin.call("state")[0] == 200, "Admin lock must follow the rotated session"
            with sqlite3.connect(data / "police.db") as db:
                assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
                assert db.execute("PRAGMA foreign_key_check").fetchall() == []
                assert db.execute("SELECT COUNT(*) FROM cases").fetchone()[0] == 1
                assert db.execute("SELECT COUNT(*) FROM pdf_exports").fetchone()[0] == 7
                assert all(row[0].startswith("$2") for row in db.execute("SELECT pass_hash FROM users"))
            # Long legacy hashes remain blocked at login; admins can safely reset them.
            legacy_hash = subprocess.check_output(["php", "-r", "echo password_hash('legacy-password-2026', PASSWORD_DEFAULT);"]).decode()
            with sqlite3.connect(data / "police.db") as db:
                db.execute("UPDATE users SET pass_hash=? WHERE username='citizen'", (legacy_hash,))
                citizen_id = db.execute("SELECT id FROM users WHERE username='citizen'").fetchone()[0]
            assert second.call("login", dict(username="citizen", password="legacy-password-2026"))[0] == 400
            assert admin.call("user_password_reset", dict(id=citizen_id, password="Reset5"))[0] == 200
            assert second.call("login", dict(username="citizen", password="Reset5"))[0] == 200
            print("PASS: server-side validation, database integrity, five PDF/CSV reports and date filters, "
                  "role-specific staff signup/approval/rejection, all account passwords constrained to 5–8 characters, "
                  "admin recovery of older passwords, role restrictions, "
                  "CSV formula protection, CSRF, throttling, session rotation and revocation")
        finally:
            server.terminate()
            server.wait(timeout=5)


if __name__ == "__main__":
    main()
