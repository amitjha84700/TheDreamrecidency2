'use strict';
const express    = require('express');
const session    = require('express-session');
const multer     = require('multer');
const nodemailer = require('nodemailer');
const path       = require('path');
const fs         = require('fs');

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 5000;
const IS_PG = !!process.env.DATABASE_URL;

// ─── Upload directory ─────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── Admin credentials ────────────────────────────────────────────────────────
const ADMIN_USER = 'Harsh@2003';
const ADMIN_PASS = 'Dream@2010';

// ─────────────────────────────────────────────────────────────────────────────
//  UNIFIED DATABASE LAYER
//  • IS_PG=true  → PostgreSQL  (any host with DATABASE_URL set)
//  • IS_PG=false → SQLite      (local development, data.db)
// ─────────────────────────────────────────────────────────────────────────────
let db;   // set by initDb()
let pgPool = null;

function buildDb() {
  if (IS_PG) {
    const { Pool } = require('pg');
    pgPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Convert ?-style placeholders to $1,$2,… for PostgreSQL
    function pgSql(sql) {
      let i = 0;
      return sql.replace(/\?/g, () => `$${++i}`);
    }

    function flatParams(p) {
      return (p.length === 1 && Array.isArray(p[0])) ? p[0] : p;
    }

    return {
      type: 'pg',
      pool: pgPool,
      async run(sql, params = []) {
        let s = pgSql(sql);
        if (/^\s*INSERT\s/i.test(s) && !/RETURNING/i.test(s)) s += ' RETURNING *';
        const r = await pgPool.query(s, flatParams(params));
        return { lastInsertRowid: r.rows[0]?.id ?? null, changes: r.rowCount };
      },
      async get(sql, params = []) {
        const r = await pgPool.query(pgSql(sql), flatParams(params));
        return r.rows[0] ?? null;
      },
      async all(sql, params = []) {
        const r = await pgPool.query(pgSql(sql), flatParams(params));
        return r.rows;
      },
      // exec() splits on semicolons and runs statements one by one
      async exec(sql) {
        const stmts = sql
          .split(/;\s*(?=(?:[^']*'[^']*')*[^']*$)/)
          .map(s => s.trim())
          .filter(Boolean);
        for (const s of stmts) await pgPool.query(s);
      },
      // prepare() returns an object with run/get/all that are async
      prepare(sql) {
        const self = this;
        return {
          run: (...p) => self.run(sql, flatParams(p)),
          get: (...p) => self.get(sql, flatParams(p)),
          all: (...p) => self.all(sql, flatParams(p)),
        };
      },
      // Date-diff helper: returns (col2 - col1) in whole days
      dateDiff(col1, col2) {
        return `(${col2}::date - ${col1}::date)::integer`;
      },
    };
  } else {
    // ── SQLite mode ──────────────────────────────────────────────────────────
    const Database = require('better-sqlite3');
    const dbPath = process.env.DB_PATH || path.join(__dirname, 'data.db');
    const sdb = new Database(dbPath);
    sdb.pragma('journal_mode = WAL');

    function flatParams(p) {
      return (p.length === 1 && Array.isArray(p[0])) ? p[0] : p;
    }

    return {
      type: 'sqlite',
      _sdb: sdb,
      async run(sql, params = []) {
        const r = sdb.prepare(sql).run(...flatParams(params));
        return { lastInsertRowid: r.lastInsertRowid, changes: r.changes };
      },
      async get(sql, params = []) {
        return sdb.prepare(sql).get(...flatParams(params)) ?? null;
      },
      async all(sql, params = []) {
        return sdb.prepare(sql).all(...flatParams(params));
      },
      async exec(sql) {
        sdb.exec(sql);
      },
      prepare(sql) {
        const self = this;
        return {
          run: (...p) => self.run(sql, flatParams(p)),
          get: (...p) => self.get(sql, flatParams(p)),
          all: (...p) => self.all(sql, flatParams(p)),
        };
      },
      dateDiff(col1, col2) {
        return `CAST(julianday(${col2}) - julianday(${col1}) AS INTEGER)`;
      },
    };
  }
}

// ─── Schema: PostgreSQL tables ────────────────────────────────────────────────
const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id          SERIAL PRIMARY KEY,
  number      TEXT NOT NULL UNIQUE,
  category    TEXT NOT NULL,
  price       FLOAT8 NOT NULL,
  status      TEXT NOT NULL DEFAULT 'available',
  description TEXT,
  image       TEXT,
  features    TEXT
);
CREATE TABLE IF NOT EXISTS customers (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  contact    TEXT,
  email      TEXT,
  id_proof   TEXT,
  document   TEXT,
  address    TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bookings (
  id           SERIAL PRIMARY KEY,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  room_id      INTEGER NOT NULL REFERENCES rooms(id),
  check_in     TEXT NOT NULL,
  check_out    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'booked',
  total        FLOAT8,
  guests       INTEGER DEFAULT 1,
  guest_details TEXT,
  rooms_count  INTEGER DEFAULT 1,
  room_type    TEXT,
  room_number  TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS site_content (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS booking_documents (
  id            SERIAL PRIMARY KEY,
  booking_id    INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  customer_id   INTEGER,
  doc_type      TEXT,
  file_path     TEXT NOT NULL,
  original_name TEXT,
  guest_index   INTEGER DEFAULT 0,
  guest_name    TEXT,
  uploaded_at   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS booking_requests (
  id             SERIAL PRIMARY KEY,
  name           TEXT NOT NULL,
  phone          TEXT NOT NULL,
  country_code   TEXT,
  email          TEXT,
  check_in       TEXT NOT NULL,
  check_out      TEXT NOT NULL,
  guests         INTEGER DEFAULT 1,
  room_type      TEXT,
  message        TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  guest_details  TEXT,
  rooms_required INTEGER DEFAULT 1,
  address        TEXT,
  created_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payments (
  id         SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  amount     FLOAT8 NOT NULL,
  method     TEXT NOT NULL DEFAULT 'cash',
  type       TEXT NOT NULL DEFAULT 'advance',
  notes      TEXT,
  paid_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id);
CREATE TABLE IF NOT EXISTS visitors (
  id          SERIAL PRIMARY KEY,
  visitor_id  TEXT UNIQUE NOT NULL,
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  first_seen  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  last_seen   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  visit_count INTEGER DEFAULT 1,
  ip          TEXT,
  user_agent  TEXT
);
CREATE TABLE IF NOT EXISTS visits (
  id         SERIAL PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  path       TEXT,
  ip         TEXT,
  user_agent TEXT,
  referrer   TEXT,
  visited_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_visits_vid      ON visits(visitor_id);
CREATE INDEX IF NOT EXISTS idx_visitors_phone  ON visitors(phone);
CREATE INDEX IF NOT EXISTS idx_visitors_email  ON visitors(email);
CREATE INDEX IF NOT EXISTS idx_customers_contact ON customers(contact);
CREATE INDEX IF NOT EXISTS idx_customers_email   ON customers(email);
CREATE TABLE IF NOT EXISTS room_types (
  id            SERIAL PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  image         TEXT,
  short_desc    TEXT,
  description   TEXT,
  features      TEXT,
  price         FLOAT8 DEFAULT 0,
  display_order INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS "session" (
  sid    VARCHAR NOT NULL COLLATE "default",
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);
CREATE INDEX IF NOT EXISTS idx_session_expire ON "session"(expire);
`;

// ─── Schema: SQLite tables ─────────────────────────────────────────────────────
const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS rooms (
  id          INTEGER PRIMARY KEY,
  number      TEXT NOT NULL UNIQUE,
  category    TEXT NOT NULL,
  price       REAL NOT NULL,
  status      TEXT NOT NULL DEFAULT 'available',
  description TEXT,
  image       TEXT,
  features    TEXT
);
CREATE TABLE IF NOT EXISTS customers (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  contact    TEXT,
  email      TEXT,
  id_proof   TEXT,
  document   TEXT,
  address    TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS bookings (
  id           INTEGER PRIMARY KEY,
  customer_id  INTEGER NOT NULL,
  room_id      INTEGER NOT NULL,
  check_in     TEXT NOT NULL,
  check_out    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'booked',
  total        REAL,
  guests       INTEGER DEFAULT 1,
  guest_details TEXT,
  rooms_count  INTEGER DEFAULT 1,
  room_type    TEXT,
  room_number  TEXT,
  notes        TEXT,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(customer_id) REFERENCES customers(id),
  FOREIGN KEY(room_id) REFERENCES rooms(id)
);
CREATE TABLE IF NOT EXISTS site_content (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS booking_documents (
  id            INTEGER PRIMARY KEY,
  booking_id    INTEGER NOT NULL,
  customer_id   INTEGER,
  doc_type      TEXT,
  file_path     TEXT NOT NULL,
  original_name TEXT,
  guest_index   INTEGER DEFAULT 0,
  guest_name    TEXT,
  uploaded_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS booking_requests (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  phone          TEXT NOT NULL,
  country_code   TEXT,
  email          TEXT,
  check_in       TEXT NOT NULL,
  check_out      TEXT NOT NULL,
  guests         INTEGER DEFAULT 1,
  room_type      TEXT,
  message        TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  guest_details  TEXT,
  rooms_required INTEGER DEFAULT 1,
  address        TEXT,
  created_at     TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payments (
  id         INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL,
  amount     REAL NOT NULL,
  method     TEXT NOT NULL DEFAULT 'cash',
  type       TEXT NOT NULL DEFAULT 'advance',
  notes      TEXT,
  paid_at    TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(booking_id) REFERENCES bookings(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_payments_booking    ON payments(booking_id);
CREATE TABLE IF NOT EXISTS visitors (
  id          INTEGER PRIMARY KEY,
  visitor_id  TEXT UNIQUE NOT NULL,
  name        TEXT,
  email       TEXT,
  phone       TEXT,
  first_seen  TEXT DEFAULT CURRENT_TIMESTAMP,
  last_seen   TEXT DEFAULT CURRENT_TIMESTAMP,
  visit_count INTEGER DEFAULT 1,
  ip          TEXT,
  user_agent  TEXT
);
CREATE TABLE IF NOT EXISTS visits (
  id         INTEGER PRIMARY KEY,
  visitor_id TEXT NOT NULL,
  path       TEXT,
  ip         TEXT,
  user_agent TEXT,
  referrer   TEXT,
  visited_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_visits_vid        ON visits(visitor_id);
CREATE INDEX IF NOT EXISTS idx_visitors_phone    ON visitors(phone);
CREATE INDEX IF NOT EXISTS idx_visitors_email    ON visitors(email);
CREATE INDEX IF NOT EXISTS idx_customers_contact ON customers(contact);
CREATE INDEX IF NOT EXISTS idx_customers_email   ON customers(email);
CREATE TABLE IF NOT EXISTS room_types (
  id            INTEGER PRIMARY KEY,
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  image         TEXT,
  short_desc    TEXT,
  description   TEXT,
  features      TEXT,
  price         REAL DEFAULT 0,
  display_order INTEGER DEFAULT 0
);
`;

// ─── Add column if missing (DB-aware) ─────────────────────────────────────────
async function addColumnIfMissing(table, column, ddl) {
  if (IS_PG) {
    const r = await db.get(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = $1 AND column_name = $2`,
      [table, column]
    );
    if (!r) await db.exec(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${ddl}`);
  } else {
    const cols = await db.all(`PRAGMA table_info(${table})`);
    if (!cols.find(c => c.name === column)) {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }
}

// ─── Seed room types ───────────────────────────────────────────────────────────
async function seedRoomTypes() {
  const row = await db.get('SELECT COUNT(*) AS c FROM room_types');
  const count = IS_PG ? parseInt(row.c) : row.c;
  if (count > 0) return;

  const insConflict = 'INSERT INTO room_types (slug, name, image, short_desc, description, features, price, display_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(slug) DO NOTHING';
  await db.run(insConflict, ['suite', 'Suite', 'img/room-suite.jpg', 'Spacious luxury suite with living area', 'Our Suite offers an expansive layout with a separate living area, premium furnishings, and panoramic views. Perfect for extended stays, special celebrations, and discerning guests who appreciate fine detail.', 'King-size Bed, Separate Living Area, Smart TV, Mini Bar, City View, Premium Toiletries, 24x7 Room Service', 8000, 1]);
  await db.run(insConflict, ['deluxe', 'Deluxe', 'img/room-deluxe.jpg', 'Elegant deluxe room with modern comfort', 'The Deluxe room blends modern comfort with timeless elegance. Spacious enough to relax, refined enough to remember — ideal for couples or business travellers.', 'Queen-size Bed, Work Desk, Smart TV, Tea/Coffee Maker, Air Conditioning, Premium Linens, Free Wi-Fi, Daily Housekeeping', 5000, 2]);
  await db.run(insConflict, ['twin', 'Twin Bed', 'img/twin-enhanced.png', 'Twin bed room ideal for friends or family', 'The Twin Bed room features two well-appointed single beds, perfect for friends, colleagues, or families travelling together. Bright, airy, and thoughtfully designed.', 'Two Single Beds, Smart TV, Tea/Coffee Maker, Air Conditioning, Free Wi-Fi, Wardrobe, Daily Housekeeping', 3500, 3]);
}

// ─── Default site content ─────────────────────────────────────────────────────
const DEFAULTS = {
  hotel_name:            'The Dream Residency',
  tagline:               'A Boutique Stay of Elegance & Comfort',
  about:                 'Welcome to The Dream Residency — a premium boutique hotel offering modern rooms, fine dining, and personalized hospitality. Whether you are visiting for business, leisure, or a special celebration, our dedicated team ensures every moment of your stay is memorable.',
  hero_image:            'img/lobby.png',
  about_image:           'img/collage.png',
  dining_text:           'Savour authentic flavours at our in-house restaurant. From traditional Indian cuisine to continental favourites, our chefs craft every dish with care, using the freshest seasonal ingredients.',
  dining_image:          '',
  amenities:             'Free Wi-Fi, 24x7 Room Service, Restaurant, Power Backup, Laundry, Travel Desk',
  phone:                 '+91 00000 00000',
  phone2:                '',
  email:                 'contact@dreamresidency.com',
  address:               'Your address here',
  admin_email:           process.env.ADMIN_EMAIL    || 'doremon69sizuka@gmail.com',
  smtp_host:             process.env.SMTP_HOST      || 'smtp.gmail.com',
  smtp_port:             process.env.SMTP_PORT      || '587',
  smtp_user:             process.env.SMTP_USER      || 'doremon69sizuka@gmail.com',
  smtp_pass:             process.env.SMTP_PASS      || 'ljxl ihtv voan xtxe',
  smtp_from_name:        process.env.SMTP_FROM_NAME || 'The Dream Residency',
  document_storage_path: './uploads/customer_documents',
  default_checkin_time:  '11:00',
};

async function initDefaults() {
  for (const [k, v] of Object.entries(DEFAULTS)) {
    await db.run(
      'INSERT INTO site_content (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
      [k, v ?? '']
    );
  }
  // Backfill env vars over blank rows (covers existing DBs on fresh deploys)
  const envMap = {
    smtp_host:      process.env.SMTP_HOST,
    smtp_port:      process.env.SMTP_PORT,
    smtp_user:      process.env.SMTP_USER,
    smtp_pass:      process.env.SMTP_PASS,
    smtp_from_name: process.env.SMTP_FROM_NAME,
    admin_email:    process.env.ADMIN_EMAIL,
  };
  for (const [k, v] of Object.entries(envMap)) {
    if (v && v.trim()) {
      await db.run(
        "INSERT INTO site_content (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value",
        [k, v.trim()]
      );
    }
  }
  // Ensure SMTP/image defaults are never blank
  const blankFills = [
    ['smtp_host',      'smtp.gmail.com'],
    ['smtp_port',      '587'],
    ['smtp_user',      'doremon69sizuka@gmail.com'],
    ['smtp_pass',      'ljxl ihtv voan xtxe'],
    ['admin_email',    'doremon69sizuka@gmail.com'],
    ['smtp_from_name', 'The Dream Residency'],
    ['hero_image',     'img/lobby.png'],
    ['about_image',    'img/collage.png'],
  ];
  for (const [k, v] of blankFills) {
    await db.run(
      "UPDATE site_content SET value=? WHERE key=? AND (value IS NULL OR value='')",
      [v, k]
    );
  }
  // Ensure room type images never blank
  await db.run("UPDATE room_types SET image='img/room-suite.jpg'    WHERE slug='suite'  AND (image IS NULL OR image='')");
  await db.run("UPDATE room_types SET image='img/room-deluxe.jpg'   WHERE slug='deluxe' AND (image IS NULL OR image='')");
  await db.run("UPDATE room_types SET image='img/twin-enhanced.png' WHERE slug='twin'   AND (image IS NULL OR image='')");
  // Ensure room type prices are set
  await db.run("UPDATE room_types SET price=8000 WHERE slug='suite'  AND (price IS NULL OR price=0)");
  await db.run("UPDATE room_types SET price=5000 WHERE slug='deluxe' AND (price IS NULL OR price=0)");
  await db.run("UPDATE room_types SET price=3500 WHERE slug='twin'   AND (price IS NULL OR price=0)");
}

// ─────────────────────────────────────────────────────────────────────────────
//  HELPER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────
async function getSetting(key, fallback = '') {
  const r = await db.get('SELECT value FROM site_content WHERE key=?', [key]);
  return (r && r.value) || fallback;
}
async function setSetting(key, value) {
  await db.run(
    'INSERT INTO site_content (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
    [key, String(value ?? '')]
  );
}

function resolveDocStorage() {
  let p = './uploads/customer_documents';
  if (!path.isAbsolute(p)) p = path.join(__dirname, p);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

const SMTP_PROVIDERS = {
  'gmail.com':       { host: 'smtp.gmail.com',        port: 587 },
  'googlemail.com':  { host: 'smtp.gmail.com',        port: 587 },
  'outlook.com':     { host: 'smtp.office365.com',    port: 587 },
  'hotmail.com':     { host: 'smtp.office365.com',    port: 587 },
  'live.com':        { host: 'smtp.office365.com',    port: 587 },
  'office365.com':   { host: 'smtp.office365.com',    port: 587 },
  'yahoo.com':       { host: 'smtp.mail.yahoo.com',   port: 587 },
  'yahoo.co.in':     { host: 'smtp.mail.yahoo.com',   port: 587 },
  'yahoo.in':        { host: 'smtp.mail.yahoo.com',   port: 587 },
  'zoho.com':        { host: 'smtp.zoho.com',         port: 587 },
  'zoho.in':         { host: 'smtp.zoho.in',          port: 587 },
  'icloud.com':      { host: 'smtp.mail.me.com',      port: 587 },
  'me.com':          { host: 'smtp.mail.me.com',      port: 587 },
};
function detectSmtp(email) {
  if (!email || !email.includes('@')) return null;
  const dom = email.split('@')[1].toLowerCase().trim();
  return SMTP_PROVIDERS[dom] || null;
}

function normalizeImageUrl(u) {
  if (!u) return u;
  let s = String(u).trim();
  let m = s.match(/drive\.google\.com\/file\/d\/([^/?#]+)/);
  if (m) return `https://drive.google.com/uc?export=view&id=${m[1]}`;
  m = s.match(/drive\.google\.com\/open\?id=([^&]+)/);
  if (m) return `https://drive.google.com/uc?export=view&id=${m[1]}`;
  if (s.includes('dropbox.com') && !/[?&]raw=1/.test(s)) {
    s = s.replace(/[?&]dl=\d/, '');
    s += (s.includes('?') ? '&' : '?') + 'raw=1';
  }
  return s;
}

async function findRoomType(idOrSlug) {
  if (!idOrSlug) return null;
  const s = String(idOrSlug).toLowerCase().trim();
  if (/^\d+$/.test(s)) {
    return await db.get('SELECT * FROM room_types WHERE id=?', [Number(s)]);
  }
  return await db.get('SELECT * FROM room_types WHERE slug=? OR LOWER(name)=? LIMIT 1', [s, s]);
}

function rtToPublic(rt) {
  if (!rt) return null;
  const featArr = String(rt.features || '').split(/\r?\n|,/).map(s => s.trim()).filter(Boolean);
  return {
    id: rt.id, slug: rt.slug, category: rt.slug, name: rt.name,
    image: rt.image || '', short_desc: rt.short_desc || '',
    description: rt.description || '', features: featArr,
    price: rt.price || 0, display_order: rt.display_order || 0,
  };
}

function computeTotal({ check_in, check_out, room_price, rooms_count }) {
  const ci = new Date(check_in), co = new Date(check_out);
  const nights = Math.max(1, Math.round((co - ci) / 86400000));
  return nights * (parseFloat(room_price) || 0) * Math.max(1, parseInt(rooms_count) || 1);
}

function buildConfirmationEmail({ hotelName, checkinTime, hotelPhone, hotelAddress, name, bookingId, roomType, checkIn, checkOut, nights, guests, total }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f0ede8;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0ede8;padding:30px 0;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:4px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.10);">
      <tr><td style="background:#1a3a5c;padding:32px 36px;text-align:center;">
        <h1 style="color:#c9a96e;margin:0;font-size:26px;letter-spacing:2px;">${hotelName}</h1>
        <p style="color:#a8c4d8;margin:6px 0 0;font-size:11px;letter-spacing:4px;text-transform:uppercase;">BOOKING CONFIRMED</p>
      </td></tr>
      <tr><td style="padding:32px 36px;">
        <p style="margin:0 0 18px;color:#374151;font-size:15px;">Dear <strong>${name}</strong>,</p>
        <p style="margin:0 0 24px;color:#555;font-size:14px;line-height:1.7;">We're delighted to confirm your reservation. We look forward to welcoming you to ${hotelName}.</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="background:#1e2d3d;border-radius:4px;overflow:hidden;margin-bottom:24px;">
          <tr><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#7a9bb5;">BOOKING NO.</td><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;color:#c9a96e;font-weight:700;font-size:16px;">#${bookingId}</td></tr>
          <tr><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#7a9bb5;">ROOM TYPE</td><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;color:#ffffff;font-size:14px;">${roomType}</td></tr>
          <tr><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#7a9bb5;">CHECK-IN</td><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;color:#ffffff;font-size:14px;">${checkIn} · ${checkinTime}</td></tr>
          <tr><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#7a9bb5;">CHECK-OUT</td><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;color:#ffffff;font-size:14px;">${checkOut} (${nights} night${nights>1?'s':''})</td></tr>
          <tr><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#7a9bb5;">GUESTS</td><td style="padding:12px 18px;border-bottom:1px solid #2d3f50;color:#ffffff;font-size:14px;">${guests}</td></tr>
          <tr><td style="padding:12px 18px;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:#c9a96e;">TOTAL AMOUNT</td><td style="padding:12px 18px;color:#c9a96e;font-weight:700;font-size:18px;">&#8377;${total.toLocaleString('en-IN')}</td></tr>
        </table>
        <p style="margin:0 0 18px;color:#555;font-size:13px;line-height:1.6;">Please carry your original photo ID (Aadhar/Passport) for check-in.</p>
        <div style="background:#f9f6f0;border:1px solid #e8dec5;border-radius:4px;padding:16px 18px;margin-bottom:20px;">
          <strong style="color:#1a3a5c;font-size:13px;">Contact Us</strong><br>
          <span style="color:#555;font-size:13px;">&#128222; ${hotelPhone}</span><br>
          <span style="color:#555;font-size:13px;">&#128205; ${hotelAddress}</span>
        </div>
        <p style="margin:0 0 6px;color:#555;font-size:13px;line-height:1.6;">If you have any questions, please don't hesitate to contact us.</p>
        <p style="margin:18px 0 0;color:#1a3a5c;font-size:13px;"><em>Warm regards,</em><br><strong>${hotelName}</strong></p>
      </td></tr>
      <tr><td style="background:#1a3a5c;padding:16px 36px;text-align:center;">
        <p style="margin:0;color:#7a9bb5;font-size:11px;">This is an automated confirmation email. Please do not reply.</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

async function sendMail({ to, subject, html, text }) {
  const host = await getSetting('smtp_host');
  const user = await getSetting('smtp_user');
  const pass = await getSetting('smtp_pass');
  if (!host || !user || !pass) return { sent: false, reason: 'SMTP not configured.' };
  const port = parseInt(await getSetting('smtp_port', '587'));
  const transporter = nodemailer.createTransport({
    host, port, secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false },
  });
  const fromName = await getSetting('smtp_from_name', 'The Dream Residency');
  const adminCc  = await getSetting('admin_email') || null;
  const mailOpts = { from: `"${fromName}" <${user}>`, to, subject, text, html };
  if (adminCc && adminCc !== user) mailOpts.cc = adminCc;
  await transporter.sendMail(mailOpts);
  return { sent: true };
}

// ─────────────────────────────────────────────────────────────────────────────
//  STARTUP — initialize DB, schema, seeds, defaults, then start Express
// ─────────────────────────────────────────────────────────────────────────────
async function startServer() {
  // 1. Build DB connection
  db = buildDb();

  // 2. Create tables
  await db.exec(IS_PG ? PG_SCHEMA : SQLITE_SCHEMA);

  // 3. Add any missing columns (migrations for existing databases)
  const migrations = [
    ['rooms',            'image',         'TEXT'],
    ['rooms',            'features',      'TEXT'],
    ['bookings',         'guests',        IS_PG ? 'INTEGER DEFAULT 1'  : 'INTEGER DEFAULT 1'],
    ['bookings',         'guest_details', 'TEXT'],
    ['bookings',         'rooms_count',   IS_PG ? 'INTEGER DEFAULT 1'  : 'INTEGER DEFAULT 1'],
    ['bookings',         'room_type',     'TEXT'],
    ['bookings',         'room_number',   'TEXT'],
    ['bookings',         'notes',         'TEXT'],
    ['booking_requests', 'guest_details', 'TEXT'],
    ['booking_requests', 'rooms_required',IS_PG ? 'INTEGER DEFAULT 1'  : 'INTEGER DEFAULT 1'],
    ['booking_requests', 'country_code',  'TEXT'],
    ['booking_requests', 'address',       'TEXT'],
    ['booking_documents','guest_index',   IS_PG ? 'INTEGER DEFAULT 0'  : 'INTEGER DEFAULT 0'],
    ['booking_documents','guest_name',    'TEXT'],
    ['room_types',       'price',         IS_PG ? 'FLOAT8 DEFAULT 0'   : 'REAL DEFAULT 0'],
    ['customers',        'address',       'TEXT'],
  ];
  for (const [table, col, ddl] of migrations) {
    await addColumnIfMissing(table, col, ddl);
  }

  // 4. Seed + defaults
  await seedRoomTypes();
  await initDefaults();

  // ── Express setup ─────────────────────────────────────────────────────────
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(require('cookie-parser')());

  // Session store: PostgreSQL or SQLite
  let sessionStore;
  if (IS_PG) {
    const PgSession = require('connect-pg-simple')(session);
    sessionStore = new PgSession({ pool: pgPool, tableName: 'session', createTableIfMissing: false });
  } else {
    const SqliteStore = require('better-sqlite3-session-store')(session);
    sessionStore = new SqliteStore({ client: db._sdb, expired: { clear: true, intervalMs: 900000 } });
  }

  app.use(session({
    store: sessionStore,
    secret: process.env.SESSION_SECRET || 'dream-residency-stable-secret-2024',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 },
  }));

  // Visitor cookie middleware
  app.use(function ensureVisitorCookie(req, res, next) {
    let vid = req.cookies && req.cookies.dr_vid;
    if (!vid) {
      vid = 'v_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      res.cookie('dr_vid', vid, { httpOnly: false, maxAge: 1000*60*60*24*365*2, sameSite: 'lax' });
    }
    req.visitorId = vid;
    next();
  });

  app.use('/uploads', express.static(UPLOAD_DIR));
  app.use(express.static(path.join(__dirname, 'public')));

  const storage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (_, file, cb) => {
      const safe = file.originalname.replace(/[^a-z0-9.\-_]/gi, '_');
      cb(null, Date.now() + '_' + safe);
    },
  });
  const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

  function requireAdmin(req, res, next) {
    if (req.session && req.session.admin) return next();
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // ── AUTH ──────────────────────────────────────────────────────────────────
  app.post('/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (username === ADMIN_USER && password === ADMIN_PASS) {
      req.session.admin = true;
      return res.json({ ok: true });
    }
    res.status(401).json({ error: 'Invalid credentials' });
  });
  app.post('/api/logout', (req, res) => { req.session.destroy(() => res.json({ ok: true })); });
  app.get('/api/me', (req, res) => res.json({ admin: !!(req.session && req.session.admin) }));

  // ── SITE CONTENT ──────────────────────────────────────────────────────────
  app.get('/api/content', async (_, res) => {
    try {
      const rows = await db.all('SELECT key, value FROM site_content');
      const out = {};
      rows.forEach(r => { out[r.key] = r.value; });
      res.json(out);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/content', requireAdmin, async (req, res) => {
    try {
      const body = req.body || {};
      const probeEmail = body.smtp_user || body.admin_email || '';
      const detected = detectSmtp(probeEmail);
      if (detected) {
        const curHost = (body.smtp_host !== undefined ? body.smtp_host : await getSetting('smtp_host')) || '';
        const curPort = (body.smtp_port !== undefined ? body.smtp_port : await getSetting('smtp_port')) || '';
        if (!curHost) body.smtp_host = detected.host;
        if (!curPort) body.smtp_port = String(detected.port);
      }
      for (const [k, v] of Object.entries(body)) await setSetting(k, v);
      res.json({ ok: true, smtp_detected: !!detected });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/content/image', requireAdmin, upload.single('image'), async (req, res) => {
    try {
      const key = req.body.key;
      if (!key) return res.status(400).json({ error: 'Missing key' });
      let url;
      if (req.file) url = '/uploads/' + req.file.filename;
      else if (req.body.url && String(req.body.url).trim()) url = normalizeImageUrl(String(req.body.url).trim());
      else return res.status(400).json({ error: 'Provide a file or a URL' });
      await setSetting(key, url);
      res.json({ ok: true, url });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/content/image-url', requireAdmin, async (req, res) => {
    try {
      const { key, url } = req.body || {};
      if (!key || !url) return res.status(400).json({ error: 'Missing key or url' });
      const normalized = normalizeImageUrl(url);
      await setSetting(key, normalized);
      res.json({ ok: true, url: normalized });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── ROOM TYPES ────────────────────────────────────────────────────────────
  app.get('/api/room-types', async (_, res) => {
    try {
      const rows = await db.all('SELECT * FROM room_types ORDER BY display_order, id');
      res.json(rows.map(rtToPublic));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/room-types/:key', requireAdmin, async (req, res) => {
    try {
      const rt = await findRoomType(req.params.key);
      if (!rt) return res.status(404).json({ error: 'Not found' });
      const { name, image, short_desc, description, features, display_order, price } = req.body || {};
      const featStr = Array.isArray(features) ? features.join('\n') : (features ?? rt.features);
      await db.run(
        'UPDATE room_types SET name=?, image=?, short_desc=?, description=?, features=?, display_order=?, price=? WHERE id=?',
        [name ?? rt.name, image ?? rt.image, short_desc ?? rt.short_desc, description ?? rt.description,
         featStr, display_order ?? rt.display_order, price !== undefined ? Number(price) : (rt.price || 0), rt.id]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/room-types/:key/image', requireAdmin, upload.single('image'), async (req, res) => {
    try {
      const rt = await findRoomType(req.params.key);
      if (!rt) return res.status(404).json({ error: 'Not found' });
      let url;
      if (req.file) url = '/uploads/' + req.file.filename;
      else if (req.body.url && String(req.body.url).trim()) url = normalizeImageUrl(String(req.body.url).trim());
      else return res.status(400).json({ error: 'Provide a file or url' });
      await db.run('UPDATE room_types SET image=? WHERE id=?', [url, rt.id]);
      res.json({ ok: true, url });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── ROOMS ─────────────────────────────────────────────────────────────────
  app.get('/api/rooms', async (_, res) => {
    try {
      res.json(await db.all('SELECT * FROM rooms ORDER BY number'));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/rooms', requireAdmin, async (req, res) => {
    try {
      const { number, category, price, status, description, image, features } = req.body;
      if (!number || !category || price === undefined) return res.status(400).json({ error: 'Number, category, price are required' });
      const r = await db.run(
        'INSERT INTO rooms (number, category, price, status, description, image, features) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [number, category, price, status || 'available', description || '', image || '', features || '']
      );
      res.json({ id: r.lastInsertRowid });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.put('/api/rooms/:id', requireAdmin, async (req, res) => {
    try {
      const { number, category, price, status, description, image, features } = req.body;
      const cur = await db.get('SELECT * FROM rooms WHERE id=?', [req.params.id]);
      if (!cur) return res.status(404).json({ error: 'Not found' });
      await db.run(
        'UPDATE rooms SET number=?, category=?, price=?, status=?, description=?, image=?, features=? WHERE id=?',
        [number ?? cur.number, category ?? cur.category, price ?? cur.price, status ?? cur.status,
         description ?? cur.description, image ?? cur.image, features ?? cur.features, req.params.id]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/rooms/:id/image', requireAdmin, upload.single('image'), async (req, res) => {
    try {
      const cur = await db.get('SELECT * FROM rooms WHERE id=?', [req.params.id]);
      if (!cur) return res.status(404).json({ error: 'Not found' });
      let url;
      if (req.file) url = '/uploads/' + req.file.filename;
      else if (req.body.url && String(req.body.url).trim()) url = normalizeImageUrl(String(req.body.url).trim());
      else return res.status(400).json({ error: 'Provide a file or url' });
      await db.run('UPDATE rooms SET image=? WHERE id=?', [url, req.params.id]);
      res.json({ ok: true, url });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/rooms/:id', requireAdmin, async (req, res) => {
    try {
      await db.run('DELETE FROM rooms WHERE id=?', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── CUSTOMERS ─────────────────────────────────────────────────────────────
  app.get('/api/customers', requireAdmin, async (_, res) => {
    try {
      res.json(await db.all('SELECT * FROM customers ORDER BY id DESC'));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/customers', requireAdmin, upload.single('document'), async (req, res) => {
    try {
      const { name, contact, email, id_proof } = req.body;
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
      if (!id_proof || !String(id_proof).trim()) return res.status(400).json({ error: 'ID proof number is required' });
      const document = req.file ? '/uploads/' + req.file.filename : null;
      const r = await db.run(
        'INSERT INTO customers (name, contact, email, id_proof, document) VALUES (?, ?, ?, ?, ?)',
        [name.trim(), contact || '', email || '', id_proof.trim(), document]
      );
      res.json({ id: r.lastInsertRowid });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/customers/:id', requireAdmin, upload.single('document'), async (req, res) => {
    try {
      const { name, contact, email, id_proof } = req.body;
      if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
      if (!id_proof || !String(id_proof).trim()) return res.status(400).json({ error: 'ID proof number is required' });
      if (req.file) {
        await db.run(
          'UPDATE customers SET name=?, contact=?, email=?, id_proof=?, document=? WHERE id=?',
          [name.trim(), contact || '', email || '', id_proof.trim(), '/uploads/' + req.file.filename, req.params.id]
        );
      } else {
        await db.run(
          'UPDATE customers SET name=?, contact=?, email=?, id_proof=? WHERE id=?',
          [name.trim(), contact || '', email || '', id_proof.trim(), req.params.id]
        );
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── BOOKINGS ──────────────────────────────────────────────────────────────
  app.get('/api/bookings', requireAdmin, async (_, res) => {
    try {
      const rows = await db.all(`
        SELECT b.*, c.name AS customer_name, c.contact AS customer_contact, c.email AS customer_email,
               r.number AS room_number, r.category AS room_category,
               COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS paid,
               COALESCE(b.total, 0) - COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS pending
        FROM bookings b
        JOIN customers c ON c.id = b.customer_id
        JOIN rooms r ON r.id = b.room_id
        ORDER BY b.id DESC
      `);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/bookings/:id', requireAdmin, async (req, res) => {
    try {
      const b = await db.get(`
        SELECT b.*, c.name AS customer_name, c.contact AS customer_contact, c.email AS customer_email,
               c.id_proof AS customer_id_proof, r.number AS room_number, r.category AS room_category,
               r.price AS room_price,
               COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS paid
        FROM bookings b
        JOIN customers c ON c.id = b.customer_id
        JOIN rooms r ON r.id = b.room_id
        WHERE b.id = ?
      `, [req.params.id]);
      if (!b) return res.status(404).json({ error: 'Not found' });
      let guests = [];
      if (b.guest_details) { try { guests = JSON.parse(b.guest_details); } catch {} }
      res.json({ ...b, guests });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Payments
  app.get('/api/bookings/:id/payments', requireAdmin, async (req, res) => {
    try {
      res.json(await db.all('SELECT * FROM payments WHERE booking_id=? ORDER BY id DESC', [req.params.id]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/bookings/:id/payments', requireAdmin, async (req, res) => {
    try {
      const { amount, method, type, notes } = req.body || {};
      const amt = parseFloat(amount);
      if (!amt || amt <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
      const r = await db.run(
        'INSERT INTO payments (booking_id, amount, method, type, notes) VALUES (?, ?, ?, ?, ?)',
        [req.params.id, amt, method || 'cash', type || 'advance', notes || '']
      );
      res.json({ id: r.lastInsertRowid });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/payments/:id', requireAdmin, async (req, res) => {
    try {
      await db.run('DELETE FROM payments WHERE id=?', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/availability', async (req, res) => {
    try {
      const { check_in, check_out } = req.query;
      if (!check_in || !check_out) {
        return res.json(await db.all("SELECT * FROM rooms WHERE status='available'"));
      }
      const taken = (await db.all(
        "SELECT room_id FROM bookings WHERE status IN ('booked','checked_in') AND NOT (check_out <= ? OR check_in >= ?)",
        [check_in, check_out]
      )).map(r => r.room_id);
      if (!taken.length) return res.json(await db.all('SELECT * FROM rooms'));
      const placeholders = taken.map((_, i) => IS_PG ? `$${i + 1}` : '?').join(',');
      res.json(await db.all(`SELECT * FROM rooms WHERE id NOT IN (${placeholders})`, taken));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/bookings', requireAdmin, async (req, res) => {
    try {
      let { customer_id, room_id, check_in, check_out, guests, guest_details, rooms_count, customer } = req.body || {};
      if (!room_id || !check_in || !check_out) return res.status(400).json({ error: 'Room and dates are required' });

      if (!customer_id) {
        if (!customer || !customer.name) return res.status(400).json({ error: 'Provide customer_id or new customer details' });
        if (!customer.id_proof || !String(customer.id_proof).trim()) return res.status(400).json({ error: 'ID proof number is required for new customer' });
        const r = await db.run(
          'INSERT INTO customers (name, contact, email, id_proof) VALUES (?, ?, ?, ?)',
          [String(customer.name).trim(), customer.contact || '', customer.email || '', String(customer.id_proof).trim()]
        );
        customer_id = r.lastInsertRowid;
      }

      const room = await db.get('SELECT * FROM rooms WHERE id=?', [room_id]);
      if (!room) return res.status(404).json({ error: 'Room not found' });

      const computedTotal = computeTotal({ check_in, check_out, room_price: room.price, rooms_count });
      const gd = guest_details ? (typeof guest_details === 'string' ? guest_details : JSON.stringify(guest_details)) : null;
      const guestCount = parseInt(guests) || (Array.isArray(guest_details) ? guest_details.length : 1);
      const roomsCount = Math.max(1, parseInt(rooms_count) || 1);

      const r = await db.run(
        'INSERT INTO bookings (customer_id, room_id, check_in, check_out, total, guests, guest_details, rooms_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [customer_id, room_id, check_in, check_out, computedTotal, guestCount, gd, roomsCount]
      );
      await db.run("UPDATE rooms SET status='booked' WHERE id=?", [room_id]);
      res.json({ id: r.lastInsertRowid, customer_id, total: computedTotal, nights: Math.max(1, Math.round((new Date(check_out) - new Date(check_in)) / 86400000)) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/bookings/:id', requireAdmin, async (req, res) => {
    try {
      const cur = await db.get('SELECT * FROM bookings WHERE id=?', [req.params.id]);
      if (!cur) return res.status(404).json({ error: 'Not found' });
      const { guests, guest_details, rooms_count, check_in, check_out } = req.body || {};
      const gd = guest_details === undefined ? cur.guest_details : (typeof guest_details === 'string' ? guest_details : JSON.stringify(guest_details));
      const gCount = guests === undefined ? cur.guests : parseInt(guests) || 1;
      const rCount = rooms_count === undefined ? cur.rooms_count : Math.max(1, parseInt(rooms_count) || 1);
      const ci = check_in || cur.check_in;
      const co = check_out || cur.check_out;
      const room = await db.get('SELECT * FROM rooms WHERE id=?', [cur.room_id]);
      const newTotal = computeTotal({ check_in: ci, check_out: co, room_price: room ? room.price : 0, rooms_count: rCount });
      await db.run(
        'UPDATE bookings SET guests=?, guest_details=?, rooms_count=?, check_in=?, check_out=?, total=? WHERE id=?',
        [gCount, gd, rCount, ci, co, newTotal, req.params.id]
      );
      res.json({ ok: true, total: newTotal });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/bookings/:id/status', requireAdmin, async (req, res) => {
    try {
      const { status } = req.body;
      const b = await db.get('SELECT * FROM bookings WHERE id=?', [req.params.id]);
      if (!b) return res.status(404).json({ error: 'Not found' });
      await db.run('UPDATE bookings SET status=? WHERE id=?', [status, req.params.id]);
      let roomStatus = 'available';
      if (status === 'checked_in') roomStatus = 'occupied';
      else if (status === 'booked') roomStatus = 'booked';
      await db.run('UPDATE rooms SET status=? WHERE id=?', [roomStatus, b.room_id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/bookings/:id', requireAdmin, async (req, res) => {
    try {
      const b = await db.get('SELECT * FROM bookings WHERE id=?', [req.params.id]);
      if (b) {
        await db.run('DELETE FROM bookings WHERE id=?', [req.params.id]);
        await db.run("UPDATE rooms SET status='available' WHERE id=?", [b.room_id]);
      }
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── REPORTS ───────────────────────────────────────────────────────────────
  function reportRange(period, customStart, customEnd) {
    const now = new Date();
    let start, end = now.toISOString().slice(0, 10);
    if (period === 'today') { start = end; }
    else if (period === 'weekly') { const s = new Date(now); s.setDate(now.getDate() - 7); start = s.toISOString().slice(0, 10); }
    else if (period === 'monthly') { const s = new Date(now); s.setMonth(now.getMonth() - 1); start = s.toISOString().slice(0, 10); }
    else if (period === 'yearly') { const s = new Date(now); s.setFullYear(now.getFullYear() - 1); start = s.toISOString().slice(0, 10); }
    else if (period === 'custom' && customStart && customEnd) { start = customStart; end = customEnd; }
    else { const s = new Date(now); s.setFullYear(now.getFullYear() - 1); start = s.toISOString().slice(0, 10); }
    return { start, end };
  }

  app.get('/api/reports/:period', requireAdmin, async (req, res) => {
    try {
      const { start, end } = reportRange(req.params.period, req.query.start, req.query.end);
      const bookings = await db.all(`
        SELECT b.id, b.check_in, b.check_out, b.status, b.total, b.created_at,
               c.name AS customer, c.contact AS contact,
               r.number AS room, r.category,
               COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS paid,
               COALESCE(b.total, 0) - COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS pending
        FROM bookings b
        JOIN customers c ON c.id=b.customer_id
        JOIN rooms r ON r.id=b.room_id
        WHERE DATE(b.created_at) BETWEEN ? AND ?
           OR DATE(b.check_in)   BETWEEN ? AND ?
        ORDER BY b.created_at DESC
      `, [start, end, start, end]);

      const pmtRows = await db.all(`
        SELECT p.*, b.id AS booking_id, c.name AS customer
        FROM payments p
        JOIN bookings b ON b.id = p.booking_id
        JOIN customers c ON c.id = b.customer_id
        WHERE DATE(p.paid_at) BETWEEN ? AND ?
        ORDER BY p.paid_at DESC
      `, [start, end]);

      const totalBooked = bookings.reduce((s, r) => s + (parseFloat(r.total) || 0), 0);
      const totalCollected = pmtRows.reduce((s, p) => s + (parseFloat(p.amount) || 0), 0);
      const totalPending = bookings.filter(b => b.status !== 'cancelled').reduce((s, r) => s + (r.pending > 0 ? parseFloat(r.pending) : 0), 0);

      const byMethod = {}, byStatus = {};
      pmtRows.forEach(p => { byMethod[p.method] = (byMethod[p.method] || 0) + parseFloat(p.amount); });
      bookings.forEach(b => { byStatus[b.status] = (byStatus[b.status] || 0) + 1; });

      const customerTotals = {};
      bookings.forEach(b => {
        const k = b.customer + '|' + b.contact;
        if (!customerTotals[k]) customerTotals[k] = { customer: b.customer, contact: b.contact, stays: 0, revenue: 0 };
        customerTotals[k].stays += 1;
        customerTotals[k].revenue += (parseFloat(b.total) || 0);
      });

      const roomTotals = {};
      bookings.forEach(b => {
        const k = b.room + ' (' + b.category + ')';
        if (!roomTotals[k]) roomTotals[k] = { room: k, bookings: 0, revenue: 0 };
        roomTotals[k].bookings += 1;
        roomTotals[k].revenue += (parseFloat(b.total) || 0);
      });

      const totalRoomsRow = await db.get('SELECT COUNT(*) AS c FROM rooms');
      const totalRooms = parseInt(totalRoomsRow.c) || 0;
      const days = Math.max(1, Math.round((new Date(end) - new Date(start)) / 86400000) + 1);
      const occupiedNights = bookings.filter(b => b.status !== 'cancelled').reduce((s, b) => {
        const ci = new Date(Math.max(new Date(b.check_in), new Date(start)));
        const co = new Date(Math.min(new Date(b.check_out), new Date(end)));
        return s + Math.max(0, Math.round((co - ci) / 86400000));
      }, 0);

      res.json({
        start, end, days,
        totals: { bookings: bookings.length, booked: totalBooked, collected: totalCollected, pending: totalPending, occupancy: totalRooms > 0 ? Math.round((occupiedNights / (totalRooms * days)) * 100) : 0, occupied_nights: occupiedNights, total_room_nights: totalRooms * days },
        byMethod, byStatus,
        topCustomers: Object.values(customerTotals).sort((a, b) => b.revenue - a.revenue).slice(0, 10),
        topRooms: Object.values(roomTotals).sort((a, b) => b.revenue - a.revenue),
        rows: bookings, payments: pmtRows,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/reports/:period/csv', requireAdmin, async (req, res) => {
    try {
      const { start, end } = reportRange(req.params.period, req.query.start, req.query.end);
      const rows = await db.all(`
        SELECT b.id, c.name AS customer, c.contact, r.number AS room, r.category,
               b.check_in, b.check_out, b.status, b.total,
               COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS paid,
               COALESCE(b.total, 0) - COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS pending,
               b.created_at
        FROM bookings b
        JOIN customers c ON c.id=b.customer_id
        JOIN rooms r ON r.id=b.room_id
        WHERE DATE(b.created_at) BETWEEN ? AND ? OR DATE(b.check_in) BETWEEN ? AND ?
        ORDER BY b.created_at DESC
      `, [start, end, start, end]);
      const headers = ['id','customer','contact','room','category','check_in','check_out','status','total','paid','pending','created_at'];
      const csv = [headers.join(',')]
        .concat(rows.map(r => headers.map(h => `"${String(r[h] ?? '').replace(/"/g, '""')}"`).join(',')))
        .join('\n');
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="report-${start}-to-${end}.csv"`);
      res.send(csv);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── DASHBOARD ─────────────────────────────────────────────────────────────
  app.get('/api/dashboard', requireAdmin, async (_, res) => {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const monthStart = today.slice(0, 7) + '-01';
      const weekStartD = new Date(); weekStartD.setDate(weekStartD.getDate() - 7);
      const weekStart = weekStartD.toISOString().slice(0, 10);

      const [rTotal, rOccupied, rBooked, rAvailable] = await Promise.all([
        db.get("SELECT COUNT(*) AS c FROM rooms"),
        db.get("SELECT COUNT(*) AS c FROM rooms WHERE status='occupied'"),
        db.get("SELECT COUNT(*) AS c FROM rooms WHERE status='booked'"),
        db.get("SELECT COUNT(*) AS c FROM rooms WHERE status='available'"),
      ]);

      const [todayCheckIns, todayCheckOuts, inHouse] = await Promise.all([
        db.all(`SELECT b.id, c.name, c.contact, r.number AS room, r.category, b.total,
                  COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS paid
                FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN rooms r ON r.id=b.room_id
                WHERE b.check_in = ? AND b.status IN ('booked','checked_in')`, [today]),
        db.all(`SELECT b.id, c.name, c.contact, r.number AS room, r.category, b.total,
                  COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS paid,
                  COALESCE(b.total,0) - COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS pending
                FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN rooms r ON r.id=b.room_id
                WHERE b.check_out = ? AND b.status IN ('booked','checked_in')`, [today]),
        db.all(`SELECT b.id, c.name, c.contact, r.number AS room, r.category, b.check_out
                FROM bookings b JOIN customers c ON c.id=b.customer_id JOIN rooms r ON r.id=b.room_id
                WHERE b.status='checked_in'`),
      ]);

      const [rToday, rWeek, rMonth, rPending, rPendingReq, rCust, rVisToday, rVisWeek] = await Promise.all([
        db.get("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE DATE(paid_at) = ?", [today]),
        db.get("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE DATE(paid_at) >= ?", [weekStart]),
        db.get("SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE DATE(paid_at) >= ?", [monthStart]),
        db.get("SELECT COALESCE(SUM(b.total - COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0)), 0) AS s FROM bookings b WHERE b.status IN ('booked','checked_in')"),
        db.get("SELECT COUNT(*) AS c FROM booking_requests WHERE status='pending'"),
        db.get("SELECT COUNT(*) AS c FROM customers"),
        db.get("SELECT COUNT(DISTINCT visitor_id) AS c FROM visits WHERE DATE(visited_at) = ?", [today]),
        db.get("SELECT COUNT(DISTINCT visitor_id) AS c FROM visits WHERE DATE(visited_at) >= ?", [weekStart]),
      ]);

      const totalRooms = parseInt(rTotal.c) || 0;
      const occ = parseInt(rOccupied.c) || 0;
      const bkd = parseInt(rBooked.c) || 0;
      res.json({
        rooms: { total: totalRooms, occupied: occ, booked: bkd, available: parseInt(rAvailable.c) || 0,
                 occupancy: totalRooms ? Math.round(((occ + bkd) / totalRooms) * 100) : 0 },
        today: { check_ins: todayCheckIns, check_outs: todayCheckOuts, collected: parseFloat(rToday.s) || 0 },
        in_house: inHouse,
        revenue: { today: parseFloat(rToday.s) || 0, week: parseFloat(rWeek.s) || 0, month: parseFloat(rMonth.s) || 0, pending_dues: parseFloat(rPending.s) || 0 },
        counts: { pending_requests: parseInt(rPendingReq.c) || 0, customers: parseInt(rCust.c) || 0, visitors_today: parseInt(rVisToday.c) || 0, visitors_week: parseInt(rVisWeek.c) || 0 },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── VISITOR TRACKING ──────────────────────────────────────────────────────
  app.post('/api/track', async (req, res) => {
    try {
      const vid = req.visitorId;
      const ip  = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      const ua  = req.headers['user-agent'] || '';
      const ref = req.headers.referer || (req.body && req.body.referrer) || '';
      const pg  = (req.body && req.body.path) || '/';
      const existing = await db.get('SELECT id FROM visitors WHERE visitor_id=?', [vid]);
      if (existing) {
        await db.run('UPDATE visitors SET last_seen=CURRENT_TIMESTAMP, visit_count=visit_count+1, ip=?, user_agent=? WHERE visitor_id=?', [ip, ua, vid]);
      } else {
        await db.run('INSERT INTO visitors (visitor_id, ip, user_agent) VALUES (?, ?, ?) ON CONFLICT(visitor_id) DO NOTHING', [vid, ip, ua]);
      }
      await db.run('INSERT INTO visits (visitor_id, path, ip, user_agent, referrer) VALUES (?, ?, ?, ?, ?)', [vid, pg, ip, ua, ref]);
      res.json({ ok: true, visitor_id: vid });
    } catch (e) { res.json({ ok: true }); }
  });

  app.post('/api/identify', async (req, res) => {
    try {
      const vid = req.visitorId;
      const { name, email, phone } = req.body || {};
      const existing = await db.get('SELECT id FROM visitors WHERE visitor_id=?', [vid]);
      if (!existing) {
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const ua = req.headers['user-agent'] || '';
        await db.run('INSERT INTO visitors (visitor_id, name, email, phone, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(visitor_id) DO NOTHING', [vid, name || '', email || '', phone || '', ip, ua]);
      } else {
        await db.run("UPDATE visitors SET name=COALESCE(NULLIF(?,''), name), email=COALESCE(NULLIF(?,''), email), phone=COALESCE(NULLIF(?,''), phone), last_seen=CURRENT_TIMESTAMP WHERE visitor_id=?", [name || '', email || '', phone || '', vid]);
      }
      res.json({ ok: true });
    } catch (e) { res.json({ ok: true }); }
  });

  app.get('/api/visitors', requireAdmin, async (_, res) => {
    try {
      const rows = await db.all(`
        SELECT v.*,
          (SELECT COUNT(*) FROM visits WHERE visitor_id = v.visitor_id) AS total_visits,
          (SELECT id FROM customers WHERE (contact = v.phone AND v.phone <> '') OR (email = v.email AND v.email <> '') LIMIT 1) AS customer_id
        FROM visitors v
        ORDER BY v.last_seen DESC
      `);
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/visitors/:vid/history', requireAdmin, async (req, res) => {
    try {
      const [visits, v] = await Promise.all([
        db.all('SELECT * FROM visits WHERE visitor_id=? ORDER BY id DESC LIMIT 200', [req.params.vid]),
        db.get('SELECT * FROM visitors WHERE visitor_id=?', [req.params.vid]),
      ]);
      res.json({ visitor: v, visits });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/visitors/:vid', requireAdmin, async (req, res) => {
    try {
      await db.run('DELETE FROM visits WHERE visitor_id=?', [req.params.vid]);
      await db.run('DELETE FROM visitors WHERE visitor_id=?', [req.params.vid]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── CUSTOMER LOOKUP + HISTORY ─────────────────────────────────────────────
  app.get('/api/customers/lookup', requireAdmin, async (req, res) => {
    try {
      const q = (req.query.q || '').trim();
      if (!q) return res.json({ matches: [] });
      const dd = db.dateDiff('check_in', 'check_out');
      const rows = await db.all(`
        SELECT c.*,
          (SELECT COUNT(*) FROM bookings WHERE customer_id = c.id) AS booking_count,
          (SELECT MAX(check_out) FROM bookings WHERE customer_id = c.id) AS last_stay,
          (SELECT COALESCE(SUM(${dd}), 0) FROM bookings WHERE customer_id = c.id) AS total_nights
        FROM customers c
        WHERE c.contact LIKE ? OR c.email LIKE ? OR c.name LIKE ?
        ORDER BY c.id DESC LIMIT 20
      `, ['%' + q + '%', '%' + q + '%', '%' + q + '%']);
      res.json({ matches: rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/customers/:id/history', requireAdmin, async (req, res) => {
    try {
      const c = await db.get('SELECT * FROM customers WHERE id=?', [req.params.id]);
      if (!c) return res.status(404).json({ error: 'Not found' });
      const dd = db.dateDiff('b.check_in', 'b.check_out');
      const bookings = await db.all(`
        SELECT b.*, r.number AS room_number, r.category AS room_category,
               ${dd} AS nights,
               COALESCE((SELECT SUM(amount) FROM payments WHERE booking_id = b.id), 0) AS paid
        FROM bookings b JOIN rooms r ON r.id=b.room_id
        WHERE b.customer_id=? ORDER BY b.id DESC
      `, [req.params.id]);
      bookings.forEach(b => { try { b.guests_list = b.guest_details ? JSON.parse(b.guest_details) : []; } catch { b.guests_list = []; } });
      const docs = await db.all('SELECT * FROM booking_documents WHERE customer_id=? ORDER BY id DESC', [req.params.id]);
      const totalNights  = bookings.reduce((s, b) => s + (parseInt(b.nights) || 0), 0);
      const totalRevenue = bookings.reduce((s, b) => s + (parseFloat(b.total) || 0), 0);
      const totalPaid    = bookings.reduce((s, b) => s + (parseFloat(b.paid) || 0), 0);
      res.json({
        customer: c, bookings, documents: docs,
        summary: { total_visits: bookings.length, total_nights: totalNights, total_revenue: totalRevenue, total_paid: totalPaid, first_visit: bookings.length ? bookings[bookings.length - 1].check_in : null, last_visit: bookings.length ? bookings[0].check_in : null },
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── BOOKING REQUESTS ──────────────────────────────────────────────────────
  app.post('/api/request-booking', async (req, res) => {
    try {
      const { name, phone, country_code, email, check_in, check_out, guests, room_type, message, guest_details, rooms_required } = req.body || {};
      if (!name || !phone || !check_in || !check_out) return res.status(400).json({ error: 'Name, phone, check-in and check-out are required.' });
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (new Date(check_in) < today) return res.status(400).json({ error: 'Check-in must be today or a future date.' });
      if (new Date(check_out) <= new Date(check_in)) return res.status(400).json({ error: 'Check-out must be after check-in.' });
      const fullPhone = country_code ? `${country_code} ${phone}`.trim() : phone;
      const gd = guest_details ? (typeof guest_details === 'string' ? guest_details : JSON.stringify(guest_details)) : null;
      const r = await db.run(
        'INSERT INTO booking_requests (name, phone, country_code, email, check_in, check_out, guests, room_type, message, guest_details, rooms_required) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [name, fullPhone, country_code || '', email || '', check_in, check_out, parseInt(guests) || 1, room_type || '', message || '', gd, parseInt(rooms_required) || 1]
      );
      const vid = req.visitorId;
      if (vid) {
        const existing = await db.get('SELECT id FROM visitors WHERE visitor_id=?', [vid]);
        if (!existing) {
          await db.run('INSERT INTO visitors (visitor_id, name, email, phone) VALUES (?, ?, ?, ?) ON CONFLICT(visitor_id) DO NOTHING', [vid, name, email || '', fullPhone]);
        } else {
          await db.run('UPDATE visitors SET name=?, email=?, phone=?, last_seen=CURRENT_TIMESTAMP WHERE visitor_id=?', [name, email || '', fullPhone, vid]);
        }
      }
      res.json({ ok: true, id: r.lastInsertRowid });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/booking-requests', requireAdmin, async (_, res) => {
    try {
      const rows = await db.all('SELECT * FROM booking_requests ORDER BY id DESC');
      rows.forEach(r => { try { r.guests_list = r.guest_details ? JSON.parse(r.guest_details) : []; } catch { r.guests_list = []; } });
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.put('/api/booking-requests/:id', requireAdmin, async (req, res) => {
    try {
      await db.run('UPDATE booking_requests SET status=? WHERE id=?', [req.body.status, req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/booking-requests/:id/confirm', requireAdmin, async (req, res) => {
    try {
      const { room_number } = req.body;
      const reqRow = await db.get('SELECT * FROM booking_requests WHERE id=?', [req.params.id]);
      if (!reqRow) return res.status(404).json({ error: 'Request not found' });
      if (!room_number || !String(room_number).trim()) return res.status(400).json({ error: 'Room number is required' });

      const roomNum = String(room_number).trim();
      const rt = (await findRoomType(reqRow.room_type)) || await db.get('SELECT * FROM room_types ORDER BY id LIMIT 1');
      const rtSlug  = rt ? rt.slug  : 'suite';
      const rtPrice = rt ? (rt.price || 0) : 0;
      const rtName  = rt ? rt.name  : (reqRow.room_type || 'Room');

      let room = await db.get('SELECT * FROM rooms WHERE number=?', [roomNum]);
      if (!room) {
        const rr = await db.run('INSERT INTO rooms (number, category, price, status) VALUES (?, ?, ?, ?)', [roomNum, rtSlug, rtPrice, 'booked']);
        room = await db.get('SELECT * FROM rooms WHERE id=?', [rr.lastInsertRowid]);
      } else {
        await db.run("UPDATE rooms SET status='booked' WHERE id=?", [room.id]);
      }

      let cust = await db.get('SELECT * FROM customers WHERE contact=?', [reqRow.phone]);
      if (!cust) {
        const r = await db.run('INSERT INTO customers (name, contact, email) VALUES (?, ?, ?)', [reqRow.name, reqRow.phone, reqRow.email || '']);
        cust = { id: r.lastInsertRowid, name: reqRow.name, contact: reqRow.phone, email: reqRow.email };
      }

      const computedTotal = computeTotal({ check_in: reqRow.check_in, check_out: reqRow.check_out, room_price: rtPrice, rooms_count: reqRow.rooms_required || 1 });
      const nights = Math.max(1, Math.round((new Date(reqRow.check_out) - new Date(reqRow.check_in)) / 86400000));

      const bk = await db.run(
        'INSERT INTO bookings (customer_id, room_id, check_in, check_out, total, status, guests, guest_details, rooms_count, room_type, room_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [cust.id, room.id, reqRow.check_in, reqRow.check_out, computedTotal, 'booked', reqRow.guests || 1, reqRow.guest_details || null, reqRow.rooms_required || 1, rtSlug, roomNum]
      );
      await db.run("UPDATE booking_requests SET status='confirmed' WHERE id=?", [req.params.id]);

      let emailResult = { sent: false };
      if (reqRow.email) {
        const hotelName    = await getSetting('hotel_name', 'The Dream Residency');
        const checkinTime  = await getSetting('default_checkin_time', '11:00');
        const hotelPhone   = await getSetting('phone', '+91 00000 00000');
        const hotelAddress = await getSetting('address', '');
        try {
          emailResult = await sendMail({
            to: reqRow.email,
            subject: `Booking Confirmed – ${hotelName} (Booking #${bk.lastInsertRowid})`,
            text: `Dear ${reqRow.name},\n\nYour booking at ${hotelName} is confirmed.\n\nBooking #${bk.lastInsertRowid}\nRoom Type: ${rtName}\nCheck-in: ${reqRow.check_in} at ${checkinTime}\nCheck-out: ${reqRow.check_out} (${nights} night${nights > 1 ? 's' : ''})\nGuests: ${reqRow.guests || 1}\nTotal: ₹${computedTotal.toLocaleString('en-IN')}\n\nWarm regards,\n${hotelName}`,
            html: buildConfirmationEmail({ hotelName, checkinTime, hotelPhone, hotelAddress, name: reqRow.name, bookingId: bk.lastInsertRowid, roomType: rtName, checkIn: reqRow.check_in, checkOut: reqRow.check_out, nights, guests: reqRow.guests || 1, total: computedTotal }),
          });
        } catch (e) { emailResult = { sent: false, reason: e.message }; }
      }

      res.json({ ok: true, booking_id: bk.lastInsertRowid, customer_id: cust.id, total: computedTotal, email: emailResult });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── MANUAL BOOKING (walk-in) ──────────────────────────────────────────────
  app.post('/api/manual-booking', requireAdmin, async (req, res) => {
    try {
      let { name, phone, email, address, id_proof, guests, room_type, room_number, check_in, check_out, notes, payment_amount, payment_method } = req.body || {};
      if (!name || !phone || !room_type || !room_number || !check_in || !check_out)
        return res.status(400).json({ error: 'Name, phone, room type, room number, and dates are required' });

      const roomNum = String(room_number).trim();
      const slug = String(room_type).toLowerCase();
      const rt = (await findRoomType(slug)) || await db.get('SELECT * FROM room_types ORDER BY id LIMIT 1');
      const rtPrice = rt ? (rt.price || 0) : 0;

      let room = await db.get('SELECT * FROM rooms WHERE number=?', [roomNum]);
      if (!room) {
        const rr = await db.run('INSERT INTO rooms (number, category, price, status) VALUES (?, ?, ?, ?)', [roomNum, slug, rtPrice, 'booked']);
        room = await db.get('SELECT * FROM rooms WHERE id=?', [rr.lastInsertRowid]);
      } else {
        await db.run("UPDATE rooms SET status='booked' WHERE id=?", [room.id]);
      }

      let cust = await db.get('SELECT * FROM customers WHERE contact=?', [phone]);
      if (!cust) {
        if (!id_proof) return res.status(400).json({ error: 'ID proof number is required for new customer' });
        const r = await db.run('INSERT INTO customers (name, contact, email, id_proof, address) VALUES (?, ?, ?, ?, ?)', [String(name).trim(), phone, email || '', String(id_proof).trim(), address || '']);
        cust = { id: r.lastInsertRowid, name, contact: phone, email };
      } else {
        if (id_proof) await db.run("UPDATE customers SET id_proof=?, address=COALESCE(NULLIF(?,''),address) WHERE id=?", [id_proof, address || '', cust.id]);
      }

      const computedTotal = computeTotal({ check_in, check_out, room_price: rtPrice, rooms_count: 1 });
      const bk = await db.run(
        'INSERT INTO bookings (customer_id, room_id, check_in, check_out, total, status, guests, rooms_count, room_type, room_number, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [cust.id, room.id, check_in, check_out, computedTotal, 'booked', parseInt(guests) || 1, 1, slug, roomNum, notes || '']
      );

      if (payment_amount && parseFloat(payment_amount) > 0) {
        await db.run('INSERT INTO payments (booking_id, amount, method, type, notes) VALUES (?, ?, ?, ?, ?)', [bk.lastInsertRowid, parseFloat(payment_amount), payment_method || 'cash', 'advance', 'Manual booking payment']);
      }

      res.json({ ok: true, booking_id: bk.lastInsertRowid, customer_id: cust.id, total: computedTotal });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete('/api/booking-requests/:id', requireAdmin, async (req, res) => {
    try {
      await db.run('DELETE FROM booking_requests WHERE id=?', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── BOOKING DOCUMENTS (per-guest) ─────────────────────────────────────────
  const docStorage = multer.diskStorage({
    destination: (_, __, cb) => cb(null, resolveDocStorage()),
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-z0-9.\-_]/gi, '_');
      cb(null, `bk${req.params.id}_${Date.now()}_${safe}`);
    },
  });
  const docUpload = multer({ storage: docStorage, limits: { fileSize: 15 * 1024 * 1024 } });

  app.get('/api/bookings/:id/documents', requireAdmin, async (req, res) => {
    try {
      res.json(await db.all('SELECT * FROM booking_documents WHERE booking_id=? ORDER BY guest_index, id DESC', [req.params.id]));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/bookings/:id/documents', requireAdmin, docUpload.array('documents', 20), async (req, res) => {
    try {
      const b = await db.get('SELECT * FROM bookings WHERE id=?', [req.params.id]);
      if (!b) return res.status(404).json({ error: 'Booking not found' });
      const docType    = req.body.doc_type || 'ID Proof';
      const guestIndex = parseInt(req.body.guest_index) || 0;
      const guestName  = req.body.guest_name || '';
      const saved = [];
      for (const f of (req.files || [])) {
        const r = await db.run(
          'INSERT INTO booking_documents (booking_id, customer_id, doc_type, file_path, original_name, guest_index, guest_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [req.params.id, b.customer_id, docType, f.path, f.originalname, guestIndex, guestName]
        );
        saved.push({ id: r.lastInsertRowid, name: f.originalname, path: f.path, guest_index: guestIndex });
      }
      res.json({ ok: true, files: saved });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.get('/api/documents/:id/download', requireAdmin, async (req, res) => {
    try {
      const d = await db.get('SELECT * FROM booking_documents WHERE id=?', [req.params.id]);
      if (!d || !fs.existsSync(d.file_path)) return res.status(404).send('Not found');
      res.download(d.file_path, d.original_name || path.basename(d.file_path));
    } catch (e) { res.status(500).send('Error'); }
  });

  app.delete('/api/documents/:id', requireAdmin, async (req, res) => {
    try {
      const d = await db.get('SELECT * FROM booking_documents WHERE id=?', [req.params.id]);
      if (d && d.file_path && fs.existsSync(d.file_path)) { try { fs.unlinkSync(d.file_path); } catch {} }
      await db.run('DELETE FROM booking_documents WHERE id=?', [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── TEST EMAIL ────────────────────────────────────────────────────────────
  app.post('/api/test-email', requireAdmin, async (_, res) => {
    try {
      const adminEmail = await getSetting('admin_email');
      if (!adminEmail) return res.status(400).json({ error: 'Set Admin Email in Site Content first' });
      const r = await sendMail({
        to: adminEmail,
        subject: 'Test Email – The Dream Residency',
        text: 'This is a test email. Your SMTP configuration is working correctly.',
        html: '<h2 style="color:#1a3a5c">SMTP Working!</h2><p>Your email configuration is working correctly.</p>',
      });
      if (!r.sent) return res.status(400).json({ error: r.reason || 'SMTP not configured' });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── STATIC / ADMIN ROUTES ─────────────────────────────────────────────────
  app.get('/admin-dream/login', (_, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
  app.get('/admin-dream',       (_, res) => res.redirect('/admin-dream/login'));
  app.get('/admin',             (_, res) => res.status(404).send('Not found'));

  // ── START ─────────────────────────────────────────────────────────────────
  app.listen(PORT, '0.0.0.0', () => console.log(`Dream Residency running on port ${PORT} [${IS_PG ? 'PostgreSQL' : 'SQLite'}]`));
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
