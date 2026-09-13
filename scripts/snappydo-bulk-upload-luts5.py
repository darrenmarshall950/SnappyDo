#!/usr/bin/env python3
"""Upload all .cube files from filmic-resolve and remaining untagged files."""

import os, subprocess, json, time, sys

ROOT = '/home/darren/snappydo/lut-packs'
API = 'http://localhost:3010/api/luts'
JAR = '/tmp/admin.jar'

res = subprocess.run(['curl', '-sS', '-b', JAR, API], capture_output=True, text=True)
existing = {l['name'] for l in json.loads(res.stdout)['luts']}
print(f"Already in DB: {len(existing)}")

# Upload from filmic-resolve
src = 'filmic-resolve'
srcpath = os.path.join(ROOT, src)
files = sorted([f for f in os.listdir(srcpath) if f.endswith('.cube')])
print(f"filmic-resolve: {len(files)} files")

ok = skip = fail = 0
fail_list = []

for f in files:
    p = os.path.join(srcpath, f)
    base = f.replace('.cube', '')
    pretty = base.replace('_', ' ').replace('-', ' ').title()
    display_name = f"{pretty} (filmic-resolve)"

    if display_name in existing:
        skip += 1
        continue

    res = subprocess.run([
        'curl', '-sS', '-b', JAR,
        '-X', 'POST', API,
        '-F', f'file=@{p};filename={f}',
        '-F', f'name={display_name}',
    ], capture_output=True, text=True)
    try:
        out = json.loads(res.stdout)
    except:
        fail += 1; fail_list.append((display_name, res.stdout[:120])); continue
    if 'error' in out:
        err = out.get('error', '')
        if any(k in err.lower() for k in ['parse', 'sample', 'lut size', 'cube', 'dimension', 'range']):
            skip += 1
        else:
            fail += 1
            fail_list.append((display_name, err[:80]))
            print(f"  FAIL {display_name}: {err}")
    else:
        ok += 1
        existing.add(display_name)
    time.sleep(0.05)

print(f"\nDone filmic-resolve. New: {ok}, Skipped: {skip}, Failed: {fail}")
if fail_list:
    print("\nFailures:")
    for n,e in fail_list: print(f"  {n}: {e}")
