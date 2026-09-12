// 数据库层：sql.js (SQLite WASM) + 文件持久化
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'shop.sqlite');

let db = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vehicles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plate_no TEXT NOT NULL UNIQUE,
  brand TEXT NOT NULL,
  model TEXT NOT NULL,
  vin TEXT DEFAULT '',
  color TEXT DEFAULT '',
  owner_name TEXT NOT NULL,
  owner_phone TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS technicians (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  specialty TEXT DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS parts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT DEFAULT '通用',
  unit TEXT DEFAULT '件',
  price REAL NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  warn_stock INTEGER NOT NULL DEFAULT 5
);

CREATE TABLE IF NOT EXISTS repair_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  vehicle_id INTEGER NOT NULL REFERENCES vehicles(id),
  mileage INTEGER DEFAULT 0,
  fault_desc TEXT DEFAULT '',
  receptionist TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'reception',
  -- reception已接待 / repairing维修中 / qc待质检 / settling待结算 / delivering待交车 / done已交车
  expected_delivery_at TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS repair_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES repair_orders(id),
  name TEXT NOT NULL,
  category TEXT DEFAULT '机修',
  labor_price REAL NOT NULL DEFAULT 0,
  hours REAL DEFAULT 1,
  is_additional INTEGER NOT NULL DEFAULT 0,       -- 是否增项
  approval_status TEXT NOT NULL DEFAULT 'none',   -- none无需审批 / pending待审批 / approved已批准 / rejected已驳回
  status TEXT NOT NULL DEFAULT 'pending',         -- pending待施工 / doing施工中 / done已完成
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS dispatches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES repair_orders(id),
  technician_id INTEGER NOT NULL REFERENCES technicians(id),
  item_id INTEGER REFERENCES repair_items(id),
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'assigned',  -- assigned已派工 / done已完工
  dispatched_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS part_usages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES repair_orders(id),
  part_id INTEGER NOT NULL REFERENCES parts(id),
  quantity INTEGER NOT NULL,
  unit_price REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',  -- issued已领用 / returned已退回
  issued_by TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS quality_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES repair_orders(id),
  inspector TEXT NOT NULL,
  result TEXT NOT NULL,   -- pass合格 / fail不合格
  notes TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES repair_orders(id),
  items_amount REAL NOT NULL DEFAULT 0,
  parts_amount REAL NOT NULL DEFAULT 0,
  discount REAL NOT NULL DEFAULT 0,
  total_amount REAL NOT NULL DEFAULT 0,
  pay_method TEXT DEFAULT '现金',
  status TEXT NOT NULL DEFAULT 'paid',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  paid_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`;

async function init() {
  const SQL = await initSqlJs();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON;');
  db.run(SCHEMA);
  save();
  return db;
}

function save() {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

// ---- 查询助手 ----
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function get(sql, params = []) {
  const rows = all(sql, params);
  return rows.length ? rows[0] : null;
}

let inTx = false; // sql.js 的 export() 会结束事务，事务内禁止 save()

function run(sql, params = []) {
  db.run(sql, params);
  // 注意：sql.js 的 export() 会把 last_insert_rowid 重置为 0，必须先取 ID 再 save()
  const id = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
  if (!inTx) save();
  return id;
}

// 事务：多步写入后统一持久化
function tx(fn) {
  db.run('BEGIN');
  inTx = true;
  try {
    const result = fn();
    db.run('COMMIT');
    inTx = false;
    save();
    return result;
  } catch (e) {
    inTx = false;
    try { db.run('ROLLBACK'); } catch (_) { /* 事务可能已结束 */ }
    throw e;
  }
}

module.exports = { init, all, get, run, tx, save };
