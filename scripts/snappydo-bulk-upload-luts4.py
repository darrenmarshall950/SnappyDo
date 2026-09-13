#!/usr/bin/env python3
"""Upload all remaining .cube files from imnz730/LUTs and
abpy/FujifilmCameraProfiles. Each tagged with source repo."""

import os, subprocess, json, time

ROOT = '/home/darren/snappydo/lut-packs'
API = 'http://localhost:3010/api/luts'
JAR = '/tmp/admin.jar'

# Source tags
SOURCES = {
    'imnz730': '(imnz730)',
    'abpy': '(abpy)',
}

# Fetch existing names
res = subprocess.run(['curl', '-sS', '-b', JAR, API], capture_output=True, text=True)
try:
    existing = {l['name'] for l in json.loads(res.stdout)['luts']}
except Exception as e:
    print(f"failed to fetch existing: {e}"); exit(1)
print(f"Already in DB: {len(existing)}")

# Collect all files
all_files = []
for src in SOURCES:
    srcpath = os.path.join(ROOT, src)
    if not os.path.exists(srcpath): continue
    for root, dirs, files in os.walk(srcpath):
        for f in sorted(files):
            if f.endswith('.cube'):
                # tag from subdir under source (e.g. imnz730/Film Looks/Rec709 Kodak 2383 D55.cube)
                rel = os.path.relpath(os.path.join(root, f), srcpath)
                cat = os.path.dirname(rel) or 'root'
                all_files.append((src, cat, os.path.join(root, f)))

print(f"Total files to consider: {len(all_files)}")

ok = skip = fail = 0
fail_list = []

for src, cat, p in all_files:
    base = os.path.basename(p).replace('.cube', '')
    pretty = base.replace('_', ' ').replace('-', ' ').title()
    # Display: e.g. "Kodak 2383 D55 (Film Looks) imnz730"
    cat_label = cat.replace('cube lut', 'cube_lut').replace('provia conversion luts', 'provia_xform').replace(' ', '_')
    display_name = f"{pretty} ({cat_label}) {SOURCES[src]}"

    if display_name in existing:
        skip += 1
        continue

    res = subprocess.run([
        'curl', '-sS', '-b', JAR,
        '-X', 'POST', API,
        '-F', f'file=@{p};filename={os.path.basename(p)}',
        '-F', f'name={display_name}',
    ], capture_output=True, text=True)
    try:
        out = json.loads(res.stdout)
    except:
        fail += 1
        fail_list.append((display_name, res.stdout[:120]))
        continue
    if 'error' in out:
        err = out.get('error', '')
        if any(k in err.lower() for k in ['parse', 'sample', 'lut size', 'cube']):
            skip += 1
        else:
            fail += 1
            fail_list.append((display_name, err[:80]))
            print(f"  FAIL {display_name}: {err}")
    else:
        ok += 1
        existing.add(display_name)
    time.sleep(0.04)
    if ok % 25 == 0 and ok > 0:
        print(f"  ... uploaded {ok} new so far")

print(f"\nDone. New uploaded: {ok}, Skipped: {skip}, Failed: {fail}")
if fail_list:
    print("\nFailures:")
    for n, e in fail_list[:10]:
        print(f"  {n}: {e}")
