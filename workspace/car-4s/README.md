# 汽车4S店维修管理系统

基于 **Vue 3 + Node.js (Express) + SQLite** 的维修业务全流程管理系统。

## 功能

| 模块 | 说明 |
|------|------|
| 工作台 | 在修工单统计、今日/本月营收、**交车提醒**（逾期/24小时内到期/待取车）、待审批增项、低库存预警 |
| 接待登记 | 车辆建档/检索、故障描述、预检项目、预计交车时间，一键生成工单 |
| 维修工单 | 状态流转：已接待 → 维修中 → 待质检 → 待结算 → 待交车 → 已交车 |
| 维修派工 | 按技师专长派工（整单或指定项目），技师任务完工确认，空闲/忙碌状态 |
| 增项审批 | 维修中追加项目自动生成待审批增项，批准计入费用、驳回不计；未审批增项会拦截完工 |
| 配件领用 | 领用扣减库存（不足拦截）、可退回入库、库存低于警戒值预警 |
| 完工质检 | 质检合格进入结算，不合格退回返修，全程留痕 |
| 结算交车 | 工时费+配件费自动汇总、优惠、多种支付方式，结算后提醒客户取车 |
| 基础数据 | 车辆档案、配件库存（入库）、技师管理、结算记录 |

## 运行

```bash
npm install
npm start
```

打开 http://localhost:3000 （首次启动自动建库并写入样例数据：6辆车、12种配件、4名技师、6张不同状态的工单）

## 说明

- 数据库文件：`data/shop.sqlite`（删除后重启可重置为样例数据）
- SQLite 采用 sql.js（WASM 版），无需编译原生模块，每次写操作自动持久化到文件
- 前端为 Vue 3 全局构建版（`public/vendor/`），无需打包工具，离线可用

## 主要 API

```
GET  /api/dashboard              工作台统计+交车提醒
POST /api/orders                 接待登记建单
POST /api/orders/:id/dispatch    派工
POST /api/orders/:id/items       添加项目/增项
POST /api/items/:id/approve      增项批准（/reject 驳回）
POST /api/orders/:id/parts       配件领用
POST /api/usages/:id/return      配件退回
POST /api/orders/:id/finish      完工申请
POST /api/orders/:id/qc          完工质检
POST /api/orders/:id/settle      结算
POST /api/orders/:id/deliver     交车
```
