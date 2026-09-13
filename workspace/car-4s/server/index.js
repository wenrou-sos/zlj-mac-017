// 汽车4S店维修管理系统 - 后端API
const express = require('express');
const path = require('path');
const db = require('./db');
const { seedIfEmpty } = require('./seed');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// 统一错误处理包装
const h = fn => (req, res) => {
  try { fn(req, res); } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

const ORDER_STATUS = ['reception', 'repairing', 'qc', 'settling', 'delivering', 'done'];

// 更新工单的"最后变更时间"（毫秒精度，前端据此检测其他终端的改动）
function touchOrder(id) {
  db.run(`UPDATE repair_orders SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now','localtime') WHERE id = ?`, [id]);
}

function getOrderOr404(id) {
  const o = db.get('SELECT * FROM repair_orders WHERE id = ?', [id]);
  if (!o) throw new Error('工单不存在');
  return o;
}

// 生成工单号（必须在写事务/文件锁内调用，否则多实例会撞号）
function genOrderNo() {
  const today = new Date();
  const ymd = today.toISOString().slice(0, 10).replace(/-/g, '');
  const row = db.get(`SELECT COUNT(*) AS c FROM repair_orders WHERE order_no LIKE 'WX' || ? || '%'`, [ymd]);
  let n = row.c + 1, no;
  do {
    no = `WX${ymd}${String(n++).padStart(3, '0')}`;
  } while (db.get('SELECT id FROM repair_orders WHERE order_no = ?', [no]));
  return no;
}

// ============ 工作台统计 + 交车提醒 ============
app.get('/api/dashboard', h((req, res) => {
  const stat = (sql, p = []) => db.get(sql, p).c;
  const stats = {
    reception: stat(`SELECT COUNT(*) c FROM repair_orders WHERE status='reception'`),
    repairing: stat(`SELECT COUNT(*) c FROM repair_orders WHERE status='repairing'`),
    qc: stat(`SELECT COUNT(*) c FROM repair_orders WHERE status='qc'`),
    settling: stat(`SELECT COUNT(*) c FROM repair_orders WHERE status='settling'`),
    delivering: stat(`SELECT COUNT(*) c FROM repair_orders WHERE status='delivering'`),
    todayOrders: stat(`SELECT COUNT(*) c FROM repair_orders WHERE date(created_at)=date('now','localtime')`),
    todayRevenue: db.get(`SELECT COALESCE(SUM(total_amount),0) c FROM settlements WHERE date(paid_at)=date('now','localtime')`).c,
    monthRevenue: db.get(`SELECT COALESCE(SUM(total_amount),0) c FROM settlements WHERE strftime('%Y-%m',paid_at)=strftime('%Y-%m','now','localtime')`).c,
    pendingApprovals: stat(`SELECT COUNT(*) c FROM repair_items WHERE approval_status='pending'`),
    lowStock: stat(`SELECT COUNT(*) c FROM parts WHERE stock <= warn_stock`),
  };

  // 交车提醒：未交车 且 (已结算待交车 / 预计交车时间24小时内 / 已逾期)
  const reminders = db.all(`
    SELECT o.id, o.order_no, o.status, o.expected_delivery_at, v.plate_no, v.owner_name, v.owner_phone,
      CASE
        WHEN o.status = 'delivering' THEN '已结算，等待客户取车'
        WHEN o.expected_delivery_at < datetime('now','localtime') THEN '已逾期，请尽快处理'
        ELSE '临近预计交车时间'
      END AS reason,
      CAST((julianday(o.expected_delivery_at) - julianday('now','localtime')) * 24 AS INTEGER) AS hours_left
    FROM repair_orders o JOIN vehicles v ON v.id = o.vehicle_id
    WHERE o.status != 'done'
      AND (o.status = 'delivering'
           OR (o.expected_delivery_at != '' AND o.expected_delivery_at <= datetime('now','localtime','+24 hours')))
    ORDER BY o.expected_delivery_at ASC`);

  const lowStockParts = db.all(`SELECT * FROM parts WHERE stock <= warn_stock ORDER BY stock ASC`);
  const pendingItems = db.all(`
    SELECT i.*, o.order_no, v.plate_no FROM repair_items i
    JOIN repair_orders o ON o.id = i.order_id
    JOIN vehicles v ON v.id = o.vehicle_id
    WHERE i.approval_status = 'pending'`);

  res.json({ stats, reminders, lowStockParts, pendingItems });
}));

// ============ 车辆档案 ============
app.get('/api/vehicles', h((req, res) => {
  const q = (req.query.q || '').trim();
  const rows = q
    ? db.all(`SELECT * FROM vehicles WHERE plate_no LIKE ? OR owner_name LIKE ? OR owner_phone LIKE ? ORDER BY id DESC`,
        [`%${q}%`, `%${q}%`, `%${q}%`])
    : db.all('SELECT * FROM vehicles ORDER BY id DESC');
  res.json(rows);
}));

app.post('/api/vehicles', h((req, res) => {
  const { plate_no, brand, model, vin = '', color = '', owner_name, owner_phone } = req.body;
  if (!plate_no || !brand || !model || !owner_name || !owner_phone) throw new Error('请填写完整车辆信息');
  if (db.get('SELECT id FROM vehicles WHERE plate_no = ?', [plate_no])) throw new Error(`车牌号 ${plate_no} 已存在档案`);
  const id = db.run('INSERT INTO vehicles(plate_no,brand,model,vin,color,owner_name,owner_phone) VALUES (?,?,?,?,?,?,?)',
    [plate_no, brand, model, vin, color, owner_name, owner_phone]);
  res.json(db.get('SELECT * FROM vehicles WHERE id = ?', [id]));
}));

// 编辑车辆档案（车牌唯一性校验）
app.put('/api/vehicles/:id', h((req, res) => {
  const v = db.get('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);
  if (!v) throw new Error('车辆档案不存在');
  const { plate_no, brand, model, vin = '', color = '', owner_name, owner_phone } = req.body;
  if (!plate_no || !brand || !model || !owner_name || !owner_phone) throw new Error('请填写完整车辆信息');
  const dup = db.get('SELECT id, owner_name FROM vehicles WHERE plate_no = ? AND id != ?', [plate_no, v.id]);
  if (dup) throw new Error(`车牌号 ${plate_no} 已被「${dup.owner_name}」的档案使用，不能重复`);
  db.run(`UPDATE vehicles SET plate_no=?, brand=?, model=?, vin=?, color=?, owner_name=?, owner_phone=? WHERE id=?`,
    [plate_no, brand, model, vin, color, owner_name, owner_phone, v.id]);
  res.json(db.get('SELECT * FROM vehicles WHERE id = ?', [v.id]));
}));

// 删除车辆档案（已有工单的禁止删除）
app.delete('/api/vehicles/:id', h((req, res) => {
  const v = db.get('SELECT * FROM vehicles WHERE id = ?', [req.params.id]);
  if (!v) throw new Error('车辆档案不存在');
  const c = db.get('SELECT COUNT(*) c FROM repair_orders WHERE vehicle_id = ?', [v.id]).c;
  if (c > 0) throw new Error(`该车辆已有 ${c} 张维修工单，不能删除；如信息有误请使用编辑修改`);
  db.run('DELETE FROM vehicles WHERE id = ?', [v.id]);
  res.json({ ok: true });
}));

// ============ 配件库存 ============
app.get('/api/parts', h((req, res) => {
  res.json(db.all('SELECT *, (stock <= warn_stock) AS low FROM parts ORDER BY id'));
}));

app.post('/api/parts', h((req, res) => {
  const { code, name, category = '通用', unit = '件', price = 0, stock = 0, warn_stock = 5 } = req.body;
  if (!code || !name) throw new Error('请填写配件编码和名称');
  if (Number(price) < 0) throw new Error('单价不能为负数');
  if (Number(stock) < 0) throw new Error('库存不能为负数');
  if (Number(warn_stock) < 0) throw new Error('警戒库存不能为负数');
  if (db.get('SELECT id FROM parts WHERE code = ?', [code])) throw new Error(`配件编码 ${code} 已存在`);
  const id = db.run('INSERT INTO parts(code,name,category,unit,price,stock,warn_stock) VALUES (?,?,?,?,?,?,?)',
    [code, name, category, unit, Number(price), Number(stock), Number(warn_stock)]);
  res.json(db.get('SELECT * FROM parts WHERE id = ?', [id]));
}));

app.post('/api/parts/:id/restock', h((req, res) => {
  const qty = Number(req.body.quantity);
  if (!qty || qty <= 0) throw new Error('入库数量必须大于0');
  const part = db.get('SELECT * FROM parts WHERE id = ?', [req.params.id]);
  if (!part) throw new Error('配件不存在');
  db.run('UPDATE parts SET stock = stock + ? WHERE id = ?', [qty, part.id]);
  res.json(db.get('SELECT * FROM parts WHERE id = ?', [part.id]));
}));

// 编辑配件（编码唯一性校验，可调价、改警戒值）
app.put('/api/parts/:id', h((req, res) => {
  const p = db.get('SELECT * FROM parts WHERE id = ?', [req.params.id]);
  if (!p) throw new Error('配件不存在');
  const { code, name, category = '通用', unit = '件', price = 0, warn_stock = 5 } = req.body;
  if (!code || !name) throw new Error('请填写配件编码和名称');
  if (Number(price) < 0) throw new Error('单价不能为负数');
  if (Number(warn_stock) < 0) throw new Error('警戒库存不能为负数');
  const dup = db.get('SELECT id, name FROM parts WHERE code = ? AND id != ?', [code, p.id]);
  if (dup) throw new Error(`配件编码 ${code} 已被「${dup.name}」使用，不能重复`);
  db.run('UPDATE parts SET code=?, name=?, category=?, unit=?, price=?, warn_stock=? WHERE id=?',
    [code, name, category, unit, Number(price), Number(warn_stock), p.id]);
  res.json(db.get('SELECT * FROM parts WHERE id = ?', [p.id]));
}));

// 删除配件（已有领用记录的禁止删除）
app.delete('/api/parts/:id', h((req, res) => {
  const p = db.get('SELECT * FROM parts WHERE id = ?', [req.params.id]);
  if (!p) throw new Error('配件不存在');
  const c = db.get('SELECT COUNT(*) c FROM part_usages WHERE part_id = ?', [p.id]).c;
  if (c > 0) throw new Error(`该配件已有 ${c} 条领用记录，不能删除；如不再使用可将库存清零`);
  db.run('DELETE FROM parts WHERE id = ?', [p.id]);
  res.json({ ok: true });
}));

// ============ 技师 ============
app.get('/api/technicians', h((req, res) => {
  // 返回全部技师（含已停用），派工下拉由前端过滤在职状态
  const rows = db.all(`
    SELECT t.*,
      (SELECT COUNT(*) FROM dispatches d WHERE d.technician_id = t.id AND d.status = 'assigned') AS active_jobs
    FROM technicians t ORDER BY t.active DESC, t.id`);
  res.json(rows);
}));

app.post('/api/technicians', h((req, res) => {
  const { name, phone = '', specialty = '' } = req.body;
  if (!name) throw new Error('请填写技师姓名');
  const id = db.run('INSERT INTO technicians(name,phone,specialty) VALUES (?,?,?)', [name, phone, specialty]);
  res.json(db.get('SELECT * FROM technicians WHERE id = ?', [id]));
}));

// 停用 / 重新启用技师（历史派工记录保留，仅不再出现在派工下拉中）
app.put('/api/technicians/:id/status', h((req, res) => {
  const t = db.get('SELECT * FROM technicians WHERE id = ?', [req.params.id]);
  if (!t) throw new Error('技师不存在');
  const active = req.body.active ? 1 : 0;
  if (!active && t.active) {
    const jobs = db.get(`SELECT COUNT(*) c FROM dispatches WHERE technician_id = ? AND status = 'assigned'`, [t.id]).c;
    if (jobs > 0) throw new Error(`${t.name} 还有 ${jobs} 个未完工的派工任务，请先完工或改派后再停用`);
  }
  db.run('UPDATE technicians SET active = ? WHERE id = ?', [active, t.id]);
  res.json(db.get('SELECT * FROM technicians WHERE id = ?', [t.id]));
}));

// ============ 维修工单 ============
app.get('/api/orders', h((req, res) => {
  const { status = '', q = '' } = req.query;
  let sql = `
    SELECT o.*, v.plate_no, v.brand, v.model, v.owner_name, v.owner_phone,
      (SELECT COUNT(*) FROM repair_items i WHERE i.order_id = o.id AND i.approval_status='pending') AS pending_items
    FROM repair_orders o JOIN vehicles v ON v.id = o.vehicle_id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND o.status = ?'; params.push(status); }
  if (q) {
    sql += ' AND (o.order_no LIKE ? OR v.plate_no LIKE ? OR v.owner_name LIKE ?)';
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' ORDER BY o.id DESC';
  res.json(db.all(sql, params));
}));

// 接待登记
app.post('/api/orders', h((req, res) => {
  const { vehicle_id, mileage = 0, fault_desc = '', receptionist = '', expected_delivery_at = '', remark = '', items = [] } = req.body;
  if (!vehicle_id) throw new Error('请选择车辆');
  if (Number(mileage) < 0) throw new Error('进厂里程不能为负数');
  if (!db.get('SELECT id FROM vehicles WHERE id = ?', [vehicle_id])) throw new Error('车辆不存在');
  items.forEach(it => {
    if (it.name && Number(it.labor_price) < 0) throw new Error(`项目「${it.name}」工时费不能为负数`);
  });
  // 单号生成放在事务内：持锁且已加载最新数据，多实例并发不会撞号
  const id = db.tx(() => {
    const orderNo = genOrderNo();
    const oid = db.run(`INSERT INTO repair_orders(order_no,vehicle_id,mileage,fault_desc,receptionist,expected_delivery_at,remark)
      VALUES (?,?,?,?,?,?,?)`, [orderNo, vehicle_id, Number(mileage), fault_desc, receptionist, expected_delivery_at, remark]);
    items.forEach(it => {
      if (!it.name) return;
      db.run(`INSERT INTO repair_items(order_id,name,category,labor_price,hours) VALUES (?,?,?,?,?)`,
        [oid, it.name, it.category || '机修', Number(it.labor_price) || 0, Number(it.hours) || 1]);
    });
    return oid;
  });
  res.json(db.get('SELECT * FROM repair_orders WHERE id = ?', [id]));
}));

// 工单详情
app.get('/api/orders/:id', h((req, res) => {
  const order = db.get(`
    SELECT o.*, v.plate_no, v.brand, v.model, v.vin, v.color, v.owner_name, v.owner_phone
    FROM repair_orders o JOIN vehicles v ON v.id = o.vehicle_id WHERE o.id = ?`, [req.params.id]);
  if (!order) throw new Error('工单不存在');
  const items = db.all('SELECT * FROM repair_items WHERE order_id = ? ORDER BY id', [order.id]);
  const dispatches = db.all(`
    SELECT d.*, t.name AS technician_name, i.name AS item_name
    FROM dispatches d JOIN technicians t ON t.id = d.technician_id
    LEFT JOIN repair_items i ON i.id = d.item_id
    WHERE d.order_id = ? ORDER BY d.id DESC`, [order.id]);
  const usages = db.all(`
    SELECT u.*, p.name AS part_name, p.code AS part_code, p.unit
    FROM part_usages u JOIN parts p ON p.id = u.part_id
    WHERE u.order_id = ? ORDER BY u.id DESC`, [order.id]);
  const qcs = db.all('SELECT * FROM quality_checks WHERE order_id = ? ORDER BY id DESC', [order.id]);
  const settlement = db.get('SELECT * FROM settlements WHERE order_id = ?', [order.id]);

  // 费用预估（普通项+已批准增项计入；待审批/已驳回增项不计，未退回配件计入）
  const itemsAmount = items
    .filter(i => i.approval_status === 'none' || i.approval_status === 'approved')
    .reduce((s, i) => s + i.labor_price, 0);
  const partsAmount = usages
    .filter(u => u.status === 'issued')
    .reduce((s, u) => s + u.quantity * u.unit_price, 0);

  res.json({ order, items, dispatches, usages, qcs, settlement, itemsAmount, partsAmount });
}));

// 添加维修项目（is_additional=1 时为增项，需审批）
app.post('/api/orders/:id/items', h((req, res) => {
  const order = getOrderOr404(req.params.id);
  // 仅接待/维修中可追加；进入待质检后工单项目即冻结
  if (!['reception', 'repairing'].includes(order.status)) throw new Error('当前状态不可添加项目（仅已接待/维修中可追加）');
  const { name, category = '机修', labor_price = 0, hours = 1, is_additional = 0 } = req.body;
  if (!name) throw new Error('请填写项目名称');
  if (Number(labor_price) < 0) throw new Error('工时费不能为负数');
  if (!(Number(hours) > 0)) throw new Error('工时必须大于0');
  const id = db.run(`INSERT INTO repair_items(order_id,name,category,labor_price,hours,is_additional,approval_status)
    VALUES (?,?,?,?,?,?,?)`,
    [order.id, name, category, Number(labor_price), Number(hours), is_additional ? 1 : 0, is_additional ? 'pending' : 'none']);
  touchOrder(order.id);
  res.json(db.get('SELECT * FROM repair_items WHERE id = ?', [id]));
}));

// 增项审批
app.post('/api/items/:id/approve', h((req, res) => {
  const item = db.get('SELECT * FROM repair_items WHERE id = ?', [req.params.id]);
  if (!item) throw new Error('项目不存在');
  if (item.approval_status !== 'pending') throw new Error('该项目不在待审批状态');
  db.run(`UPDATE repair_items SET approval_status = 'approved' WHERE id = ?`, [item.id]);
  touchOrder(item.order_id);
  res.json(db.get('SELECT * FROM repair_items WHERE id = ?', [item.id]));
}));

app.post('/api/items/:id/reject', h((req, res) => {
  const item = db.get('SELECT * FROM repair_items WHERE id = ?', [req.params.id]);
  if (!item) throw new Error('项目不存在');
  if (item.approval_status !== 'pending') throw new Error('该项目不在待审批状态');
  db.run(`UPDATE repair_items SET approval_status = 'rejected' WHERE id = ?`, [item.id]);
  touchOrder(item.order_id);
  res.json(db.get('SELECT * FROM repair_items WHERE id = ?', [item.id]));
}));

// 派工
app.post('/api/orders/:id/dispatch', h((req, res) => {
  const order = getOrderOr404(req.params.id);
  if (!['reception', 'repairing'].includes(order.status)) throw new Error('当前状态不可派工');
  const { technician_id, item_id = null, note = '' } = req.body;
  const tech = db.get('SELECT * FROM technicians WHERE id = ? AND active = 1', [technician_id]);
  if (!tech) throw new Error('技师不存在或已停用');
  if (item_id && !db.get('SELECT id FROM repair_items WHERE id = ? AND order_id = ?', [item_id, order.id]))
    throw new Error('维修项目不属于该工单');
  const id = db.tx(() => {
    const did = db.run('INSERT INTO dispatches(order_id,technician_id,item_id,note) VALUES (?,?,?,?)',
      [order.id, technician_id, item_id, note]);
    if (item_id) db.run(`UPDATE repair_items SET status = 'doing' WHERE id = ?`, [item_id]);
    if (order.status === 'reception') db.run(`UPDATE repair_orders SET status = 'repairing' WHERE id = ?`, [order.id]);
    return did;
  });
  touchOrder(order.id);
  res.json(db.get('SELECT * FROM dispatches WHERE id = ?', [id]));
}));

// 完成派工任务
app.post('/api/dispatches/:id/finish', h((req, res) => {
  const d = db.get('SELECT * FROM dispatches WHERE id = ?', [req.params.id]);
  if (!d) throw new Error('派工记录不存在');
  if (d.status === 'done') throw new Error('该任务已完工');
  db.tx(() => {
    db.run(`UPDATE dispatches SET status='done', finished_at=datetime('now','localtime') WHERE id = ?`, [d.id]);
    if (d.item_id) db.run(`UPDATE repair_items SET status='done' WHERE id = ?`, [d.item_id]);
  });
  touchOrder(d.order_id);
  res.json(db.get('SELECT * FROM dispatches WHERE id = ?', [d.id]));
}));

// 配件领用
app.post('/api/orders/:id/parts', h((req, res) => {
  const order = getOrderOr404(req.params.id);
  // 仅接待/维修中可领用；待质检后领料即冻结，质检不合格返修后恢复
  if (!['reception', 'repairing'].includes(order.status)) throw new Error('当前状态不可领用配件（仅已接待/维修中可领用）');
  const { part_id, quantity, issued_by = '' } = req.body;
  const qty = Number(quantity);
  if (!qty || qty <= 0) throw new Error('领用数量必须大于0');
  const part = db.get('SELECT * FROM parts WHERE id = ?', [part_id]);
  if (!part) throw new Error('配件不存在');
  if (part.stock < qty) throw new Error(`库存不足，当前库存 ${part.stock}${part.unit}`);
  const id = db.tx(() => {
    const uid = db.run('INSERT INTO part_usages(order_id,part_id,quantity,unit_price,issued_by) VALUES (?,?,?,?,?)',
      [order.id, part.id, qty, part.price, issued_by]);
    db.run('UPDATE parts SET stock = stock - ? WHERE id = ?', [qty, part.id]);
    return uid;
  });
  touchOrder(order.id);
  res.json(db.get('SELECT * FROM part_usages WHERE id = ?', [id]));
}));

// 配件退回
app.post('/api/usages/:id/return', h((req, res) => {
  const u = db.get('SELECT * FROM part_usages WHERE id = ?', [req.params.id]);
  if (!u) throw new Error('领用记录不存在');
  if (u.status === 'returned') throw new Error('该记录已退回');
  db.tx(() => {
    db.run(`UPDATE part_usages SET status='returned' WHERE id = ?`, [u.id]);
    db.run('UPDATE parts SET stock = stock + ? WHERE id = ?', [u.quantity, u.part_id]);
  });
  touchOrder(u.order_id);
  res.json(db.get('SELECT * FROM part_usages WHERE id = ?', [u.id]));
}));

// 完工申请 -> 待质检
app.post('/api/orders/:id/finish', h((req, res) => {
  const order = getOrderOr404(req.params.id);
  if (order.status !== 'repairing') throw new Error('仅维修中的工单可申请完工');
  const pending = db.get(`SELECT COUNT(*) c FROM repair_items WHERE order_id = ? AND approval_status = 'pending'`, [order.id]).c;
  if (pending > 0) throw new Error(`还有 ${pending} 个增项待审批，请先处理`);
  db.tx(() => {
    db.run(`UPDATE dispatches SET status='done', finished_at=datetime('now','localtime') WHERE order_id = ? AND status='assigned'`, [order.id]);
    db.run(`UPDATE repair_items SET status='done' WHERE order_id = ? AND approval_status != 'rejected'`, [order.id]);
    db.run(`UPDATE repair_orders SET status='qc' WHERE id = ?`, [order.id]);
  });
  touchOrder(order.id);
  res.json(getOrderOr404(order.id));
}));

// 完工质检
app.post('/api/orders/:id/qc', h((req, res) => {
  const order = getOrderOr404(req.params.id);
  if (order.status !== 'qc') throw new Error('该工单不在待质检状态');
  const { inspector, result, notes = '' } = req.body;
  if (!inspector) throw new Error('请填写质检员');
  if (!['pass', 'fail'].includes(result)) throw new Error('质检结果无效');
  db.tx(() => {
    db.run('INSERT INTO quality_checks(order_id,inspector,result,notes) VALUES (?,?,?,?)',
      [order.id, inspector, result, notes]);
    if (result === 'pass') {
      db.run(`UPDATE repair_orders SET status='settling' WHERE id = ?`, [order.id]);
    } else {
      // 质检不合格 -> 返修：工单退回维修中，项目重置为待施工以便重新派工
      db.run(`UPDATE repair_orders SET status='repairing' WHERE id = ?`, [order.id]);
      db.run(`UPDATE repair_items SET status='pending' WHERE order_id = ? AND approval_status != 'rejected'`, [order.id]);
    }
  });
  touchOrder(order.id);
  res.json(getOrderOr404(order.id));
}));

// 结算
app.post('/api/orders/:id/settle', h((req, res) => {
  const order = getOrderOr404(req.params.id);
  if (order.status !== 'settling') throw new Error('该工单不在待结算状态');
  if (db.get('SELECT id FROM settlements WHERE order_id = ?', [order.id])) throw new Error('该工单已结算');
  const { discount = 0, pay_method = '现金' } = req.body;
  if (Number(discount) < 0) throw new Error('优惠金额不能为负数');
  // 未审批增项不计费也不允许带着结算（正常流程到不了这里，兜底防御）
  const pending = db.get(`SELECT COUNT(*) c FROM repair_items WHERE order_id = ? AND approval_status = 'pending'`, [order.id]).c;
  if (pending > 0) throw new Error(`还有 ${pending} 个增项未审批，请先批准或驳回再结算`);
  // 仅计入：普通项 + 已批准增项；待审批/已驳回不计
  const itemsAmount = db.get(`SELECT COALESCE(SUM(labor_price),0) s FROM repair_items
    WHERE order_id = ? AND approval_status IN ('none','approved')`, [order.id]).s;
  const partsAmount = db.get(`SELECT COALESCE(SUM(u.quantity * u.unit_price),0) s FROM part_usages u
    WHERE u.order_id = ? AND u.status = 'issued'`, [order.id]).s;
  const total = Math.max(0, itemsAmount + partsAmount - Number(discount));
  db.tx(() => {
    db.run(`INSERT INTO settlements(order_id,items_amount,parts_amount,discount,total_amount,pay_method)
      VALUES (?,?,?,?,?,?)`, [order.id, itemsAmount, partsAmount, Number(discount), total, pay_method]);
    db.run(`UPDATE repair_orders SET status='delivering' WHERE id = ?`, [order.id]);
  });
  touchOrder(order.id);
  res.json(db.get('SELECT * FROM settlements WHERE order_id = ?', [order.id]));
}));

// 交车
app.post('/api/orders/:id/deliver', h((req, res) => {
  const order = getOrderOr404(req.params.id);
  if (order.status !== 'delivering') throw new Error('该工单不在待交车状态（需先完成结算）');
  db.run(`UPDATE repair_orders SET status='done', delivered_at=datetime('now','localtime') WHERE id = ?`, [order.id]);
  touchOrder(order.id);
  res.json(getOrderOr404(order.id));
}));

// 结算单查询
app.get('/api/settlements', h((req, res) => {
  res.json(db.all(`
    SELECT s.*, o.order_no, v.plate_no, v.owner_name
    FROM settlements s
    JOIN repair_orders o ON o.id = s.order_id
    JOIN vehicles v ON v.id = o.vehicle_id
    ORDER BY s.id DESC`));
}));

async function main() {
  await db.init();
  seedIfEmpty();
  app.listen(PORT, () => {
    console.log(`🚗 汽车4S店维修管理系统已启动: http://localhost:${PORT}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
