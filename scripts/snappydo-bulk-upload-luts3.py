#!/usr/bin/env python3
"""Upload ALL remaining .cube files from YahiaAngelo/Film-Luts that
weren't in the curated first pass. Every remaining variant (warm/cold,
+/-/++/+++, pushed/expired/HC) becomes its own distinct look.

Compare against luts already in DB by exact name, skip if present."""

import os, subprocess, json, time

ROOT = '/home/darren/snappydo/lut-packs'
API = 'http://localhost:3010/api/luts'
JAR = '/tmp/admin.jar'

# 1. Get existing LUT names from API
res = subprocess.run(['curl', '-sS', JAR.replace('/tmp/admin.jar', ''), API],
                     capture_output=True, text=True, env={'PATH':'/usr/bin'})
# Need a way to get cookie... simpler: just call from SSH or use the jar
res = subprocess.run(['curl', '-sS', '-b', JAR, API], capture_output=True, text=True)
try:
    existing = {l['name'] for l in json.loads(res.stdout)['luts']}
except Exception as e:
    print(f"failed to fetch existing: {e}"); exit(1)
print(f"Already in DB: {len(existing)}")

# 2. Walk all .cube files
all_files = []
for cat in sorted(os.listdir(ROOT)):
    catpath = os.path.join(ROOT, cat)
    if not os.path.isdir(catpath): continue
    for f in sorted(os.listdir(catpath)):
        if f.endswith('.cube'):
            all_files.append((cat, os.path.join(catpath, f)))
print(f"Total .cube files on disk: {len(all_files)}")

ok = skip = fail = 0
skip_missing = []
fail_list = []
new_count = 0

for cat, p in all_files:
    base = os.path.basename(p).replace('.cube', '')
    # Match naming: "Kodak Portra 400 (" + category + ")" with title-case
    pretty = base.replace('_', ' ').replace('-', ' ').title()
    display_name = f"{pretty} ({cat})"

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
        fail_list.append((base, res.stdout[:120]))
        continue
    if 'error' in out:
        err = out.get('error', '')
        # tolerate "LUT_*" and similar parse errors silently
        if any(k in err.lower() for k in ['parse', 'sample', 'lut size', 'cube']):
            skip += 1
            skip_missing.append((display_name, err))
        else:
            fail += 1
            fail_list.append((display_name, err[:80]))
    else:
        ok += 1
        new_count += 1
        existing.add(display_name)
    time.sleep(0.03)
    if new_count % 20 == 0 and new_count > 0:
        print(f"  ... uploaded {new_count} new so far")

print(f"\nDone. New uploaded: {ok}, Skipped (existing/parse): {skip+len(skip_missing)}, Failed: {fail}")
if skip_missing:
    print(f"\nParse-failed ({len(skip_missing)}):")
    for n, e in skip_missing[:10]:
        print(f"  {n}: {e}")
if fail_list:
    print(f"\nFailures ({len(fail_list)}):")
    for n, e in fail_list[:10]:
        print(f"  {n}: {e}")
