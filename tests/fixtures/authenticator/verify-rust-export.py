"""Independently verify a synthetic Rust-produced Ente export using PyNaCl/libsodium.

Usage: python tests/fixtures/authenticator/verify-rust-export.py test-results/authenticator-rust-interop.json
Only use the synthetic output from the Rust interoperability test.
"""
import base64
import json
import sys
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote
from nacl import bindings
from nacl.pwhash import argon2id

envelope = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
assert envelope["version"] == 1
kdf = envelope["kdfParams"]
assert kdf["memLimit"] == 67108864 and kdf["opsLimit"] == 3
key = argon2id.kdf(32, b"interop-test-passphrase", base64.b64decode(kdf["salt"]), opslimit=kdf["opsLimit"], memlimit=kdf["memLimit"])
state = bindings.crypto_secretstream_xchacha20poly1305_state()
bindings.crypto_secretstream_xchacha20poly1305_init_pull(state, base64.b64decode(envelope["encryptionNonce"]), key)
payload, tag = bindings.crypto_secretstream_xchacha20poly1305_pull(state, base64.b64decode(envelope["encryptedData"]))
assert tag == bindings.crypto_secretstream_xchacha20poly1305_TAG_FINAL
lines = payload.decode("utf-8").strip().splitlines()
assert len(lines) == 1
uri = urlparse(lines[0])
assert uri.scheme == "otpauth" and uri.netloc == "totp"
assert unquote(uri.path) == "/Example:demo@example.test"
assert parse_qs(uri.query) == {"secret": ["GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"], "issuer": ["Example"], "algorithm": ["SHA1"], "digits": ["6"], "period": ["30"]}
print("Rust -> independent libsodium: passed (URI fields and FINAL tag verified)")
