#!/usr/bin/env python3
"""Bulk-upload a curated selection from YahiaAngelo/Film-Luts using
real filenames. Picks ~115 distinct LUTs spanning every category:
B&W, color slide, negative, instant, print, Fuji X-Trans III."""

import os, subprocess, json, time, sys

ROOT = '/home/darren/snappydo/lut-packs'
API = 'http://localhost:3010/api/luts'
JAR = '/tmp/admin.jar'

# Curated: prefer the "neutral" (no +/- suffix) version of each film.
# Add only genuinely distinct looks.
PICK = {
    'bw': [
        'kodak_tri-x_400.cube',
        'ilford_hp_5_plus_400.cube',
        'ilford_delta_100.cube',
        'ilford_delta_3200.cube',
        'ilford_fp_4_plus_125.cube',
        'ilford_pan_f_plus_50.cube',
        'kodak_t-max_400.cube',
        'kodak_t-max_3200.cube',
        'kodak_t-max_100.cube',
        'kodak_bw_400_cn.cube',
        'ilford_xp_2.cube',
        'fuji_neopan_1600.cube',
        'fuji_neopan_acros_100.cube',
        'agfa_apx_100.cube',
        'agfa_apx_25.cube',
        'polaroid_664.cube',
        'polaroid_667.cube',
        'polaroid_672.cube',
        'rollei_retro_80s.cube',
        'rollei_ortho_25.cube',
        'kodak_hie_hs_infra.cube',
    ],
    'colorslide': [
        'kodak_kodachrome_64.cube',
        'kodak_kodachrome_200.cube',
        'kodak_kodachrome_25.cube',
        'fuji_velvia_50.cube',
        'fuji_velvia_100_generic.cube',
        'fuji_astia_100f.cube',
        'fuji_provia_100f.cube',
        'fuji_provia_400f.cube',
        'fuji_sensia_100.cube',
        'kodak_ektachrome_100_vs.cube',
        'kodak_e-100_gx_ektachrome_100.cube',
        'kodak_elite_chrome_200.cube',
        'kodak_elite_chrome_400.cube',
        'lomography_x-pro_slide_200.cube',
        'agfa_precisa_100.cube',
        'fuji_fp_100c.cube',
        'polaroid_polachrome.cube',
    ],
    'negative_new': [
        'kodak_portra_160.cube',
        'kodak_portra_400.cube',
        'kodak_portra_800.cube',
        'kodak_portra_800_hc.cube',
        'kodak_ektar_100.cube',
        'kodak_tmax_3200_alt.cube',
        'kodak_tri-x_400_alt.cube',
        'fuji_400h.cube',
        'fuji_160c.cube',
        'fuji_800z.cube',
    ],
    'negative_old': [
        'fuji_superia_100.cube',
        'fuji_superia_400.cube',
        'fuji_superia_800.cube',
        'fuji_superia_1600.cube',
        'fuji_neopan_1600.cube',
        'ilford_delta_3200.cube',
        'kodak_portra_160_vc.cube',
        'kodak_portra_400_vc.cube',
    ],
    'negative_color': [
        'kodak_ektar_100.cube',
        'kodak_elite_100_xpro.cube',
        'kodak_elite_color_200.cube',
        'kodak_elite_color_400.cube',
        'kodak_portra_160_nc.cube',
        'kodak_portra_160_vc.cube',
        'fuji_superia_200.cube',
        'fuji_superia_hg_1600.cube',
        'fuji_superia_reala_100.cube',
        'fuji_superia_x-tra_800.cube',
        'agfa_ultra_color_100.cube',
        'agfa_vista_200.cube',
        'lomography_redscale_100.cube',
    ],
    'instant_pro': [
        'fuji_fp-100c.cube',
        'fuji_fp-3000b.cube',
        'fuji_fp-3000b_hc.cube',
        'polaroid_665.cube',
        'polaroid_665_negative.cube',
        'polaroid_669.cube',
        'polaroid_690.cube',
    ],
    'instant_consumer': [
        'polaroid_px-100uv+_cold.cube',
        'polaroid_px-100uv+_warm.cube',
        'polaroid_px-680.cube',
        'polaroid_px-680_cold.cube',
        'polaroid_px-680_warm.cube',
        'polaroid_px-70.cube',
        'polaroid_px-70_cold.cube',
        'polaroid_px-70_warm.cube',
        'polaroid_time_zero_expired.cube',
    ],
    'print': [
        'fuji_3510_constlclip.cube',
        'fuji_3510_constlmap.cube',
        'fuji_3513_constlclip.cube',
        'kodak_2383_constlclip.cube',
        'kodak_2383_constlmap.cube',
        'kodak_2393_constlclip.cube',
        'kodak_2393_constlmap.cube',
    ],
    'fujixtransiii': [
        'fuji_xtrans_iii_classic_chrome.cube',
        'fuji_xtrans_iii_astia.cube',
        'fuji_xtrans_iii_velvia.cube',
        'fuji_xtrans_iii_provia.cube',
        'fuji_xtrans_iii_acros.cube',
        'fuji_xtrans_iii_pro_neg_hi.cube',
        'fuji_xtrans_iii_pro_neg_std.cube',
        'fuji_xtrans_iii_sepia.cube',
    ],
}

# Build paths
all_paths = []
missing = []
for cat, files in PICK.items():
    for f in files:
        p = os.path.join(ROOT, cat, f)
        if not os.path.exists(p):
            missing.append(p)
            continue
        all_paths.append((p, cat))

if missing:
    print(f"MISSING ({len(missing)}):")
    for m in missing[:20]:
        print(f"  {m}")
print(f"\nUploading {len(all_paths)} LUTs...\n", flush=True)

ok = 0
fail = 0
fail_list = []
uploaded_names = []

for p, cat in all_paths:
    base = os.path.basename(p).replace('.cube', '')
    # Title-case the name, keep dots/hyphens
    pretty = base.replace('_', ' ').replace('-', ' ').title()
    display_name = f"{pretty} ({cat})"

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
        if 'parse' in err.lower() or 'LUT' in err or 'sample' in err.lower():
            fail += 1
            fail_list.append((base, err[:80]))
            print(f"  FAIL {display_name}: {err}")
        else:
            fail += 1
            fail_list.append((base, err[:80]))
            print(f"  FAIL {display_name}: {err}")
    else:
        ok += 1
        uploaded_names.append(display_name)
    time.sleep(0.04)

print(f"\nDone. OK={ok}, failed={fail}")
print(f"\nUploaded ({len(uploaded_names)}):")
for n in uploaded_names:
    print(f"  ✓ {n}")
