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

    // 弹窗与服务端状态同步：轮询 + 操作前校验
    // 注意：各子表单数据存放在独立的 reactive 对象中，刷新 detail 不会冲掉正在填写的内容
    const detailSync = reactive({ error: false, lastAt: '' });
    let detailTimer = null;

    const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const closeSubForms = () => {
      showDispatch.value = showAddItem.value = showUsage.value = showQC.value = showSettle.value = false;
    };
    // 状态变化后只收起与新状态不符的子表单，符合的保持打开（内容不丢）
    const reconcileSubForms = status => {
      if (!['reception', 'repairing'].includes(status)) {
        showDispatch.value = showAddItem.value = showUsage.value = false;
      }
      if (status !== 'qc') showQC.value = false;
      if (status !== 'settling') showSettle.value = false;
    };
    const applyFresh = fresh => {
      detail.value = fresh;
      detailSync.error = false;
      detailSync.lastAt = now();
    };
    const fetchFresh = () => api(`/api/orders/${detail.value.order.id}`);

    // 静默轮询：其他终端改动后自动跟上
    const silentRefresh = async () => {
      if (!detail.value) return;
      try {
        const fresh = await fetchFresh();
        const statusChanged = fresh.order.status !== detail.value.order.status;
        const changed = fresh.order.updated_at !== detail.value.order.updated_at;
        if (statusChanged) {
          applyFresh(fresh);
          reconcileSubForms(fresh.order.status);
          showToast(`工单已被其他终端推进为「${statusLabel(fresh.order.status)}」，可执行操作已更新`, 'err');
        } else if (changed) {
          applyFresh(fresh); // 静默更新（新增的项目/领料等会直接显示）
        } else {
          detailSync.error = false;
          detailSync.lastAt = now();
        }
      } catch (e) {
        detailSync.error = true; // 网络异常：保留当前展示，仅做标记
      }
    };

    const startDetailSync = () => {
      stopDetailSync();
      detailSync.error = false;
      detailSync.lastAt = now();
      detailTimer = setInterval(silentRefresh, 5000);
    };
    const stopDetailSync = () => {
      if (detailTimer) { clearInterval(detailTimer); detailTimer = null; }
    };

    // 操作前校验：状态已被其他终端改变时，刷新弹窗并中止本次操作
    const preActionCheck = async () => {
      if (!detail.value) return true;
      try {
        const fresh = await fetchFresh();
        if (fresh.order.updated_at === detail.value.order.updated_at) return true;
        const statusChanged = fresh.order.status !== detail.value.order.status;
        applyFresh(fresh);
        reconcileSubForms(fresh.order.status);
        if (statusChanged) {
          showToast(`这张工单已经进入「${statusLabel(fresh.order.status)}」，请按最新状态操作`, 'err');
          return false;
        }
        return true; // 仅内容有更新（状态未变），刷新后放行
      } catch (e) {
        showToast('网络异常，无法确认工单最新状态，请稍后重试', 'err');
        return false;
      }
    };

    const openOrder = id => run(async () => {
      detail.value = await api(`/api/orders/${id}`);
      closeSubForms();
      loadParts(); loadTechs();
      startDetailSync();
    });
    const closeDetail = () => {
      stopDetailSync();
      detail.value = null;
      loadDash(); loadOrders();
    };
    const refreshDetail = async () => { applyFresh(await fetchFresh()); };

    // 派工
    const dispatchForm = reactive({ technician_id: '', item_id: null, note: '' });
    const submitDispatch = () => run(async () => {
      if (!dispatchForm.technician_id) throw new Error('请选择技师');
      if (!await preActionCheck()) return;
      await api(`/api/orders/${detail.value.order.id}/dispatch`, 'POST', dispatchForm);
      Object.assign(dispatchForm, { technician_id: '', item_id: null, note: '' });
      showDispatch.value = false; await refreshDetail(); loadTechs();
    }, '派工成功');

    const finishDispatch = d => run(async () => {
      if (!await preActionCheck()) return;
      await api(`/api/dispatches/${d.id}/finish`, 'POST'); await refreshDetail(); loadTechs();
    }, '任务已完工');

    // 项目/增项
    const itemCategories = ['机修', '电气', '保养', '制动', '钣喷', '车身', '其他'];
    const itemForm = reactive({ name: '', category: '机修', labor_price: 0, hours: 1, is_additional: false });
    const submitItem = () => run(async () => {
      if (!await preActionCheck()) return;
      await api(`/api/orders/${detail.value.order.id}/items`, 'POST', itemForm);
      Object.assign(itemForm, { name: '', category: '机修', labor_price: 0, hours: 1, is_additional: false });
      showAddItem.value = false; await refreshDetail();
    }, '项目已添加');

    const approveItem = (i, inDetail) => run(async () => {
      if (inDetail && !await preActionCheck()) return;
      await api(`/api/items/${i.id}/approve`, 'POST');
      if (inDetail) await refreshDetail(); await loadDash(); if (view.value === 'orders') loadOrders();
    }, '已批准增项');
    const rejectItem = (i, inDetail) => run(async () => {
      if (inDetail && !await preActionCheck()) return;
      await api(`/api/items/${i.id}/reject`, 'POST');
      if (inDetail) await refreshDetail(); await loadDash(); if (view.value === 'orders') loadOrders();
    }, '已驳回增项');

    // 配件领用
    const usageForm = reactive({ part_id: '', quantity: 1, issued_by: '' });
    const submitUsage = () => run(async () => {
      if (!usageForm.part_id) throw new Error('请选择配件');
      if (!await preActionCheck()) return;
      await api(`/api/orders/${detail.value.order.id}/parts`, 'POST', usageForm);
      Object.assign(usageForm, { part_id: '', quantity: 1, issued_by: '' });
      showUsage.value = false; await refreshDetail(); loadParts();
    }, '领用成功');
    const returnUsage = u => run(async () => {
      if (!await preActionCheck()) return;
      await api(`/api/usages/${u.id}/return`, 'POST'); await refreshDetail(); loadParts();
    }, '已退回入库');

    // 完工 / 质检 / 结算 / 交车
    const finishRepair = () => run(async () => {
      if (!await preActionCheck()) return;
      await api(`/api/orders/${detail.value.order.id}/finish`, 'POST'); await refreshDetail();
    }, '已转入待质检');

    const qcForm = reactive({ inspector: '', result: 'pass', notes: '' });
    const submitQC = () => run(async () => {
      if (!await preActionCheck()) return;
      await api(`/api/orders/${detail.value.order.id}/qc`, 'POST', qcForm);
      Object.assign(qcForm, { inspector: '', result: 'pass', notes: '' });
      showQC.value = false; await refreshDetail();
    }, '质检已提交');

    const settleForm = reactive({ discount: 0, pay_method: '现金' });
    const submitSettle = () => run(async () => {
      if (!await preActionCheck()) return;
      await api(`/api/orders/${detail.value.order.id}/settle`, 'POST', settleForm);
      Object.assign(settleForm, { discount: 0, pay_method: '现金' });
      showSettle.value = false; await refreshDetail();
    }, '结算完成');

    const deliver = () => run(async () => {
      if (!await preActionCheck()) return;
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
    const partEdit = ref(null);
    const loadParts = async () => { parts.value = await api('/api/parts'); };
    const createPart = () => run(async () => {
      await api('/api/parts', 'POST', partForm);
      Object.assign(partForm, { code: '', name: '', category: '通用', unit: '件', price: 0, stock: 0, warn_stock: 5 });
      loadParts(); loadDash();
    }, '配件已保存');
    const startEditPart = p => { partEdit.value = { ...p }; };
    const savePart = () => run(async () => {
      await api(`/api/parts/${partEdit.value.id}`, 'PUT', partEdit.value);
      partEdit.value = null;
      loadParts(); loadDash();
    }, '配件已更新');
    const removePart = p => run(async () => {
      if (!confirm(`确定删除配件「${p.code} ${p.name}」吗？`)) return;
      await api(`/api/parts/${p.id}`, 'DELETE');
      loadParts(); loadDash();
      showToast('配件已删除');
    });
    const restock = p => run(async () => {
      const qty = Number(restockQty[p.id]);
      if (!qty) throw new Error('请输入入库数量');
      await api(`/api/parts/${p.id}/restock`, 'POST', { quantity: qty });
      restockQty[p.id] = ''; loadParts(); loadDash();
    }, '入库成功');

    // ---------- 车辆 / 技师 / 结算 ----------
    const vehicles = ref([]);
    const vehicleQ = ref('');
    const vehicleEdit = ref(null);
    const loadVehicles = async () => {
      vehicles.value = await api(`/api/vehicles?q=${encodeURIComponent(vehicleQ.value)}`);
    };
    const startEditVehicle = v => { vehicleEdit.value = { ...v }; };
    const saveVehicle = () => run(async () => {
      await api(`/api/vehicles/${vehicleEdit.value.id}`, 'PUT', vehicleEdit.value);
      vehicleEdit.value = null;
      loadVehicles();
    }, '车辆档案已更新');
    const removeVehicle = v => run(async () => {
      if (!confirm(`确定删除车辆档案「${v.plate_no}（${v.owner_name}）」吗？`)) return;
      await api(`/api/vehicles/${v.id}`, 'DELETE');
      loadVehicles();
      showToast('车辆档案已删除');
    });

    const technicians = ref([]);
    const techForm = reactive({ name: '', phone: '', specialty: '' });
    const loadTechs = async () => { technicians.value = await api('/api/technicians'); };
    const activeTechnicians = computed(() => technicians.value.filter(t => t.active));
    const createTech = () => run(async () => {
      await api('/api/technicians', 'POST', techForm);
      Object.assign(techForm, { name: '', phone: '', specialty: '' });
      loadTechs();
    }, '技师已添加');
    const toggleTech = t => run(async () => {
      const action = t.active ? '停用' : '重新启用';
      if (t.active && !confirm(`确定停用技师「${t.name}」吗？停用后将不再出现在派工下拉中，历史派工记录保留。`)) return;
      await api(`/api/technicians/${t.id}/status`, 'PUT', { active: t.active ? 0 : 1 });
      loadTechs();
      showToast(`已${action}技师 ${t.name}`);
    });
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
      detail, openOrder, closeDetail, canEditOrder, detailSync,
      showDispatch, showAddItem, showUsage, showQC, showSettle,
      dispatchForm, submitDispatch, finishDispatch,
      itemCategories, itemForm, submitItem, approveItem, rejectItem, apprLabel, apprClass, itemStatusLabel,
      usageForm, submitUsage, returnUsage,
      finishRepair, qcForm, submitQC, settleForm, submitSettle, deliver,
      recep, searchVehicles, createVehicle, addRecepItem, submitReception,
      parts, partForm, createPart, restock, restockQty, partEdit, startEditPart, savePart, removePart,
      vehicles, vehicleQ, loadVehicles, vehicleEdit, startEditVehicle, saveVehicle, removeVehicle,
      technicians, techForm, createTech, toggleTech, activeTechnicians,
      settlements,
    };
  },
}).mount('#app');
