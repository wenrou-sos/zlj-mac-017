// 样例数据：车辆、配件、技师、各状态工单
const db = require('./db');

function seedIfEmpty() {
  const count = db.get('SELECT COUNT(*) AS c FROM vehicles').c;
  if (count > 0) return false;

  db.tx(() => {
    // 技师
    const techs = [
      ['王建国', '13800001111', '发动机/机修'],
      ['李明辉', '13800002222', '电气/电路'],
      ['张志强', '13800003333', '钣金/喷漆'],
      ['刘小虎', '13800004444', '保养/快修'],
    ];
    techs.forEach(t => db.run('INSERT INTO technicians(name,phone,specialty) VALUES (?,?,?)', t));

    // 车辆档案
    const vehicles = [
      ['沪A·D8821', '大众', '迈腾 2023款 380TSI', 'LFV3A23C1P5001234', '幻影黑', '陈先生', '13911110001'],
      ['沪B·T3356', '丰田', '凯美瑞 2022款 2.5G', 'LVGBE40K8NG012345', '珍珠白', '刘女士', '13911110002'],
      ['苏E·K9902', '宝马', '320Li 2024款 M运动', 'LBV5S3102RSM12345', '矿石白', '周先生', '13911110003'],
      ['浙A·P5567', '比亚迪', '汉EV 2023款 四驱', 'LGXCE4CB8P0123456', '赤帝红', '吴女士', '13911110004'],
      ['沪C·M1108', '别克', '君越 2021款 652T', 'LSGGB54E1MH012345', '陨铁灰', '郑先生', '13911110005'],
      ['皖B·Q7734', '奥迪', 'A4L 2023款 45TFSI', 'LFV2A21K3P5012345', '天云灰', '孙女士', '13911110006'],
    ];
    vehicles.forEach(v => db.run(
      'INSERT INTO vehicles(plate_no,brand,model,vin,color,owner_name,owner_phone) VALUES (?,?,?,?,?,?,?)', v));

    // 配件库存
    const parts = [
      ['PJ-0001', '机油滤芯', '保养件', '个', 45, 60, 10],
      ['PJ-0002', '全合成机油 5W-30', '油液', '升', 88, 120, 20],
      ['PJ-0003', '空气滤芯', '保养件', '个', 65, 40, 8],
      ['PJ-0004', '空调滤芯', '保养件', '个', 78, 35, 8],
      ['PJ-0005', '前刹车片(套)', '制动系统', '套', 320, 20, 5],
      ['PJ-0006', '刹车盘', '制动系统', '只', 260, 16, 4],
      ['PJ-0007', '火花塞', '发动机', '只', 55, 80, 16],
      ['PJ-0008', '蓄电池 60Ah', '电气', '只', 520, 10, 3],
      ['PJ-0009', '雨刮片(对)', '车身', '对', 96, 30, 6],
      ['PJ-0010', '防冻液 -35℃', '油液', '桶', 75, 25, 5],
      ['PJ-0011', '变速箱油 ATF', '油液', '升', 120, 4, 6],   // 库存低于警戒，演示预警
      ['PJ-0012', '正时皮带套件', '发动机', '套', 680, 6, 2],
    ];
    parts.forEach(p => db.run(
      'INSERT INTO parts(code,name,category,unit,price,stock,warn_stock) VALUES (?,?,?,?,?,?,?)', p));

    // ---- 工单 1：维修中（已派工，有待审批增项）----
    db.run(`INSERT INTO repair_orders(order_no,vehicle_id,mileage,fault_desc,receptionist,status,expected_delivery_at,remark)
      VALUES ('WX20260910001',1,32450,'行驶中发动机异响，加速无力','前台-小赵','repairing',datetime('now','localtime','+1 day'),'客户要求使用原厂件')`);
    db.run(`INSERT INTO repair_items(order_id,name,category,labor_price,hours,is_additional,approval_status,status)
      VALUES (1,'发动机异响检修','机修',300,3,0,'none','doing')`);
    db.run(`INSERT INTO repair_items(order_id,name,category,labor_price,hours,is_additional,approval_status,status)
      VALUES (1,'更换火花塞','机修',80,1,0,'none','doing')`);
    db.run(`INSERT INTO repair_items(order_id,name,category,labor_price,hours,is_additional,approval_status,status)
      VALUES (1,'更换正时皮带套件','机修',450,4,1,'pending','pending')`);
    db.run(`INSERT INTO dispatches(order_id,technician_id,item_id,note) VALUES (1,1,1,'优先排查正时系统')`);
    db.run(`INSERT INTO part_usages(order_id,part_id,quantity,unit_price,issued_by) VALUES (1,7,4,55,'王建国')`);
    db.run(`UPDATE parts SET stock = stock - 4 WHERE id = 7`);

    // ---- 工单 2：待质检 ----
    db.run(`INSERT INTO repair_orders(order_no,vehicle_id,mileage,fault_desc,receptionist,status,expected_delivery_at)
      VALUES ('WX20260910002',2,56100,'常规保养，更换刹车片','前台-小赵','qc',datetime('now','localtime','+6 hours'))`);
    db.run(`INSERT INTO repair_items(order_id,name,category,labor_price,hours,is_additional,approval_status,status)
      VALUES (2,'常规保养(机油三滤)','保养',150,1.5,0,'none','done')`);
    db.run(`INSERT INTO repair_items(order_id,name,category,labor_price,hours,is_additional,approval_status,status)
      VALUES (2,'更换前刹车片','制动',120,1,0,'none','done')`);
    db.run(`INSERT INTO dispatches(order_id,technician_id,item_id,note,status,finished_at)
      VALUES (2,4,1,'','done',datetime('now','localtime','-2 hours'))`);
    db.run(`INSERT INTO part_usages(order_id,part_id,quantity,unit_price,issued_by) VALUES (2,2,4,88,'刘小虎')`);
    db.run(`INSERT INTO part_usages(order_id,part_id,quantity,unit_price,issued_by) VALUES (2,1,1,45,'刘小虎')`);
    db.run(`INSERT INTO part_usages(order_id,part_id,quantity,unit_price,issued_by) VALUES (2,5,1,320,'刘小虎')`);
    db.run(`UPDATE parts SET stock = stock - 4 WHERE id = 2`);
    db.run(`UPDATE parts SET stock = stock - 1 WHERE id = 1`);
    db.run(`UPDATE parts SET stock = stock - 1 WHERE id = 5`);

    // ---- 工单 3：待结算（质检已通过，今天到期 -> 演示交车提醒）----
    db.run(`INSERT INTO repair_orders(order_no,vehicle_id,mileage,fault_desc,receptionist,status,expected_delivery_at)
      VALUES ('WX20260909001',3,41200,'空调不制冷，检查电路','前台-小钱','settling',datetime('now','localtime','+3 hours'))`);
    db.run(`INSERT INTO repair_items(order_id,name,category,labor_price,hours,is_additional,approval_status,status)
      VALUES (3,'空调系统检修','电气',260,2,0,'none','done')`);
    db.run(`INSERT INTO repair_items(order_id,name,category,labor_price,hours,is_additional,approval_status,status)
      VALUES (3,'更换蓄电池','电气',60,0.5,1,'approved','done')`);
    db.run(`INSERT INTO dispatches(order_id,technician_id,item_id,note,status,finished_at)
      VALUES (3,2,3,'','done',datetime('now','localtime','-5 hours'))`);
    db.run(`INSERT INTO part_usages(order_id,part_id,quantity,unit_price,issued_by) VALUES (3,8,1,520,'李明辉')`);
    db.run(`UPDATE parts SET stock = stock - 1 WHERE id = 8`);
    db.run(`INSERT INTO quality_checks(order_id,inspector,result,notes) VALUES (3,'质检-老周','pass','路试正常，空调制冷恢复')`);

    // ---- 工单 4：待交车（已结算，等客户取车）----
    db.run(`INSERT INTO repair_orders(order_no,vehicle_id,mileage,fault_desc,receptionist,status,expected_delivery_at)
      VALUES ('WX20260908001',4,18900,'前保险杠剐蹭喷漆','前台-小钱','delivering',datetime('now','localtime','-2 hours'))`);
    db.run(`INSERT INTO repair_items(order_id,name,category,labor_price,hours,is_additional,approval_status,status)
      VALUES (4,'前保险杠喷漆','钣喷',600,4,0,'none','done')`);
    db.run(`INSERT INTO dispatches(order_id,technician_id,item_id,note,status,finished_at)
      VALUES (4,3,4,'','done',datetime('now','localtime','-1 day'))`);
    db.run(`INSERT INTO quality_checks(order_id,inspector,result,notes) VALUES (4,'质检-老周','pass','漆面无色差')`);
    db.run(`INSERT INTO settlements(order_id,items_amount,parts_amount,discount,total_amount,pay_method)
      VALUES (4,600,0,0,600,'微信')`);

    // ---- 工单 5：已交车（历史单）----
    db.run(`INSERT INTO repair_orders(order_no,vehicle_id,mileage,fault_desc,receptionist,status,expected_delivery_at,delivered_at)
      VALUES ('WX20260905001',5,67800,'更换雨刮、防冻液','前台-小赵','done',datetime('now','localtime','-5 day'),datetime('now','localtime','-5 day'))`);
    db.run(`INSERT INTO repair_items(order_id,name,category,labor_price,hours,is_additional,approval_status,status)
      VALUES (5,'更换雨刮片','车身',30,0.5,0,'none','done')`);
    db.run(`INSERT INTO repair_items(order_id,name,category,labor_price,hours,is_additional,approval_status,status)
      VALUES (5,'更换防冻液','保养',50,0.5,0,'none','done')`);
    db.run(`INSERT INTO part_usages(order_id,part_id,quantity,unit_price,issued_by) VALUES (5,9,1,96,'刘小虎')`);
    db.run(`INSERT INTO part_usages(order_id,part_id,quantity,unit_price,issued_by) VALUES (5,10,1,75,'刘小虎')`);
    db.run(`UPDATE parts SET stock = stock - 1 WHERE id = 9`);
    db.run(`UPDATE parts SET stock = stock - 1 WHERE id = 10`);
    db.run(`INSERT INTO quality_checks(order_id,inspector,result,notes) VALUES (5,'质检-老周','pass','')`);
    db.run(`INSERT INTO settlements(order_id,items_amount,parts_amount,discount,total_amount,pay_method)
      VALUES (5,80,171,0,251,'支付宝')`);

    // ---- 工单 6：刚接待（未派工）----
    db.run(`INSERT INTO repair_orders(order_no,vehicle_id,mileage,fault_desc,receptionist,status,expected_delivery_at,remark)
      VALUES ('WX20260912001',6,28760,'变速箱换挡顿挫','前台-小钱','reception',datetime('now','localtime','+2 day'),'客户下午来店')`);
    db.run(`INSERT INTO repair_items(order_id,name,category,labor_price,hours,is_additional,approval_status,status)
      VALUES (6,'变速箱检测','机修',200,2,0,'none','pending')`);
  });

  console.log('✔ 样例数据已初始化');
  return true;
}

module.exports = { seedIfEmpty };
