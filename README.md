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
│       ├── types/             # wood-board / sound-chamber / lacquer-layer / stringing / material（+ ui.ts）
│       ├── stores/            # boardStore / chamberStore / lacquerStore / stringingStore / materialStore
│       ├── components/common/ # DimensionChart / LayerStack / ToneTextEditor / FilterBar / StatBadge / ProcessTimeline / EmptyPanel
│       ├── hooks/             # useGuqinFilter / useStageProgress
│       ├── pages/             # WorkshopBoard / BoardList / ChamberEditor / LacquerLedger / StringingLog / MaterialTrace（+ NotFound）
│       ├── router/index.ts    # 路由表
│       └── utils/             # layer.ts / db.ts / export.ts / material.ts / notice.ts（+ wood.ts / seed.ts / id.ts）
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 琴坯进度 | 选材/掏膛/灰胎/上弦四阶段统计、推进比、缺失项与工序动态 |
| `/boards` | 板材登记与配对 | 面板底板配对、含水率回显、厚度差、槽腹剖面标注 |
| `/chambers` | 槽腹尺寸记录 | 纳音/龙池/凤沼三处厚度、槽腹深度、天地柱与龙池凤沼尺寸，SVG 剖面标注 |
| `/lacquer` | 灰胎髹漆遍次 | 按遍次累加厚度、荫房温湿度窗口校验、层积条与养护天数 |
| `/stringing` | 上弦与音色评价 | 散音/按音/泛音三段纯文本评语、九德简述、缺陷标记与版本对照 |
| `/materials` | 材料去向对账 | 批次台账、批次↔琴/工序双向对账、质检通知导入冻结、复核处置、成琴归档管控 |

## 材料批次与质检对账

- **批次挂接**：板材（木料批次）、髹漆遍次（生漆批次）、上弦记录（琴弦批次）各带 `batchNo`。录入时可选择已登记批次或直接输入新批次号（自动登记进批次台账）；停用批次不能再用于新记录。
- **双向去向**：`/materials` 的「去向对账」既可从批次查到用在哪些琴、哪几道工序，也可从琴号回看每张琴各工序的材料来源。
- **旧数据不连坐**：没有批次号的旧记录标为「来源不明」，可按琴查看，但**不会**被任何质检通知当作污染冻结；通知只精确冻结批次号匹配、确实用过该批次的记录，没碰过该批次的琴与遍次不受影响。
- **通知导入（幂等 + 断点续传）**：支持 JSON（单条/数组）或每行 `通知号,类别,批次号[,供料商][,日期][,事由]`。通知编号（`noticeNo`）相同且已处理完成的重复导入直接跳过、不重复冻结；处理中断或失败时记录 `processedCount` 游标，重试从原进度继续。
- **复核处置**：冻结记录转为「待复核」，该琴自动暂缓成琴归档；复核时可选择「更换替代批次」（必须选定同类在用批次）/ 复检合格 / 判废重做 / 返工，并记录复核人与备注。处置只落在复核单上，**原使用记录与原批次不被改写、不删除，继续可追溯**；全部复核完成后解除暂缓。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbguqin-db`），表：`boards`、`chambers`、`lacquers`、`stringings`、`meta`、`materialBatches`（材料批次台账）、`qualityNotices`（质检通知与续传游标）、`materialReviews`（去向复核单）、`archives`（成琴归档）。
- `db.version(1)` 建表声明索引；`db.version(2).upgrade(...)` 为髹漆表增加 `[guqinNo+seq]` 复合索引并回填历史厚度；`db.version(3)` 为板材/髹漆/上弦三表增加 `batchNo` 索引并新增上述四张对账表（旧记录无批次号不进索引，即「来源不明」）。升级前可用顶栏「导出备份」导出全量 JSON。
- 首次打开且表为空时写入一批示例工序档案（`src/utils/seed.ts`），含已挂批次的记录、个别无批次旧记录，以及一个可直接演练导入冻结的示例生漆批次 `LQ-2510`（示例通知见材料对账页「填入示例」）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
- 对账流程有 Node 脚本断言（`scripts/material-flow.test.mts`，用 `fake-indexeddb`），覆盖精确冻结、重复导入幂等、失败断点续传、替代批次校验与来源不明不连坐：`npx esbuild scripts/material-flow.test.mts --bundle --platform=node --format=esm --outfile=/tmp/m.mjs && node /tmp/m.mjs`。
