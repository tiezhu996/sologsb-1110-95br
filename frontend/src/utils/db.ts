import Dexie, { type Table } from 'dexie';
import type { WoodBoard } from '../types/wood-board';
import type { SoundChamber } from '../types/sound-chamber';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { Stringing } from '../types/stringing';
import type { GuqinArchive, MaterialBatch, QcNotice, ReviewTask } from '../types/material';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbguqin-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

/** 旧数据没有批次号时的统一标记（来源不明 ≠ 污染） */
export const UNKNOWN_BATCH = '';

class GuqinDB extends Dexie {
  boards!: Table<WoodBoard, string>;
  chambers!: Table<SoundChamber, string>;
  lacquers!: Table<LacquerLayer, string>;
  stringings!: Table<Stringing, string>;
  meta!: Table<{ key: string; value: string }, string>;
  batches!: Table<MaterialBatch, string>;
  notices!: Table<QcNotice, string>;
  reviews!: Table<ReviewTask, string>;
  archives!: Table<GuqinArchive, string>;

  constructor() {
    super(DB_NAME);

    // v1：建表声明索引
    this.version(1).stores({
      boards: 'id, boardNo, guqinNo, part, species, grain, receivedAt',
      chambers: 'id, guqinNo, postPos, carvedAt',
      lacquers: 'id, guqinNo, seq, appliedAt',
      stringings: 'id, guqinNo, stringType, strungAt',
      meta: 'key',
    });

    // v2：髹漆表增加 (guqinNo+seq) 复合索引，便于按遍次排序查询；并回填历史 layerThickness。
    // 升级前请在顶栏「导出备份」导出 JSON。
    this.version(2)
      .stores({
        boards: 'id, boardNo, guqinNo, part, species, grain, receivedAt',
        chambers: 'id, guqinNo, postPos, carvedAt',
        lacquers: 'id, guqinNo, seq, [guqinNo+seq], appliedAt',
        stringings: 'id, guqinNo, stringType, strungAt',
        meta: 'key',
      })
      .upgrade(async (tx) => {
        await tx
          .table('lacquers')
          .toCollection()
          .modify((row: LacquerLayer) => {
            if (!row.layerThickness && row.totalThickness) {
              row.layerThickness = row.totalThickness;
            }
          });
      });

    // v3：材料去向对账。
    // - boards/lacquers/stringings 增加 batchNo 索引（旧数据升级后保持 undefined，按「来源不明」展示，不冻结）
    // - batches：材料批次台账；notices：供应商质检通知（status+cursor 支持断点续导）
    // - reviews：待复核记录（taskKey 唯一保证重复导入幂等）；archives：成琴归档登记
    this.version(3)
      .stores({
        boards: 'id, boardNo, guqinNo, part, species, grain, receivedAt, batchNo',
        chambers: 'id, guqinNo, postPos, carvedAt',
        lacquers: 'id, guqinNo, seq, [guqinNo+seq], appliedAt, batchNo',
        stringings: 'id, guqinNo, stringType, strungAt, batchNo',
        meta: 'key',
        batches: 'id, batchNo, materialType, receivedAt',
        notices: 'id, noticeNo, status, receivedAt',
        reviews: 'id, taskKey, noticeId, batchNo, guqinNo, status, table, refId',
        archives: 'id, guqinNo, archivedAt',
      })
      .upgrade(async () => {
        // 历史记录没有批次号：不写值、保持 undefined，读取时归一化为 UNKNOWN_BATCH（来源不明），
        // 绝不按污染批次处理。此处无需逐条改写数据。
      });
  }
}

export const db = new GuqinDB();

export async function getMeta(key: string): Promise<string | undefined> {
  const row = await db.meta.get(key);
  return row?.value;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await db.meta.put({ key, value });
}
