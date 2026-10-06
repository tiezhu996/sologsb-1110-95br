/** 受外部质检通知约束的材料大类 */
export type MaterialType = '木料' | '生漆' | '琴弦';

/** 受影响的工序记录表（与 IndexedDB 表名对应） */
export type UsageTable = 'boards' | 'lacquers' | 'stringings';

/** 质检通知处理状态 */
export type NoticeStatus = 'processing' | 'processed' | 'failed';

/** 单条待复核记录状态 */
export type ReviewStatus = 'pending' | 'reviewed';

/** 复核结论 */
export type ReviewVerdict = 'replace' | 'keep' | 'scrap';

export const MATERIAL_TYPES: MaterialType[] = ['木料', '生漆', '琴弦'];

/** 材料 → 挂批次的工序记录表 */
export const MATERIAL_TABLES: Record<MaterialType, UsageTable[]> = {
  木料: ['boards'],
  生漆: ['lacquers'],
  琴弦: ['stringings'],
};

/** 工序记录 → 使用的材料 */
export const TABLE_MATERIAL: Record<UsageTable, MaterialType> = {
  boards: '木料',
  lacquers: '生漆',
  stringings: '琴弦',
};

/** 各工序在四阶段流程中的标签 */
export const TABLE_STAGE_LABEL: Record<UsageTable, string> = {
  boards: '选材（面板/底板）',
  lacquers: '灰胎髹漆（按遍次）',
  stringings: '上弦',
};

/** 材料批次台账（板材、生漆、琴弦共用） */
export interface MaterialBatch {
  id: string;
  /** 材料批次号，全类型唯一 */
  batchNo: string;
  /** 材料大类 */
  materialType: MaterialType;
  /** 供应商 */
  supplier: string;
  /** 入库日期 ISO */
  receivedAt: string;
  /** 备注（产地、规格等） */
  remark?: string;
}

/** 通知内一个停用批次 */
export interface NoticeBatchLine {
  /** 批次号 */
  batchNo: string;
  /** 材料大类（供应商文件可选；导入时与台账比对） */
  materialType?: MaterialType;
}

/** 供应商外部质检通知 */
export interface QcNotice {
  id: string;
  /** 通知文号：同一文号重复导入不重复冻结 */
  noticeNo: string;
  /** 通知标题 */
  title: string;
  /** 供应商 */
  supplier: string;
  /** 通知到达日期 ISO */
  receivedAt: string;
  /** 通知正文摘要 */
  content: string;
  /** 停用批次清单 */
  batches: NoticeBatchLine[];

  /** 处理状态：导入中断重试时从游标继续 */
  status: NoticeStatus;
  /** 已处理到的批次下标（含已处理项数） */
  cursor: number;
  /** 已冻结（生成待复核）的使用记录累计条数 */
  frozenCount: number;
  /** 最近一次导入/重试结果说明（含未登记批次、类型不符等提示） */
  lastMessage?: string;
  /** 最近一次失败原因（status=failed 时） */
  lastError?: string;
  /** 最近一次导入时间 ISO */
  importedAt: string;
}

/** 待复核记录对原使用记录的快照（原记录继续可追溯） */
export interface UsageSnapshot {
  /** 记录标题（板材号 / 第 N 遍 / 弦材质） */
  label: string;
  /** 工序明细文字 */
  detail: string;
  /** 业务日期 ISO（入库 / 施工 / 上弦） */
  usedAt: string;
  /** 操作人 / 登记人 */
  operator: string;
}

/** 质检待复核记录：一条使用记录 × 一条通知，冻结判定唯一 */
export interface ReviewTask {
  id: string;
  /** 确定性主键（noticeNo|table|refId 哈希），重复导入天然幂等 */
  taskKey: string;
  /** 来源通知 */
  noticeId: string;
  noticeNo: string;
  /** 停用批次号（原批次） */
  batchNo: string;
  materialType: MaterialType;
  /** 涉及琴号 */
  guqinNo: string;
  /** 来源工序表与记录 */
  table: UsageTable;
  refId: string;
  /** 冻结时的使用记录快照 */
  snapshot: UsageSnapshot;
  /** 冻结时间 ISO */
  frozenAt: string;

  /** 复核状态 */
  status: ReviewStatus;
  /** 复核结论 */
  verdict?: ReviewVerdict;
  /** 选定的替代批次（verdict=replace 时） */
  replacementBatchNo?: string;
  /** 复核结果文字 */
  resultNote?: string;
  /** 复核人 */
  reviewer?: string;
  /** 复核时间 ISO */
  reviewedAt?: string;
}

/** 成琴归档登记 */
export interface GuqinArchive {
  id: string;
  guqinNo: string;
  /** 归档时间 ISO */
  archivedAt: string;
  /** 备注（成琴号、入藏人等） */
  remark?: string;
}

/** 批次 → 琴与工序的一条去向 */
export interface UsageRef {
  table: UsageTable;
  refId: string;
  guqinNo: string;
  /** 记录当前挂的批次号；空字符串表示旧数据来源不明 */
  batchNo: string;
  label: string;
  detail: string;
  usedAt: string;
  operator: string;
}
