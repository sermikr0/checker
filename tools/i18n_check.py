#!/usr/bin/env python3
"""Check that every dashboard string has an Uzbek translation.

    python3 tools/i18n_check.py

Keys are the English strings passed to t(...) / tn(...) in web/assets.
Exit code 1 if any are missing from web/assets/i18n-uz.js.
"""
import glob
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web", "assets")
STR = r"'((?:[^'\\]|\\.)*)'"


def collect():
    keys, seen = [], set()

    def add(k):
        if k not in seen:
            seen.add(k)
            keys.append(k)

    for f in sorted(glob.glob(os.path.join(ROOT, "*.js")) + glob.glob(os.path.join(ROOT, "views", "*.js"))):
        if os.path.basename(f).startswith("i18n"):
            continue
        src = open(f, encoding="utf-8").read()
        for m in re.finditer(r"\btn\(\s*[^,]+?,\s*" + STR + r"\s*,\s*" + STR, src):
            add(m.group(2))          # Uzbek only needs the plural ("other") form
        for m in re.finditer(r"(?<![\w.])t\(\s*" + STR, src):
            add(m.group(1))
        if f.endswith("common.js"):  # audit-event sentence templates
            for m in re.finditer(r"\['\w+', '\w*', " + STR + r"\]", src):
                add(m.group(1))
    return keys


def main():
    keys = collect()
    uz = open(os.path.join(ROOT, "i18n-uz.js"), encoding="utf-8").read()
    have = set(re.findall(r"^\s*" + STR + r":", uz, re.M))
    missing = [k for k in keys if k not in have]
    print("%d strings, %d missing" % (len(keys), len(missing)))
    for k in missing:
        print("  missing:", k)
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main())
