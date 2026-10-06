import Dexie, { type Table } from 'dexie';
import type { WoodBoard } from '../types/wood-board';
import type { SoundChamber } from '../types/sound-chamber';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { Stringing } from '../types/stringing';
import type { GuqinArchive, MaterialBatch, MaterialReview, QualityNotice } from '../types/material';

/** IndexedDB 库名（浏览器本地存储，无后端） */
export const DB_NAME = 'gbguqin-db';

/** 当前 schema 版本，与 db.version(n) 对应 */
export const SCHEMA_VERSION = 3;

class GuqinDB extends Dexie {
  boards!: Table<WoodBoard, string>;
  chambers!: Table<SoundChamber, string>;
  lacquers!: Table<LacquerLayer, string>;
  stringings!: Table<Stringing, string>;
  meta!: Table<{ key: string; value: string }, string>;
  /** 材料批次台账 */
  materialBatches!: Table<MaterialBatch, string>;
  /** 外部质检通知（含断点续传游标） */
  qualityNotices!: Table<QualityNotice, string>;
  /** 材料去向复核单 */
  materialReviews!: Table<MaterialReview, string>;
  /** 成琴归档登记 */
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

    // v3：材料去向对账。板材 / 髹漆遍次 / 上弦记录增加 batchNo 索引；
    // 新增材料批次台账、质检通知、复核单、成琴归档四张表。
    // 旧记录没有批次号（batchNo 缺省）即「来源不明」，不会进入任何批次索引、不被当污染冻结。
    this.version(3).stores({
      boards: 'id, boardNo, guqinNo, part, species, grain, receivedAt, batchNo',
      chambers: 'id, guqinNo, postPos, carvedAt',
      lacquers: 'id, guqinNo, seq, [guqinNo+seq], appliedAt, batchNo',
      stringings: 'id, guqinNo, stringType, strungAt, batchNo',
      meta: 'key',
      materialBatches: 'id, category, batchNo, [category+batchNo], status, receivedAt',
      qualityNotices: 'id, noticeNo, category, batchNo, status, importedAt',
      materialReviews: 'id, noticeId, [category+batchNo], recordId, guqinNo, status, frozenAt',
      archives: 'guqinNo, archivedAt',
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
