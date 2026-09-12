// 汽车4S店维修管理系统 - 前端逻辑
const { createApp, reactive, ref, computed, onMounted } = Vue;

const api = async (url, method = 'GET', body) => {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
};

createApp({
  setup() {
    const view = ref('dashboard');
    const menus = [
      { key: 'dashboard', label: '工作台', icon: '📊' },
      { key: 'reception', label: '接待登记', icon: '📝' },
      { key: 'orders', label: '维修工单', icon: '🔧' },
      { key: 'parts', label: '配件库存', icon: '🔩' },
      { key: 'vehicles', label: '车辆档案', icon: '🚙' },
      { key: 'technicians', label: '技师管理', icon: '👨‍🔧' },
      { key: 'settlements', label: '结算记录', icon: '💰' },
    ];

    const toast = reactive({ msg: '', type: 'ok' });
    let toastTimer = null;
    const showToast = (msg, type = 'ok') => {
      toast.msg = msg; toast.type = type;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (toast.msg = ''), 2600);
    };
    const run = async (fn, okMsg) => {
      try { await fn(); if (okMsg) showToast(okMsg); }
      catch (e) { showToast(e.message, 'err'); }
    };

    // ---------- 工作台 ----------
    const dash = reactive({
      stats: {}, reminders: [], lowStockParts: [], pendingItems: [],
    });
    const loadDash = async () => Object.assign(dash, await api('/api/dashboard'));
    const badgeCount = computed(() => (dash.reminders?.length || 0) + (dash.pendingItems?.length || 0));

    // ---------- 工单 ----------
    const orders = ref([]);
    const ordersFilter = reactive({ status: '', q: '' });
    const statusTabs = [
      { key: '', label: '全部' }, { key: 'reception', label: '已接待' },
      { key: 'repairing', label: '维修中' }, { key: 'qc', label: '待质检' },
      { key: 'settling', label: '待结算' }, { key: 'delivering', label: '待交车' },
      { key: 'done', label: '已交车' },
    ];
    const statusLabel = s => ({ reception: '已接待', repairing: '维修中', qc: '待质检', settling: '待结算', delivering: '待交车', done: '已交车' }[s] || s);
    const loadOrders = async () => {
      orders.value = await api(`/api/orders?status=${ordersFilter.status}&q=${encodeURIComponent(ordersFilter.q)}`);
    };
    const goOrders = status => { ordersFilter.status = status; view.value = 'orders'; loadOrders(); };

    // ---------- 工单详情 ----------
    const detail = ref(null);
    const showDispatch = ref(false), showAddItem = ref(false), showUsage = ref(false),
          showQC = ref(false), showSettle = ref(false);
    const canEditOrder = computed(() =>
      detail.value && ['reception', 'repairing'].includes(detail.value.order.status));

    const openOrder = async id => {
      detail.value = await api(`/api/orders/${id}`);
      showDispatch.value = showAddItem.value = showUsage.value = showQC.value = showSettle.value = false;
      loadParts(); loadTechs();
    };
    const closeDetail = () => { detail.value = null; loadDash(); loadOrders(); };
    const refreshDetail = async () => { detail.value = await api(`/api/orders/${detail.value.order.id}`); };

    // 派工
    const dispatchForm = reactive({ technician_id: '', item_id: null, note: '' });
    const submitDispatch = () => run(async () => {
      if (!dispatchForm.technician_id) throw new Error('请选择技师');
      await api(`/api/orders/${detail.value.order.id}/dispatch`, 'POST', dispatchForm);
      Object.assign(dispatchForm, { technician_id: '', item_id: null, note: '' });
      showDispatch.value = false; await refreshDetail(); loadTechs();
    }, '派工成功');

    const finishDispatch = d => run(async () => {
      await api(`/api/dispatches/${d.id}/finish`, 'POST'); await refreshDetail(); loadTechs();
    }, '任务已完工');

    // 项目/增项
    const itemCategories = ['机修', '电气', '保养', '制动', '钣喷', '车身', '其他'];
    const itemForm = reactive({ name: '', category: '机修', labor_price: 0, hours: 1, is_additional: false });
    const submitItem = () => run(async () => {
      await api(`/api/orders/${detail.value.order.id}/items`, 'POST', itemForm);
      Object.assign(itemForm, { name: '', category: '机修', labor_price: 0, hours: 1, is_additional: false });
      showAddItem.value = false; await refreshDetail();
    }, '项目已添加');

    const approveItem = (i, inDetail) => run(async () => {
      await api(`/api/items/${i.id}/approve`, 'POST');
      if (inDetail) await refreshDetail(); await loadDash(); if (view.value === 'orders') loadOrders();
    }, '已批准增项');
    const rejectItem = (i, inDetail) => run(async () => {
      await api(`/api/items/${i.id}/reject`, 'POST');
      if (inDetail) await refreshDetail(); await loadDash(); if (view.value === 'orders') loadOrders();
    }, '已驳回增项');

    // 配件领用
    const usageForm = reactive({ part_id: '', quantity: 1, issued_by: '' });
    const submitUsage = () => run(async () => {
      if (!usageForm.part_id) throw new Error('请选择配件');
      await api(`/api/orders/${detail.value.order.id}/parts`, 'POST', usageForm);
      Object.assign(usageForm, { part_id: '', quantity: 1, issued_by: '' });
      showUsage.value = false; await refreshDetail(); loadParts();
    }, '领用成功');
    const returnUsage = u => run(async () => {
      await api(`/api/usages/${u.id}/return`, 'POST'); await refreshDetail(); loadParts();
    }, '已退回入库');

    // 完工 / 质检 / 结算 / 交车
    const finishRepair = () => run(async () => {
      await api(`/api/orders/${detail.value.order.id}/finish`, 'POST'); await refreshDetail();
    }, '已转入待质检');

    const qcForm = reactive({ inspector: '', result: 'pass', notes: '' });
    const submitQC = () => run(async () => {
      await api(`/api/orders/${detail.value.order.id}/qc`, 'POST', qcForm);
      Object.assign(qcForm, { inspector: '', result: 'pass', notes: '' });
      showQC.value = false; await refreshDetail();
    }, '质检已提交');

    const settleForm = reactive({ discount: 0, pay_method: '现金' });
    const submitSettle = () => run(async () => {
      await api(`/api/orders/${detail.value.order.id}/settle`, 'POST', settleForm);
      Object.assign(settleForm, { discount: 0, pay_method: '现金' });
      showSettle.value = false; await refreshDetail();
    }, '结算完成');

    const deliver = () => run(async () => {
      await api(`/api/orders/${detail.value.order.id}/deliver`, 'POST'); await refreshDetail();
    }, '已交车，感谢惠顾！');

    // ---------- 接待登记 ----------
    const recep = reactive({
      vehicleQ: '', vehicleList: [], showNewVehicle: false,
      newVehicle: { plate_no: '', brand: '', model: '', vin: '', color: '', owner_name: '', owner_phone: '' },
      form: { vehicle_id: null, mileage: 0, fault_desc: '', receptionist: '', expected_delivery_at: '', remark: '', items: [] },
    });
    const searchVehicles = async () => {
      recep.vehicleList = await api(`/api/vehicles?q=${encodeURIComponent(recep.vehicleQ)}`);
    };
    const createVehicle = () => run(async () => {
      const v = await api('/api/vehicles', 'POST', recep.newVehicle);
      recep.form.vehicle_id = v.id;
      recep.showNewVehicle = false;
      Object.keys(recep.newVehicle).forEach(k => (recep.newVehicle[k] = ''));
      await searchVehicles();
    }, '车辆档案已建立');
    const addRecepItem = () => recep.form.items.push({ name: '', category: '机修', labor_price: 0, hours: 1 });
    const submitReception = () => run(async () => {
      if (!recep.form.vehicle_id) throw new Error('请选择或新建车辆');
      const payload = { ...recep.form, expected_delivery_at: recep.form.expected_delivery_at.replace('T', ' ') };
      const order = await api('/api/orders', 'POST', payload);
      Object.assign(recep.form, { vehicle_id: null, mileage: 0, fault_desc: '', receptionist: '', expected_delivery_at: '', remark: '', items: [] });
      goOrders('');
      showToast(`工单 ${order.order_no} 创建成功`);
    });

    // ---------- 配件 ----------
    const parts = ref([]);
    const restockQty = reactive({});
    const partForm = reactive({ code: '', name: '', category: '通用', unit: '件', price: 0, stock: 0, warn_stock: 5 });
    const loadParts = async () => { parts.value = await api('/api/parts'); };
    const createPart = () => run(async () => {
      await api('/api/parts', 'POST', partForm);
      Object.assign(partForm, { code: '', name: '', category: '通用', unit: '件', price: 0, stock: 0, warn_stock: 5 });
      loadParts(); loadDash();
    }, '配件已保存');
    const restock = p => run(async () => {
      const qty = Number(restockQty[p.id]);
      if (!qty) throw new Error('请输入入库数量');
      await api(`/api/parts/${p.id}/restock`, 'POST', { quantity: qty });
      restockQty[p.id] = ''; loadParts(); loadDash();
    }, '入库成功');

    // ---------- 车辆 / 技师 / 结算 ----------
    const vehicles = ref([]);
    const vehicleQ = ref('');
    const loadVehicles = async () => {
      vehicles.value = await api(`/api/vehicles?q=${encodeURIComponent(vehicleQ.value)}`);
    };
    const technicians = ref([]);
    const techForm = reactive({ name: '', phone: '', specialty: '' });
    const loadTechs = async () => { technicians.value = await api('/api/technicians'); };
    const createTech = () => run(async () => {
      await api('/api/technicians', 'POST', techForm);
      Object.assign(techForm, { name: '', phone: '', specialty: '' });
      loadTechs();
    }, '技师已添加');
    const settlements = ref([]);
    const loadSettlements = async () => { settlements.value = await api('/api/settlements'); };

    // ---------- 通用 ----------
    const fmt = n => Number(n || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
    const apprLabel = s => ({ pending: '待审批', approved: '已批准', rejected: '已驳回' }[s] || s);
    const apprClass = s => ({ pending: 'tag-orange', approved: 'tag-green', rejected: 'tag-red' }[s]);
    const itemStatusLabel = s => ({ pending: '待施工', doing: '施工中', done: '已完成' }[s] || s);

    const go = key => {
      view.value = key;
      ({ dashboard: loadDash, orders: loadOrders, parts: loadParts,
         vehicles: loadVehicles, technicians: loadTechs, settlements: loadSettlements,
         reception: searchVehicles }[key] || (() => {}))();
    };

    onMounted(() => { loadDash(); searchVehicles(); setInterval(loadDash, 30000); });

    return {
      view, menus, go, toast, fmt,
      dash, badgeCount, goOrders,
      orders, ordersFilter, statusTabs, statusLabel, loadOrders,
      detail, openOrder, closeDetail, canEditOrder,
      showDispatch, showAddItem, showUsage, showQC, showSettle,
      dispatchForm, submitDispatch, finishDispatch,
      itemCategories, itemForm, submitItem, approveItem, rejectItem, apprLabel, apprClass, itemStatusLabel,
      usageForm, submitUsage, returnUsage,
      finishRepair, qcForm, submitQC, settleForm, submitSettle, deliver,
      recep, searchVehicles, createVehicle, addRecepItem, submitReception,
      parts, partForm, createPart, restock, restockQty,
      vehicles, vehicleQ, loadVehicles,
      technicians, techForm, createTech,
      settlements,
    };
  },
}).mount('#app');
