#!/usr/bin/env python3
"""
Builds an unsigned APK without aapt2:
  * encodes AndroidManifest.xml into Android binary XML (AXML)
  * writes a tiny resources.arsc (app_name string + launcher icon drawable)
  * zips manifest, resources, classes.dex and assets (resources.arsc stored + 4-byte aligned)

Usage: apkbuild.py <manifest.xml> <strings.xml> <icon.png> <classes.dex> <assets_dir> <out.apk>
"""
import os
import struct
import sys
import xml.etree.ElementTree as ET
import zipfile

ANDROID_NS = "http://schemas.android.com/apk/res/android"

# android.R.attr ids (from android.jar)
ATTR_IDS = {
    "theme": 0x01010000, "label": 0x01010001, "icon": 0x01010002, "name": 0x01010003,
    "permission": 0x01010006, "exported": 0x01010010, "configChanges": 0x0101001f,
    "versionCode": 0x0101021b, "versionName": 0x0101021c, "minSdkVersion": 0x0101020c,
    "windowSoftInputMode": 0x0101022b, "targetSdkVersion": 0x01010270,
    "hardwareAccelerated": 0x010102d3, "usesCleartextTraffic": 0x010104ec,
    "allowBackup": 0x01010280, "supportsRtl": 0x010103af,
}
# framework / app resource references used by the manifest
REFS = {
    "@android:style/Theme.Material.Light.NoActionBar": 0x01030241,
    "@string/app_name": 0x7f020000,
    "@drawable/ic_launcher": 0x7f010000,
}
INT_ATTRS = {"versionCode", "minSdkVersion", "targetSdkVersion"}
FLAG_ATTRS = {  # attribute -> {flag name: value}
    "configChanges": {"orientation": 0x80, "screenSize": 0x400, "keyboardHidden": 0x20, "keyboard": 0x10,
                      "screenLayout": 0x100, "smallestScreenSize": 0x800, "uiMode": 0x200, "density": 0x1000},
    "windowSoftInputMode": {"adjustResize": 0x10, "adjustPan": 0x20, "stateHidden": 0x2},
}

T_REF, T_STRING, T_INT_DEC, T_INT_HEX, T_BOOL = 0x01, 0x03, 0x10, 0x11, 0x12


def pad4(b):
    return b + b"\0" * ((4 - len(b) % 4) % 4)


def string_pool(strings, utf8=True):
    offsets, data = [], b""
    for s in strings:
        offsets.append(len(data))
        if utf8:
            enc = s.encode("utf-8")
            def ln(n):
                return bytes([n]) if n < 0x80 else bytes([0x80 | (n >> 8), n & 0xFF])
            data += ln(len(s)) + ln(len(enc)) + enc + b"\0"
        else:
            enc = s.encode("utf-16-le")
            n = len(enc) // 2
            data += (struct.pack("<H", n) if n < 0x8000 else struct.pack("<HH", 0x8000 | (n >> 16), n & 0xFFFF)) + enc + b"\0\0"
    data = pad4(data)
    header_size = 28
    strings_start = header_size + 4 * len(strings)
    size = strings_start + len(data)
    flags = 0x100 if utf8 else 0
    hdr = struct.pack("<HHIIIIII", 0x0001, header_size, size, len(strings), 0, flags, strings_start, 0)
    return hdr + b"".join(struct.pack("<I", o) for o in offsets) + data


def encode_manifest(path):
    tree = ET.parse(path)
    root = tree.getroot()

    # collect strings: android attribute names first (they map to resource ids), then the rest
    attr_names = []
    others = []

    def walk(el):
        for k in el.attrib:
            ns, local = split(k)
            if ns == ANDROID_NS:
                if local not in ATTR_IDS:
                    raise SystemExit("unknown android attribute: " + local)
                if local not in attr_names:
                    attr_names.append(local)
        for c in el:
            walk(c)

    def split(tag):
        if tag.startswith("{"):
            ns, local = tag[1:].split("}", 1)
            return ns, local
        return None, tag

    walk(root)
    attr_names.sort(key=lambda n: ATTR_IDS[n])
    strings = list(attr_names)

    def sidx(s):
        if s not in strings:
            strings.append(s)
        return strings.index(s)

    sidx("android")
    sidx(ANDROID_NS)
    body = b""
    line = 1

    def ns_chunk(t):
        return struct.pack("<HHIII", t, 16, 24, line, 0xFFFFFFFF) + struct.pack("<II", sidx("android"), sidx(ANDROID_NS))

    def value(local, ns, raw):
        if ns == ANDROID_NS and raw in REFS:
            return 0xFFFFFFFF, T_REF, REFS[raw]
        if ns == ANDROID_NS and local in INT_ATTRS:
            return 0xFFFFFFFF, T_INT_DEC, int(raw)
        if ns == ANDROID_NS and local in FLAG_ATTRS:
            v = 0
            for f in raw.split("|"):
                v |= FLAG_ATTRS[local][f]
            return 0xFFFFFFFF, T_INT_HEX, v
        if ns == ANDROID_NS and raw in ("true", "false"):
            return 0xFFFFFFFF, T_BOOL, 0xFFFFFFFF if raw == "true" else 0
        i = sidx(raw)
        return i, T_STRING, i

    def element(el):
        nonlocal body
        ns, local = split(el.tag)
        attrs = []
        for k, raw in el.attrib.items():
            ans, alocal = split(k)
            rawidx, typ, data = value(alocal, ans, raw)
            name_idx = sidx(alocal)
            attrs.append((ATTR_IDS.get(alocal, 0xFFFFFFFF) if ans == ANDROID_NS else 0xFFFFFFFF + 1 + name_idx,
                          sidx(ANDROID_NS) if ans == ANDROID_NS else 0xFFFFFFFF, name_idx, rawidx, typ, data))
        attrs.sort(key=lambda a: a[0])  # Android expects attributes ordered by resource id
        a_bytes = b"".join(struct.pack("<IIIHBBI", a[1], a[2], a[3], 8, 0, a[4], a[5]) for a in attrs)
        ext = struct.pack("<IIHHHHHH", 0xFFFFFFFF, sidx(local), 20, 20, len(attrs), 0, 0, 0)
        size = 16 + len(ext) + len(a_bytes)
        body += struct.pack("<HHIII", 0x0102, 16, size, line, 0xFFFFFFFF) + ext + a_bytes
        for c in el:
            element(c)
        body += struct.pack("<HHIII", 0x0103, 16, 24, line, 0xFFFFFFFF) + struct.pack("<II", 0xFFFFFFFF, sidx(local))

    body += ns_chunk(0x0100)
    element(root)
    body += ns_chunk(0x0101)

    pool = string_pool(strings)
    resmap = struct.pack("<HHI", 0x0180, 8, 8 + 4 * len(attr_names)) + b"".join(struct.pack("<I", ATTR_IDS[n]) for n in attr_names)
    content = pool + resmap + body
    return struct.pack("<HHI", 0x0003, 8, 8 + len(content)) + content


def encode_arsc(app_name, icon_path):
    """Package 0x7f: drawable/ic_launcher (0x7f010000, xxxhdpi), string/app_name (0x7f020000)."""
    values = string_pool([icon_path, app_name])
    type_strings = string_pool(["drawable", "string"], utf8=False)
    key_strings = string_pool(["ic_launcher", "app_name"], utf8=False)

    def config(density=0):
        c = bytearray(64)
        struct.pack_into("<I", c, 0, 64)
        struct.pack_into("<H", c, 14, density)
        return bytes(c)

    def type_spec(type_id, n):
        return struct.pack("<HHIBBHI", 0x0202, 16, 16 + 4 * n, type_id, 0, 0, n) + b"\0\0\0\0" * n

    def type_chunk(type_id, cfg, entries):  # entries: list of (key_idx, data_type, data)
        n = len(entries)
        header_size = 20 + len(cfg)
        entries_start = header_size + 4 * n
        offs, data = b"", b""
        for key_idx, dt, dv in entries:
            offs += struct.pack("<I", len(data))
            data += struct.pack("<HHI", 8, 0, key_idx) + struct.pack("<HBBI", 8, 0, dt, dv)
        size = entries_start + len(data)
        return struct.pack("<HHIBBHII", 0x0201, header_size, size, type_id, 0, 0, n, entries_start) + cfg + offs + data

    chunks = (type_spec(1, 1) + type_chunk(1, config(640), [(0, T_STRING, 0)]) +
              type_spec(2, 1) + type_chunk(2, config(0), [(1, T_STRING, 1)]))
    pkg_header_size = 288
    name = "com.cruisedeals.app".encode("utf-16-le").ljust(256, b"\0")
    type_off = pkg_header_size
    key_off = type_off + len(type_strings)
    pkg_body = type_strings + key_strings + chunks
    pkg = struct.pack("<HHII", 0x0200, pkg_header_size, pkg_header_size + len(pkg_body), 0x7f) + name + \
        struct.pack("<IIIII", type_off, 2, key_off, 2, 0) + pkg_body
    content = values + pkg
    return struct.pack("<HHII", 0x0002, 12, 12 + len(content), 1) + content


def write_aligned(zf, name, data, align=4):
    zi = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
    zi.compress_type = zipfile.ZIP_STORED
    offset = zf.fp.tell() + 30 + len(name.encode())
    pad = (align - offset % align) % align
    zi.extra = b"\0" * pad
    zf.writestr(zi, data)


def main():
    manifest, strings_xml, icon, dex, assets, out = sys.argv[1:7]
    app_name = ET.parse(strings_xml).getroot().find("string[@name='app_name']").text
    with zipfile.ZipFile(out, "w") as zf:
        def deflate(name, data):
            zi = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
            zi.compress_type = zipfile.ZIP_DEFLATED
            zf.writestr(zi, data)
        deflate("AndroidManifest.xml", encode_manifest(manifest))
        write_aligned(zf, "resources.arsc", encode_arsc(app_name, "res/drawable-xxxhdpi-v4/ic_launcher.png"))
        write_aligned(zf, "res/drawable-xxxhdpi-v4/ic_launcher.png", open(icon, "rb").read())
        deflate("classes.dex", open(dex, "rb").read())
        for base, _, files in sorted(os.walk(assets)):
            for f in sorted(files):
                p = os.path.join(base, f)
                deflate("assets/" + os.path.relpath(p, assets).replace(os.sep, "/"), open(p, "rb").read())
    print("wrote", out)


if __name__ == "__main__":
    main()
