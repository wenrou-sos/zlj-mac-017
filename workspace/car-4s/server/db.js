// 数据库层：sql.js (SQLite WASM) + 文件持久化
// 多实例安全：写入前加文件锁并重新加载磁盘最新数据，落盘采用 临时文件+rename 原子替换，
// 避免多个进程打开同一数据库文件时互相覆盖数据。
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'shop.sqlite');
const LOCK_FILE = DB_FILE + '.lock';
const TMP_FILE = DB_FILE + '.' + process.pid + '.tmp';

let SQL = null;
let db = null;
let lastMtime = 0;
let lastSize = -1;
let lockDepth = 0; // 进程内可重入锁（事务内嵌套 run 不会重复加锁）

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

// ---------- 文件锁 ----------
function acquireLock() {
  if (lockDepth > 0) { lockDepth++; return; } // 本进程已持有（事务重入）
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
      lockDepth = 1;
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      // 清理超过15秒的残留锁（持锁进程已崩溃的情况）
      try {
        if (Date.now() - fs.statSync(LOCK_FILE).mtimeMs > 15000) fs.unlinkSync(LOCK_FILE);
      } catch (_) { /* 锁可能刚被释放 */ }
      if (Date.now() > deadline) throw new Error('数据库正忙，请稍后重试');
      const until = Date.now() + 5; // 短暂自旋等待
      while (Date.now() < until) { /* busy wait */ }
    }
  }
}

function releaseLock() {
  if (lockDepth === 0) return;
  lockDepth--;
  if (lockDepth === 0) {
    try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* 已被清理 */ }
  }
}

process.on('exit', () => { try { if (lockDepth > 0) fs.unlinkSync(LOCK_FILE); } catch (_) {} });

// ---------- 加载 / 保存 ----------
function noteFileState() {
  try {
    const st = fs.statSync(DB_FILE);
    lastMtime = st.mtimeMs;
    lastSize = st.size;
  } catch (_) {
    lastMtime = 0;
    lastSize = -1;
  }
}

function loadFromDisk() {
  if (db) { try { db.close(); } catch (_) {} }
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }
  db.run('PRAGMA foreign_keys = ON;');
  noteFileState();
}

// 磁盘文件被其他实例更新时重新加载
function refreshIfChanged() {
  if (lockDepth > 0) return; // 事务/写锁内不重载，保护未提交修改
  try {
    const st = fs.statSync(DB_FILE);
    if (st.mtimeMs !== lastMtime || st.size !== lastSize) loadFromDisk();
  } catch (_) { /* 文件不存在则保持内存库 */ }
}

// 原子落盘：临时文件 + rename，读取方不会看到写了一半的文件
function save() {
  const data = db.export();
  fs.writeFileSync(TMP_FILE, Buffer.from(data));
  fs.renameSync(TMP_FILE, DB_FILE);
  noteFileState();
}

async function init() {
  SQL = await initSqlJs();
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  loadFromDisk();
  db.run(SCHEMA);
  save();
  return db;
}

// ---------- 查询 ----------
function all(sql, params = []) {
  refreshIfChanged();
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

// ---------- 写入 ----------
function lastInsertId() {
  return db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
}

// 单条写入：加锁 -> 重载最新数据 -> 执行 -> 落盘
function run(sql, params = []) {
  if (lockDepth > 0) { // 事务内：只执行，由 tx 统一落盘
    db.run(sql, params);
    return lastInsertId();
  }
  acquireLock();
  try {
    loadFromDisk(); // 先合并其他实例的写入，避免覆盖
    db.run(sql, params);
    const id = lastInsertId();
    save();
    return id;
  } finally {
    releaseLock();
  }
}

// 事务：多步写入后统一持久化
function tx(fn) {
  acquireLock();
  try {
    loadFromDisk(); // 事务开始前合并其他实例的写入
    db.run('BEGIN');
    let result;
    try {
      result = fn();
      db.run('COMMIT');
    } catch (e) {
      try { db.run('ROLLBACK'); } catch (_) { /* 事务可能已结束 */ }
      throw e;
    }
    save();
    return result;
  } finally {
    releaseLock();
  }
}

module.exports = { init, all, get, run, tx, save };
