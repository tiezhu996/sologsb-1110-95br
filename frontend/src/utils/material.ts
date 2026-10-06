import type { MaterialCategory } from '../types/material';
import { ARCHIVE_STATE_LABELS, type ArchiveState, type GuqinArchive, type MaterialBatch, type MaterialReview, type UsageRef } from '../types/material';
import type { WoodBoard } from '../types/wood-board';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { Stringing } from '../types/stringing';
import { db } from './db';

/** 批次台账主键：类别内批次号唯一 */
export function batchId(category: MaterialCategory, batchNo: string): string {
  return `${category}:${batchNo.trim()}`;
}

/** 是否登记了批次号；空批次号一律视为「来源不明」，不参与污染匹配 */
export function isKnownBatch(batchNo?: string | null): batchNo is string {
  return typeof batchNo === 'string' && batchNo.trim().length > 0;
}

/** 批次显示文字：旧数据没有批次号标为来源不明，不能直接当作污染 */
export function sourceLabel(batchNo?: string | null): string {
  return isKnownBatch(batchNo) ? batchNo.trim() : '来源不明';
}

/** 原使用记录 → 工序名（跨表对账时展示） */
export function woodStageLabel(board: WoodBoard): string {
  return `登记板材 ${board.boardNo}（${board.part}）`;
}
export function lacquerStageLabel(layer: LacquerLayer): string {
  return `第 ${layer.seq} 遍髹漆`;
}
export function stringStageLabel(stringing: Stringing): string {
  return `上弦（${stringing.stringType}）`;
}

/** 汇总三类记录的材料去向引用 */
export function buildUsageRefs(boards: WoodBoard[], layers: LacquerLayer[], stringings: Stringing[]): UsageRef[] {
  const refs: UsageRef[] = [];
  boards.forEach((b) => {
    refs.push({
      category: 'wood',
      recordId: b.id,
      guqinNo: b.guqinNo,
      stageLabel: woodStageLabel(b),
      batchNo: isKnownBatch(b.batchNo) ? b.batchNo!.trim() : '',
      at: b.receivedAt,
    });
  });
  layers.forEach((l) => {
    refs.push({
      category: 'lacquer',
      recordId: l.id,
      guqinNo: l.guqinNo,
      stageLabel: lacquerStageLabel(l),
      batchNo: isKnownBatch(l.batchNo) ? l.batchNo!.trim() : '',
      at: l.appliedAt,
    });
  });
  stringings.forEach((s) => {
    refs.push({
      category: 'string',
      recordId: s.id,
      guqinNo: s.guqinNo,
      stageLabel: stringStageLabel(s),
      batchNo: isKnownBatch(s.batchNo) ? s.batchNo!.trim() : '',
      at: s.strungAt,
    });
  });
  return refs;
}

/**
 * 登记/校验新录入的批次号：
 * - 空：来源不明，允许；
 * - 已登记为停用批次：拒绝（避免把判废批次继续用在新工序上）；
 * - 未登记批次号：自动登记一条「在用」批次（档案员后续补供料商），保证批次可对账。
 * 返回台账行（空批次号时返回 null）。
 */
export async function prepareBatch(
  category: MaterialCategory,
  rawBatchNo: string | undefined,
): Promise<MaterialBatch | null> {
  const batchNo = (rawBatchNo ?? '').trim();
  if (!batchNo) return null;
  const existing = await db.materialBatches.get(batchId(category, batchNo));
  if (existing) {
    if (existing.status === 'stopped') {
      throw new Error(`批次 ${batchNo} 已被质检通知停用，不能继续使用，请更换批次`);
    }
    return existing;
  }
  const batch: MaterialBatch = {
    id: batchId(category, batchNo),
    category,
    batchNo,
    receivedAt: new Date().toISOString(),
    status: 'active',
    remark: '录入使用记录时自动登记',
  };
  await db.materialBatches.put(batch);
  return batch;
}

/** 某条使用记录是否存在待复核（冻结）单；存在则禁止改动/删除，保证原记录可追溯 */
export async function hasPendingReview(
  category: MaterialCategory,
  recordId: string,
): Promise<MaterialReview | undefined> {
  const list = await db.materialReviews.where({ recordId }).toArray();
  return list.find((r) => r.category === category && r.status === 'pending');
}

/**
 * 计算一张琴的成琴归档状态。
 * - 有待复核（冻结）：已成琴归档 → 暂缓归档（held）；未归档 → 不可归档（held）；
 * - 四阶段齐备（面板/底板、槽腹、髹漆、上弦）：已归档 archived，否则可归档 ready；
 * - 四阶段缺项：not_ready。
 */
export function archiveStateOf(
  guqinNo: string,
  options: {
    boards: WoodBoard[];
    layers: LacquerLayer[];
    stringings: Stringing[];
    hasChamber: boolean;
    pendingReviews: MaterialReview[];
    archive?: GuqinArchive;
  },
): ArchiveState {
  const held = options.pendingReviews.some((r) => r.guqinNo === guqinNo);
  if (held) return 'held';

  const parts = options.boards.filter((b) => b.guqinNo === guqinNo);
  const stagesReady =
    parts.some((b) => b.part === '面板') &&
    parts.some((b) => b.part === '底板') &&
    options.hasChamber &&
    options.layers.some((l) => l.guqinNo === guqinNo) &&
    options.stringings.some((s) => s.guqinNo === guqinNo);

  if (options.archive) return 'archived';
  return stagesReady ? 'ready' : 'not_ready';
}

export const ARCHIVE_STATE_TAG_TYPE: Record<ArchiveState, 'info' | 'success' | 'warning' | 'danger'> = {
  not_ready: 'info',
  ready: 'success',
  archived: 'success',
  held: 'danger',
};

export { ARCHIVE_STATE_LABELS };

/** 通知/复核单按时间倒序 */
export function descByTime<T extends { frozenAt?: string; importedAt?: string }>(a: T, b: T): number {
  return (b.frozenAt ?? b.importedAt ?? '').localeCompare(a.frozenAt ?? a.importedAt ?? '');
}
