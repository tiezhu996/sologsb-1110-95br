# 古琴斫制工序记录台（gbguqin）

面向斫琴师与琴坊档案员：把面板底板材、槽腹尺寸、灰胎髹漆遍次与上弦记录串成可回溯的工序档案；音色评价只用文字填写，不做音频文件与波形处理。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21810>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | Vue 3 + TypeScript（`<script setup>`） |
| 构建 | Vite 6（`npm run build` 含 `vue-tsc --noEmit` 类型检查） |
| UI | Element Plus 2 |
| 路由 | Vue Router 4（6 条业务路由 + 404） |
| 状态 | Pinia（boardStore / chamberStore / lacquerStore / stringingStore / materialStore） |
| 存储 | IndexedDB（Dexie，库名 `gbguqin-db`） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21810
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # wood-board / sound-chamber / lacquer-layer / stringing（+ ui.ts）
│       ├── stores/            # boardStore / chamberStore / lacquerStore / stringingStore
│       ├── components/common/ # DimensionChart / LayerStack / ToneTextEditor / FilterBar / StatBadge / ProcessTimeline / EmptyPanel
│       ├── hooks/             # useGuqinFilter / useStageProgress
│       ├── pages/             # WorkshopBoard / BoardList / ChamberEditor / LacquerLedger / StringingLog / MaterialTrace（+ NotFound）
│       ├── router/index.ts    # 路由表
│       └── utils/             # layer.ts / db.ts / export.ts / material.ts（+ wood.ts / seed.ts / id.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 琴坯进度 | 选材/掏膛/灰胎/上弦四阶段统计、推进比、缺失项与工序动态 |
| `/boards` | 板材登记与配对 | 面板底板配对、含水率回显、厚度差、槽腹剖面标注 |
| `/chambers` | 槽腹尺寸记录 | 纳音/龙池/凤沼三处厚度、槽腹深度、天地柱与龙池凤沼尺寸，SVG 剖面标注 |
| `/lacquer` | 灰胎髹漆遍次 | 按遍次累加厚度、荫房温湿度窗口校验、层积条与养护天数 |
| `/stringing` | 上弦与音色评价 | 散音/按音/泛音三段纯文本评语、九德简述、缺陷标记与版本对照 |
| `/traceability` | 材料去向对账 | 材料批次台账；批次↔琴/工序双向追溯；外部质检通知导入、精确冻结、待复核与替代批次；成琴归档闸门 |

## 材料去向对账与质检冻结规则

- 板材（`boards.batchNo` / 木料）、髹漆每一遍（`lacquers.batchNo` / 生漆）、上弦记录（`stringings.batchNo` / 琴弦）都挂材料批次；从批次可查到琴与各工序，从琴可回看全部材料来源。
- **旧数据**没有批次号的统一显示为「来源不明」，只是信息缺失，**不直接当作污染**，任何通知都不会冻结它。
- 在「材料对账 → 供应商质检通知」导入外部停用通知（文号 + 停用批次清单）：
  - 只把**批次号完全相等**、**确实用过**该批次的使用记录转成「待复核」；髹漆按遍次逐条命中，没碰过该批次的琴与遍次不受牵连。
  - 有待复核记录的琴在「成琴归档」页暂缓归档，待复核清零后才能归档；通知不修改、不删除任何原使用记录。
  - 复核时可选定替代批次（换料会把原记录改挂替代批次，停用批次号与冻结时快照仍保留在复核记录中可追溯），或给出「复检可用 / 作废返工」结论与文字结果。
  - **同一文号重复导入不重复冻结**（确定性 `taskKey=文号|表|记录id` 幂等）；导入中断后重试，按通知的批次游标 `cursor` 从原进度继续，不重头冻结。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbguqin-db`），表：`boards`、`chambers`、`lacquers`、`stringings`、`batches`、`notices`、`reviews`、`archives`、`meta`。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为髹漆表增加 `[guqinNo+seq]` 复合索引并回填历史厚度；`db.version(3)` 为三张工序表增加 `batchNo` 索引并新建批次台账 / 通知 / 待复核 / 归档四张表（历史记录不写批次号，按来源不明展示）。升级前可用顶栏「导出备份」导出全量 JSON。
- 首次打开且表为空时写入一批示例工序档案（`src/utils/seed.ts`，含批次台账与少量「来源不明」旧记录）。
- 对账逻辑集成测试：`cd frontend && npm test`（基于 fake-indexeddb，覆盖精确冻结、来源不明不冻结、重复导入幂等、三个断点位置的续导、复核换料与归档闸门）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
