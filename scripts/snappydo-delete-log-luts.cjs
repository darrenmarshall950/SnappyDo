const Database = require('better-sqlite3');
const db = new Database('/app/data/snappydo.db');
db.pragma('journal_mode = WAL');

// Categories of imnz730 LUTs to DELETE — LOG/HDR/color-space conversions
// designed for flat log footage, NOT creative looks for photos.
// KEEP Film_Looks (Kodak 2383/2393, Fuji 3513 print stocks).
const DROP = [
    'Astrodesign', 'Blackmagic_Design', 'DCI', 'DJI',
    'HDR_Hybrid_Log-Gamma', 'HDR_ST_2084', 'Panasonic', 'Sony', 'VFX_IO',
];

const all = db.prepare("SELECT id, name FROM luts WHERE name LIKE ?").all('%(imnz730)');
console.log(`Total imnz730 rows: ${all.length}`);

// Match " (CatName) (imnz730)" at end
const re = new RegExp(' \\((' + DROP.join('|') + ')\\) \\(imnz730\\)$');
const dropIds = [];
for (const r of all) {
    if (re.test(r.name)) dropIds.push(r.id);
}
console.log(`Matching LOG categories to drop: ${dropIds.length}`);

console.log('\nSample 8 names that will be DELETED:');
all.filter(r => re.test(r.name)).slice(0, 8).forEach(r => console.log('  ✗ ' + r.name));

console.log('\nSample 4 names that will be KEPT (Film_Looks):');
all.filter(r => !re.test(r.name)).slice(0, 4).forEach(r => console.log('  ✓ ' + r.name));

if (dropIds.length > 0) {
    const placeholders = dropIds.map(() => '?').join(',');
    const result = db.prepare(`DELETE FROM luts WHERE id IN (${placeholders})`).run(...dropIds);
    console.log(`\nDeleted ${result.changes} LOG-conversion LUTs from DB`);
}

db.pragma('wal_checkpoint(TRUNCATE)');

const total = db.prepare('SELECT COUNT(*) AS n FROM luts').get();
const up = db.prepare("SELECT COUNT(*) AS n FROM luts WHERE kind = ?").get('uploaded');
console.log(`\nFinal: ${up.n} uploaded, ${total.n} total`);
