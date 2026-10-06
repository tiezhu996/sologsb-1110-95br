import type { WoodBoard } from '../types/wood-board';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { Stringing } from '../types/stringing';
import {
  MATERIAL_TYPES,
  TABLE_STAGE_LABEL,
  type MaterialType,
  type UsageRef,
  type UsageSnapshot,
  type UsageTable,
} from '../types/material';
import { UNKNOWN_BATCH } from './db';

/** 读取记录上挂的批次号；旧数据缺字段时归一化为来源不明（绝不视为污染） */
export function recordBatchNo(record: { batchNo?: string }): string {
  const value = record.batchNo?.trim();
  return value ? value : UNKNOWN_BATCH;
}

/** 来源不明的展示文案 */
export const UNKNOWN_BATCH_LABEL = '来源不明';

export function batchLabelOf(batchNo: string): string {
  return batchNo === UNKNOWN_BATCH ? UNKNOWN_BATCH_LABEL : batchNo;
}

interface BoardView {
  boards: WoodBoard[];
}
interface LacquerView {
  layers: LacquerLayer[];
}
interface StringingView {
  stringings: Stringing[];
}

/** 板材记录 → 去向描述 */
function boardRef(board: WoodBoard): UsageRef {
  return {
    table: 'boards',
    refId: board.id,
    guqinNo: board.guqinNo,
    batchNo: recordBatchNo(board),
    label: `${board.boardNo}（${board.part}）`,
    detail: `${board.species} · ${board.thicknessMm}mm · 阴干 ${board.dryYears} 年${board.defect !== '无' ? ` · ${board.defect}` : ''}`,
    usedAt: board.receivedAt,
    operator: board.remark ?? '',
  };
}

/** 髹漆遍次 → 去向描述 */
function layerRef(layer: LacquerLayer): UsageRef {
  return {
    table: 'lacquers',
    refId: layer.id,
    guqinNo: layer.guqinNo,
    batchNo: recordBatchNo(layer),
    label: `第 ${layer.seq} 遍`,
    detail: `配比 ${layer.mixRatio} · 本遍 ${layer.layerThickness}mm · 累计 ${layer.totalThickness}mm · ${layer.curingTemp}℃/${layer.curingHumidity}%`,
    usedAt: layer.appliedAt,
    operator: layer.operator,
  };
}

/** 上弦记录 → 去向描述 */
function stringingRef(stringing: Stringing): UsageRef {
  return {
    table: 'stringings',
    refId: stringing.id,
    guqinNo: stringing.guqinNo,
    batchNo: recordBatchNo(stringing),
    label: `${stringing.stringType}上弦`,
    detail: `弦距 ${stringing.stringGap}mm · ${stringing.nut} · 缺陷 ${stringing.defects.join('/')}`,
    usedAt: stringing.strungAt,
    operator: stringing.operator,
  };
}

/** 汇总全部使用记录（板材 / 髹漆遍次 / 上弦）为统一去向结构 */
export function collectUsageRefs(data: BoardView & LacquerView & StringingView): UsageRef[] {
  return [
    ...data.boards.map(boardRef),
    ...data.layers.map(layerRef),
    ...data.stringings.map(stringingRef),
  ];
}

/** 某批次下的全部去向（按工序、琴号排序） */
export function usagesOfBatch(refs: UsageRef[], batchNo: string): UsageRef[] {
  return refs
    .filter((ref) => ref.batchNo === batchNo)
    .sort((a, b) => a.table.localeCompare(b.table) || a.guqinNo.localeCompare(b.guqinNo) || a.usedAt.localeCompare(b.usedAt));
}

/** 某张琴上全部材料来源（可从琴回看材料） */
export function usagesOfGuqin(refs: UsageRef[], guqinNo: string): UsageRef[] {
  return refs
    .filter((ref) => ref.guqinNo === guqinNo)
    .sort((a, b) => a.table.localeCompare(b.table) || a.usedAt.localeCompare(b.usedAt));
}

/** 该批次实际用到的琴号（去重排序） */
export function guqinsOfBatch(refs: UsageRef[], batchNo: string): string[] {
  return Array.from(new Set(usagesOfBatch(refs, batchNo).map((ref) => ref.guqinNo))).sort();
}

/** 冻结时留存的使用记录快照 */
export function snapshotOf(ref: UsageRef): UsageSnapshot {
  return { label: ref.label, detail: ref.detail, usedAt: ref.usedAt, operator: ref.operator };
}

/**
 * 待复核记录确定性主键：同一通知 + 同一条使用记录只冻结一次。
 * 不含批次号：即使日后记录改挂别的批次，同通知下也不会重复生成待复核。
 */
export function reviewTaskKey(noticeNo: string, table: UsageTable, refId: string): string {
  return `${noticeNo}__${table}__${refId}`;
}

/** 批次是否为来源不明（旧数据不得直接当作污染） */
export function isUnknownBatch(batchNo: string): boolean {
  return batchNo === UNKNOWN_BATCH;
}

/** 各材料类型在去向列表中的工序阶段标签 */
export function stageLabelOf(table: UsageTable): string {
  return TABLE_STAGE_LABEL[table];
}

/** 三类材料的全部已知批次号（供录入使用记录时下拉选择） */
export function batchNosByType(batches: { batchNo: string; materialType: MaterialType }[], type: MaterialType): string[] {
  return batches.filter((b) => b.materialType === type).map((b) => b.batchNo);
}

export { MATERIAL_TYPES };
