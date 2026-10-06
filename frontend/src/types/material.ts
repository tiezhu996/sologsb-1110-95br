/** 材料类别：木料（板材）/ 生漆（髹漆遍次）/ 琴弦（上弦记录） */
export type MaterialCategory = 'wood' | 'lacquer' | 'string';

export const MATERIAL_CATEGORIES: MaterialCategory[] = ['wood', 'lacquer', 'string'];

export const MATERIAL_CATEGORY_LABELS: Record<MaterialCategory, string> = {
  wood: '木料',
  lacquer: '生漆',
  string: '琴弦',
};

/** 批次状态 */
export type BatchStatus = 'active' | 'stopped';

/**
 * 材料批次台账（板材 / 生漆 / 琴弦共用）。
 * 主键为 id（类别 + 批次号），批次号在同一类别内唯一。
 */
export interface MaterialBatch {
  id: string;
  category: MaterialCategory;
  /** 供料商标称的材料批次号 */
  batchNo: string;
  /** 供料商 */
  supplier?: string;
  /** 入库时间 ISO */
  receivedAt: string;
  /** active 可用；stopped 停用（被判不能再用或人工停用） */
  status: BatchStatus;
  remark?: string;
}

/** 外部质检通知的状态 */
export type NoticeStatus = 'imported' | 'processing' | 'done' | 'failed';

export const NOTICE_STATUS_LABELS: Record<NoticeStatus, string> = {
  imported: '待处理',
  processing: '处理中',
  done: '已处理',
  failed: '失败可重试',
};

/**
 * 供料商外部质检通知：某材料批次被判不能再用。
 * noticeNo 是外部通知编号，重复导入同一通知不重复冻结。
 */
export interface QualityNotice {
  id: string;
  /** 外部通知编号（幂等键） */
  noticeNo: string;
  category: MaterialCategory;
  batchNo: string;
  /** 供料商 */
  supplier?: string;
  notifiedAt: string;
  importedAt: string;
  reason?: string;
  /** 原始导入文本（重试时从原进度继续，不必重新上传） */
  rawText?: string;
  status: NoticeStatus;
  /** 已扫描的目标记录条数（断点续传游标） */
  processedCount: number;
  totalCount: number;
  frozenCount: number;
  /** 最近一次失败信息 */
  lastError?: string;
}

/** 复核结果 */
export type ReviewResult = 'replace' | 'keep_after_check' | 'scrap' | 'rework';

export const REVIEW_RESULT_LABELS: Record<ReviewResult, string> = {
  replace: '更换替代批次',
  keep_after_check: '复检合格继续使用',
  scrap: '判废重做该工序',
  rework: '返工处理',
};

/** 只有「更换替代批次」必须选定替代批次 */
export const REVIEW_RESULTS: ReviewResult[] = ['replace', 'keep_after_check', 'scrap', 'rework'];

/** 复核状态 */
export type ReviewStatus = 'pending' | 'resolved';

/**
 * 材料去向复核单：一条「记录 × 通知」对应一条待复核。
 * 复核处理只落在复核单上，原使用记录不被改写，继续可追溯。
 */
export interface MaterialReview {
  id: string;
  noticeId: string;
  noticeNo: string;
  category: MaterialCategory;
  /** 被判停用的批次号（原使用批次） */
  batchNo: string;
  /** 被冻结的原使用记录 id */
  recordId: string;
  guqinNo: string;
  /** 工序名（登记板材 / 第 N 遍髹漆 / 上弦），便于跨表展示 */
  stageLabel: string;
  frozenAt: string;
  status: ReviewStatus;
  /** 复核结果 */
  result?: ReviewResult;
  /** 选定的替代批次（仅 result=replace 时必填） */
  replacementBatchNo?: string;
  reviewer?: string;
  reviewNote?: string;
  resolvedAt?: string;
}

/** 成琴归档状态 */
export type ArchiveState = 'not_ready' | 'ready' | 'archived' | 'held';

export const ARCHIVE_STATE_LABELS: Record<ArchiveState, string> = {
  not_ready: '工序未齐',
  ready: '可归档',
  archived: '已成琴归档',
  held: '暂缓归档',
};

/** 成琴归档登记 */
export interface GuqinArchive {
  guqinNo: string;
  archivedAt: string;
  operator: string;
  remark?: string;
}

/** 复核单与被冻结记录的快照关联（去向对账明细用） */
export interface UsageRef {
  category: MaterialCategory;
  recordId: string;
  guqinNo: string;
  stageLabel: string;
  batchNo: string;
  at: string;
}
