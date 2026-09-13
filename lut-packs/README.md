# LUT Packs (downloaded bulk-import sources)

Film-emulation LUTs bulk-downloaded from open-source repositories and bulk-imported
into SnappyDo. These files are NOT consumed at runtime — they were downloaded to
populate the  table. Delete after import if you want to reclaim disk space.

## Sources (5 total, 477 LUTs + 5 built-in = 482 distinct)

| Source | Count | Style |
|--------|------:|-------|
| github.com/YahiaAngelo/Film-Luts | 297 | G-MIC film emulations, B&W + color + instant (MIT) |
| github.com/imnz730/LUTs | 99 | Camera LOG conversions + film looks (Blackmagic/DJI/Sony + Kodak 2383/2393, Fuji 3513) |
| github.com/abpy/FujifilmCameraProfiles | 28 | Fuji X-Trans film simulations (DisplayP3 + sRGB) |
| huggingface.co/datasets/NeoGraph/Luts_Cube | 44 | Cinematic LUTs (FG Cine series + named looks) |
| github.com/efriedman-student/filmic-resolve | 9 | Filmic Resolve contrast LUTs |

## Re-bulk import
Curated uploader: ../scripts/bulk-upload-luts.py
Per-source uploaders (committed alongside):
- bulk-upload-luts.py — YahiaAngelo curated list (~100 distinct)
- bulk-upload-luts3.py — YahiaAngelo all remaining variants
- bulk-upload-luts4.py — imnz730 + abpy
- bulk-upload-luts5.py — filmic-resolve
- bulk-upload-luts6.py — NeoGraph HuggingFace
