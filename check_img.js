const Database = require('better-sqlite3');
const db = new Database('/home/darren/snappydo/_test/db.sqlite', { readonly: true });
const row = db.prepare('SELECT id, filename, mime_type, raw_format FROM images WHERE id = 489').get();
console.log('image 489:', row);

const all = db.prepare("SELECT id, filename, mime_type, raw_format FROM images WHERE raw_format IS NOT NULL LIMIT 10").all();
console.log('RAW images:', all);

// count all
const cnt = db.prepare("SELECT COUNT(*) as c FROM images").get();
console.log('total:', cnt.c);
const rawCnt = db.prepare("SELECT COUNT(*) as c FROM images WHERE raw_format IS NOT NULL").get();
console.log('RAW count:', rawCnt.c);
