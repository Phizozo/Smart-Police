#!/usr/bin/env python3
"""Admin and Officer setup links against disposable storage; never touches working accounts."""
import json
import os
from pathlib import Path
import signal
import socket
import sqlite3
import subprocess
import tempfile
import time
from backup_recovery import Client, PASSPHRASE


def main():
    with tempfile.TemporaryDirectory(prefix="sp-admin-setup-") as temp:
        data = Path(temp) / "data"
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        log = tempfile.TemporaryFile()
        server = subprocess.Popen(["php", "-S", f"127.0.0.1:{port}", "-t", "public"],
                                  env=dict(os.environ, SMART_POLICE_DATA=str(data), SP_ONEDRIVE_ROSTER_SYNC="0"),
                                  stdout=subprocess.DEVNULL, stderr=log, start_new_session=True)
        try:
            url = f"http://127.0.0.1:{port}/api.php"
            root, public, citizen, officer, first, second = [Client(url) for _ in range(6)]
            for _ in range(50):
                try:
                    if public.call("csrf")[0] == 200:
                        break
                except OSError:
                    time.sleep(.1)

            def ok(client, action, values):
                response = client.call(action, values)
                assert response[0] == 200, f"{action}: HTTP {response[0]}"
                return response[2]

            def add(client, name, email):
                username = email.split("@")[0]
                result = ok(client, "admin_add", dict(name=name, email=email, username=username))
                assert result["username"] == username
                assert time.time() < result["expires_at"] <= time.time() + 3601
                return result, result["setup_fragment"].split("/")[-1]

            ok(root, "setup", dict(name="Root Admin", username="rootadmin",
                                  email="root@admin.co.za", password="Admin#26"))
            assert public.call("admin_add", dict(name="No Access", email="no@admin.co.za"))[0] == 401
            assert public.call("officer_add", dict(name="No Access", username="noofficer", email="no@example.org"))[0] == 401
            ok(citizen, "register", dict(name="Test Citizen", username="testcitizen", role="citizen",
                                       password="Citiz#26", email="citizentest@gmail.com",
                                       residential_address="1 Test Street, Cape Town", phone="821234567"))
            ok(citizen, "login", dict(username="testcitizen", password="Citiz#26", role="citizen"))
            assert citizen.call("admin_add", dict(name="No Access", email="no@admin.co.za"))[0] == 403
            assert citizen.call("officer_add", dict(name="No Access", username="noofficer", email="no@example.org"))[0] == 403
            ok(root, "user_create", dict(name="Test Officer", username="testofficer",
                                        role="officer", password="Offic#26"))
            ok(officer, "login", dict(username="testofficer", password="Offic#26", role="officer"))
            assert officer.call("admin_setup_reissue", dict(id=1))[0] == 403
            assert officer.call("officer_add", dict(name="No Access", username="noofficer", email="no@example.org"))[0] == 403
            assert root.call("admin_add", dict(name="Missing email"))[0] == 400
            assert root.call("admin_add", dict(name="Invalid Email", email="wrong@gmail.com"))[0] == 400
            assert root.call("admin_add", dict(name="No Username", email="nouser@admin.co.za"))[0] == 400
            assert root.call("admin_add", dict(name="Duplicate Username", email="dupeuser@admin.co.za", username="ROOTADMIN"))[0] == 409
            assert root.call("officer_add", dict(name="Invalid Officer", username="invalid-officer", email="not-an-email"))[0] == 400
            assert root.call("officer_add", dict(name="Duplicate Username", username="ROOTADMIN", email="duplicate@example.org"))[0] == 409
            assert root.call("admin_add", dict(name="Valid Name", email="valid@admin.co.za"), token="wrong")[0] == 403

            officer_invite = ok(root, "officer_add", dict(name="Invited Officer", username="invited.officer", email="officer@example.org"))
            assert officer_invite["role"] == "officer"
            officer_token = officer_invite["setup_fragment"].split("/")[-1]
            officer_info = ok(public, "admin_setup_info", dict(token=officer_token))
            assert officer_info["role"] == "officer" and officer_info["username"] == "invited.officer"
            assert second.call("login", dict(username="invited.officer", password="Offic#26", role="officer"))[0] == 401
            ok(public, "admin_setup_complete", dict(token=officer_token, password="Offic#26", confirm="Offic#26"))
            ok(second, "login", dict(username="invited.officer", password="Offic#26", role="officer"))
            ok(second, "logout", {})

            account, token = add(root, "First Added Admin", "first@admin.co.za")
            assert root.call("admin_add", dict(name="Duplicate Admin", email="FIRST@admin.co.za"))[0] == 409
            info = ok(public, "admin_setup_info", dict(token=token))
            assert info["name"] == "First Added Admin" and info["username"] == account["username"]
            assert public.call("admin_setup_info", dict(token=token), token="wrong")[0] == 403
            state = root.call("state")[2]
            assert state["stats"]["activeAdmins"] == 1
            assert "admin_setup_hash" not in json.dumps(state) and token not in json.dumps(state)
            row = next(user for user in state["users"] if user["id"] == account["id"])
            assert row["setup_pending"] and row["email"] == "first@admin.co.za"
            assert first.call("login", dict(username=account["username"], password="Admin#26", role="admin"))[0] == 401
            for password in ["abcd", "123456789"]:
                assert public.call("admin_setup_complete", dict(token=token, password=password, confirm=password))[0] == 400
            weak = public.call("admin_setup_complete", dict(token=token, password="000000", confirm="000000"))
            assert weak[0] == 400 and "Weak Password" in weak[2]["error"]
            assert public.call("admin_setup_complete", dict(token=token, password="Ab12!", confirm="Other"))[0] == 400
            ok(public, "admin_setup_complete", dict(token=token, password="Ab12!", confirm="Ab12!"))
            assert public.call("csrf")[2]["me"] is None, "Setup must not automatically sign in"
            assert public.call("admin_setup_complete", dict(token=token, password="Other", confirm="Other"))[0] == 410
            ok(root, "logout", {})
            ok(first, "login", dict(username=account["username"], password="Ab12!", role="admin"))

            account2, token2 = add(first, "Second Added Admin", "second@admin.co.za")
            assert first.call("state")[2]["stats"]["activeAdmins"] == 2
            unicode_password = "Åb😊12x中Z"
            assert len(unicode_password) == 8
            ok(public, "admin_setup_complete", dict(token=token2, password=unicode_password, confirm=unicode_password))
            assert first.call("state")[2]["stats"]["activeAdmins"] == 3

            pending, old_token = add(first, "Pending Admin", "pending@admin.co.za")
            assert public.call("admin_setup_reissue", dict(id=pending["id"]))[0] == 401
            rotated = ok(first, "admin_setup_reissue", dict(id=pending["id"]))
            new_token = rotated["setup_fragment"].split("/")[-1]
            assert old_token != new_token
            assert public.call("admin_setup_info", dict(token=old_token))[0] == 410
            ok(public, "admin_setup_info", dict(token=new_token))
            with sqlite3.connect(data / "police.db") as db:
                stored = db.execute("SELECT admin_setup_hash FROM users WHERE id=?", (pending["id"],)).fetchone()[0]
                assert len(stored) == 64 and stored != new_token
                db.execute("UPDATE users SET admin_setup_expires=? WHERE id=?", (int(time.time())-1, pending["id"]))
            assert public.call("admin_setup_info", dict(token=new_token))[0] == 410
            rotated = ok(first, "admin_setup_reissue", dict(id=pending["id"]))
            new_token = rotated["setup_fragment"].split("/")[-1]
            archive = first.call("backup_archive", dict(password="Ab12!", passphrase=PASSPHRASE, confirm=PASSPHRASE))
            assert archive[0] == 200, "Backups must accept pending setup metadata"
            ok(first, "user_password_reset", dict(id=pending["id"], password="Reset#26"))
            assert public.call("admin_setup_info", dict(token=new_token))[0] == 410
            assert first.call("admin_setup_reissue", dict(id=pending["id"]))[0] == 409
            _, epoch_token = add(first, "Recovery Pending", "recover@admin.co.za")
            ok(first, "logout", {})
            ok(second, "login", dict(username=account2["username"], password=unicode_password, role="admin"))
            ok(second, "logout", {})
            # Recovery rotates this epoch; old pending links must also be revoked.
            (data / "session.epoch").write_text("f" * 64)
            assert public.call("admin_setup_info", dict(token=epoch_token))[0] == 410
            print("PASS: Admin-only creation, two-field onboarding, 5–8 Unicode passwords, single-use/expiry/reissue, no auto-login, token privacy, backups and recovery revocation")
        finally:
            os.killpg(server.pid, signal.SIGTERM)
            server.wait(timeout=5)
            log.close()


if __name__ == "__main__":
    main()
