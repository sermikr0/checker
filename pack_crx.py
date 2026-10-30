#!/usr/bin/env python3
"""
Pack a Chrome extension folder into a signed CRX3 package.

Usage:
    python3 pack_crx.py <ext_dir> <key.pem> <out.crx>

If <key.pem> does not exist it is generated (RSA-2048) and kept — the key is
what gives the extension its STABLE id across updates, so guard it and reuse it
for every version. Prints the extension id.

CRX3 format: "Cr24" | u32 version(3) | u32 header_len | CrxFileHeader | zip
Signature (RSASSA-PKCS1v1_5 / SHA-256) is over:
    "CRX3 SignedData\\x00" | u32_le(len(signed_header)) | signed_header | zip
where signed_header is a SignedData proto carrying the 16-byte crx-id.
"""
import hashlib
import io
import os
import struct
import sys
import zipfile

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa


def varint(n):
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def field_bytes(field_num, data):
    # wire type 2 (length-delimited)
    return varint((field_num << 3) | 2) + varint(len(data)) + data


def load_or_make_key(pem_path):
    if os.path.exists(pem_path):
        with open(pem_path, "rb") as f:
            return serialization.load_pem_private_key(f.read(), password=None)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    with open(pem_path, "wb") as f:
        f.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ))
    os.chmod(pem_path, 0o600)
    return key


def zip_dir(ext_dir):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for root, _dirs, files in os.walk(ext_dir):
            for name in sorted(files):
                full = os.path.join(root, name)
                arc = os.path.relpath(full, ext_dir)
                z.write(full, arc)
    return buf.getvalue()


def ext_id_from_pubkey(pub_der):
    digest = hashlib.sha256(pub_der).digest()[:16]
    return "".join(chr(ord("a") + (b >> 4)) + chr(ord("a") + (b & 0xF)) for b in digest)


def main():
    if len(sys.argv) != 4:
        print(__doc__)
        sys.exit(1)
    ext_dir, pem_path, out_crx = sys.argv[1], sys.argv[2], sys.argv[3]

    key = load_or_make_key(pem_path)
    pub_der = key.public_key().public_bytes(
        serialization.Encoding.DER,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    )
    crx_id = hashlib.sha256(pub_der).digest()[:16]
    ext_id = ext_id_from_pubkey(pub_der)

    zip_bytes = zip_dir(ext_dir)

    signed_header = field_bytes(1, crx_id)  # SignedData { bytes crx_id = 1; }
    to_sign = (b"CRX3 SignedData\x00" +
               struct.pack("<I", len(signed_header)) + signed_header + zip_bytes)
    signature = key.sign(to_sign, padding.PKCS1v15(), hashes.SHA256())

    proof = field_bytes(1, pub_der) + field_bytes(2, signature)  # AsymmetricKeyProof
    header = field_bytes(2, proof) + field_bytes(10000, signed_header)  # CrxFileHeader

    with open(out_crx, "wb") as f:
        f.write(b"Cr24")
        f.write(struct.pack("<I", 3))
        f.write(struct.pack("<I", len(header)))
        f.write(header)
        f.write(zip_bytes)

    print("extension_id: %s" % ext_id)
    print("crx:          %s (%d bytes)" % (out_crx, os.path.getsize(out_crx)))
    print("key:          %s (KEEP THIS — reuse for every update)" % pem_path)


if __name__ == "__main__":
    main()
