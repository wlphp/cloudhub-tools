"""Generate an Ente-format interoperability vector using independent PyNaCl/libsodium.

Only the public RFC 4226 example seed is used. Requires PyNaCl, not the app's Rust libraries.
Run from any directory: python tests/fixtures/authenticator/generate-libsodium.py
"""
import base64
import json
from pathlib import Path
from nacl import bindings
from nacl.pwhash import argon2id

root = Path(__file__).resolve().parent
password = b"interop-test-passphrase"
salt = bytes(range(16))
memory = 8 * 1024 * 1024
operations = 3
key = argon2id.kdf(32, password, salt, opslimit=operations, memlimit=memory)
payload = b"otpauth://totp/Example:demo%40example.test?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Example&algorithm=SHA1&digits=6&period=30\n"
for name, tag in [("final", bindings.crypto_secretstream_xchacha20poly1305_TAG_FINAL), ("message", bindings.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE)]:
    state = bindings.crypto_secretstream_xchacha20poly1305_state()
    header = bindings.crypto_secretstream_xchacha20poly1305_init_push(state, key)
    ciphertext = bindings.crypto_secretstream_xchacha20poly1305_push(state, payload, tag=tag)
    encode = lambda value: base64.b64encode(value).decode("ascii")
    vector = {"version": 1, "kdfParams": {"memLimit": memory, "opsLimit": operations, "salt": encode(salt)}, "encryptedData": encode(ciphertext), "encryptionNonce": encode(header)}
    (root / f"ente-libsodium-{name}.json").write_text(json.dumps(vector, indent=2), encoding="utf-8")
print("Generated two synthetic Ente/libsodium secretstream vectors.")
