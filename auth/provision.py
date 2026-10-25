"""Derive a private password verifier on the server; never print credentials."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--credentials-file", required=True)
parser.add_argument("--output", required=True)
args = parser.parse_args()
try:
    raw = json.loads(Path(args.credentials_file).read_text())
    address = urlsplit(raw["url"])
    username, password = raw["username"], raw["password"]
    if (address.scheme != "https" or not address.netloc or address.username or
            address.path not in ("", "/") or address.query or address.fragment or
            not isinstance(username, str) or not 1 <= len(username.encode()) <= 128 or
            any(char in username for char in "\r\n:") or
            not isinstance(password, str) or not 1 <= len(password.encode()) <= 1024):
        raise ValueError()
except (OSError, ValueError, KeyError, TypeError):
    raise SystemExit("Credentials are unavailable or invalid; no files were changed.")
salt = secrets.token_bytes(32)
iterations = 600000
derived = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, iterations, 32)
config = {"origin": address.scheme + "://" + address.netloc, "username": username,
          "salt": base64.b64encode(salt).decode(),
          "password_hash": base64.b64encode(derived).decode(), "iterations": iterations}
output = Path(args.output)
output.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
try:
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
except FileExistsError:
    raise SystemExit("Output already exists; use a new filename to preserve rollback.")
with os.fdopen(descriptor, "w") as target:
    json.dump(config, target)
    target.write("\n")
if os.geteuid() == 0:
    os.chown(output, 0, 101)
    os.chmod(output, 0o440)
print("Private password verifier created; account and password were not printed.")
