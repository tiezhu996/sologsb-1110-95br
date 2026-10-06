import { defineStore } from 'pinia';
import { db, UNKNOWN_BATCH } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import {
  collectUsageRefs,
  guqinsOfBatch,
  isUnknownBatch,
  reviewTaskKey,
  snapshotOf,
  usagesOfBatch,
  usagesOfGuqin,
} from '../utils/material';
import { useBoardStore } from './boardStore';
import { useLacquerStore } from './lacquerStore';
import { useStringingStore } from './stringingStore';
import type {
  GuqinArchive,
  MaterialBatch,
  MaterialType,
  NoticeBatchLine,
  QcNotice,
  ReviewTask,
  ReviewVerdict,
  UsageRef,
  UsageTable,
} from '../types/material';
import { TABLE_MATERIAL } from '../types/material';

export interface BatchInput {
  batchNo: string;
  materialType: MaterialType;
  supplier: string;
  receivedAt?: string;
  remark?: string;
}

export interface NoticeInput {
  noticeNo: string;
  title: string;
  supplier: string;
  receivedAt?: string;
  content: string;
  batches: NoticeBatchLine[];
}

export interface ImportResult {
  notice: QcNotice;
  /** 本次新冻结的记录数（已存在的待复核不重复计数） */
  frozen: number;
  /** 同一通知已处理完成、本次为重复导入（未重复冻结） */
  duplicated: boolean;
  /** 是否为失败后的断点续导 */
  resumed: boolean;
  warnings: string[];
}

export interface ReviewInput {
  verdict: ReviewVerdict;
  /** verdict=replace 时选定的替代批次号 */
  replacementBatchNo?: string;
  resultNote: string;
  reviewer: string;
}

interface MaterialState {
  batches: MaterialBatch[];
  notices: QcNotice[];
  reviews: ReviewTask[];
  archives: GuqinArchive[];
  hydrated: boolean;
}

/** 材料批次台账、质检通知导入、待复核与成琴归档闸门 */
export const useMaterialStore = defineStore('material', {
  state: (): MaterialState => ({ batches: [], notices: [], reviews: [], archives: [], hydrated: false }),

  getters: {
    batchByNo(state) {
      return (batchNo: string): MaterialBatch | undefined => state.batches.find((b) => b.batchNo === batchNo);
    },
    batchesOfType(state) {
      return (type: MaterialType): MaterialBatch[] =>
        state.batches.filter((b) => b.materialType === type).sort((a, b) => a.batchNo.localeCompare(b.batchNo));
    },

    /** 全部材料去向（板材 / 髹漆遍次 / 上弦统一结构） */
    usageRefs(): UsageRef[] {
      const boardStore = useBoardStore();
      const lacquerStore = useLacquerStore();
      const stringingStore = useStringingStore();
      return collectUsageRefs({
        boards: boardStore.boards,
        layers: lacquerStore.layers,
        stringings: stringingStore.stringings,
      });
    },
    refsOfBatch(): (batchNo: string) => UsageRef[] {
      return (batchNo: string) => usagesOfBatch(this.usageRefs, batchNo);
    },
    refsOfGuqin(): (guqinNo: string) => UsageRef[] {
      return (guqinNo: string) => usagesOfGuqin(this.usageRefs, guqinNo);
    },
    guqinsOfBatch(): (batchNo: string) => string[] {
      return (batchNo: string) => guqinsOfBatch(this.usageRefs, batchNo);
    },
    /** 台账中登记但尚无使用记录的批次 */
    unusedBatches(state): MaterialBatch[] {
      const used = new Set(this.usageRefs.map((ref) => ref.batchNo));
      return state.batches.filter((b) => !used.has(b.batchNo));
    },
    /** 使用记录上出现、但批次台账里查不到的批次号 */
    danglingBatchNos(): string[] {
      const known = new Set(this.batches.map((b) => b.batchNo));
      return Array.from(new Set(this.usageRefs.map((ref) => ref.batchNo)))
        .filter((batchNo) => !isUnknownBatch(batchNo) && !known.has(batchNo))
        .sort();
    },
    /** 旧数据来源不明的使用记录数 */
    unknownBatchCount(): number {
      return this.usageRefs.filter((ref) => isUnknownBatch(ref.batchNo)).length;
    },

    pendingReviews(state): ReviewTask[] {
      return state.reviews.filter((task) => task.status === 'pending');
    },
    reviewedReviews(state): ReviewTask[] {
      return state.reviews.filter((task) => task.status === 'reviewed');
    },
    pendingCountOf(state) {
      return (guqinNo: string): number =>
        state.reviews.filter((task) => task.status === 'pending' && task.guqinNo === guqinNo).length;
    },
    /** 有待复核记录、暂缓成琴归档的琴号 */
    blockedGuqinNos(): Set<string> {
      return new Set(this.pendingReviews.map((task) => task.guqinNo));
    },
    tasksOfNotice(state) {
      return (noticeId: string): ReviewTask[] =>
        state.reviews
          .filter((task) => task.noticeId === noticeId)
          .sort((a, b) => a.guqinNo.localeCompare(b.guqinNo) || a.table.localeCompare(b.table) || a.frozenAt.localeCompare(b.frozenAt));
    },
    archivedGuqinNos(state): Set<string> {
      return new Set(state.archives.map((a) => a.guqinNo));
    },
  },

  actions: {
    async hydrate() {
      const [batches, notices, reviews, archives] = await Promise.all([
        db.batches.orderBy('batchNo').toArray(),
        db.notices.orderBy('receivedAt').reverse().toArray(),
        db.reviews.toArray(),
        db.archives.orderBy('archivedAt').reverse().toArray(),
      ]);
      this.batches = batches;
      this.notices = notices;
      this.reviews = reviews;
      this.archives = archives;
      this.hydrated = true;
    },

    // ---------- 批次台账 ----------

    async addBatch(input: BatchInput): Promise<MaterialBatch> {
      const batchNo = input.batchNo.trim();
      if (this.batches.some((b) => b.batchNo === batchNo)) {
        throw new Error(`批次号 ${batchNo} 已在台账中登记`);
      }
      const batch: MaterialBatch = {
        id: uid('batch'),
        batchNo,
        materialType: input.materialType,
        supplier: input.supplier.trim(),
        receivedAt: input.receivedAt ?? new Date().toISOString(),
        remark: input.remark?.trim() || undefined,
      };
      await db.batches.put(toPlain(batch));
      this.batches = [...this.batches, batch].sort((a, b) => a.batchNo.localeCompare(b.batchNo));
      return batch;
    },

    async updateBatch(id: string, patch: Partial<BatchInput>) {
      const current = this.batches.find((b) => b.id === id);
      if (!current) return;
      const nextBatchNo = patch.batchNo?.trim() ?? current.batchNo;
      if (this.batches.some((b) => b.id !== id && b.batchNo === nextBatchNo)) {
        throw new Error(`批次号 ${nextBatchNo} 已被其他批次占用`);
      }
      const next: MaterialBatch = {
        ...current,
        batchNo: nextBatchNo,
        materialType: patch.materialType ?? current.materialType,
        supplier: patch.supplier?.trim() ?? current.supplier,
        receivedAt: patch.receivedAt ?? current.receivedAt,
        remark: patch.remark !== undefined ? patch.remark.trim() || undefined : current.remark,
      };
      await db.batches.put(toPlain(next));
      this.batches = this.batches.map((b) => (b.id === id ? next : b));
    },

    /** 已被使用记录引用的批次不允许删除（避免去向断链） */
    async removeBatch(id: string) {
      const current = this.batches.find((b) => b.id === id);
      if (!current) return;
      const used = this.usageRefs.some((ref) => ref.batchNo === current.batchNo);
      if (used) {
        throw new Error(`批次 ${current.batchNo} 已有工序记录引用，不能删除；可在通知处理后改挂替代批次`);
      }
      await db.batches.delete(id);
      this.batches = this.batches.filter((b) => b.id !== id);
    },

    // ---------- 质检通知（断点续导、重复幂等） ----------

    /**
     * 导入供应商质检通知；也用于失败后的重试（按 noticeNo 接续）。
     * 同一文号重复导入：已处理完成则不重复冻结；未完成则从 cursor 续导。
     */
    async importNotice(input: NoticeInput): Promise<ImportResult> {
      const noticeNo = input.noticeNo.trim();
      if (!noticeNo) throw new Error('请填写通知文号');
      const lines = normalizeLines(input.batches);
      if (!lines.length) throw new Error('通知至少包含一个停用批次');

      const existed = this.notices.find((n) => n.noticeNo === noticeNo);
      const resumed = Boolean(existed && existed.status !== 'processed');
      const duplicated = Boolean(existed && existed.status === 'processed');

      if (duplicated) {
        return { notice: existed!, frozen: 0, duplicated: true, resumed: false, warnings: [] };
      }

      let notice: QcNotice;
      if (existed) {
        // 续导：保留已冻结进度与原批次清单，仅刷新抬头信息
        notice = {
          ...existed,
          title: input.title.trim() || existed.title,
          supplier: input.supplier.trim() || existed.supplier,
          content: input.content.trim(),
          lastError: undefined,
          importedAt: new Date().toISOString(),
        };
      } else {
        notice = {
          id: uid('notice'),
          noticeNo,
          title: input.title.trim() || `质检通知 ${noticeNo}`,
          supplier: input.supplier.trim(),
          receivedAt: input.receivedAt ?? new Date().toISOString(),
          content: input.content.trim(),
          batches: lines,
          status: 'processing',
          cursor: 0,
          frozenCount: 0,
          importedAt: new Date().toISOString(),
        };
      }
      await db.notices.put(toPlain(notice));
      this.upsertNotice(notice);

      const warnings: string[] = [];
      let frozen = 0;
      let failedLine: { index: number; message: string } | undefined;

      // 逐批次处理：每条批次线一个事务并落 cursor，失败后从原进度继续。
      // 同线重试时靠 taskKey 去重，绝不重复冻结。
      for (let i = notice.cursor; i < notice.batches.length; i += 1) {
        const line = notice.batches[i];
        try {
          const created = await this.freezeBatchLine(notice, line);
          frozen += created;
          notice.cursor = i + 1;
          notice.status = i + 1 === notice.batches.length ? 'processed' : 'processing';
          const total = await db.reviews.where('noticeId').equals(notice.id).count();
          notice.frozenCount = total;
          notice.lastError = undefined;
          await db.notices.put(toPlain(notice));
          this.upsertNotice(notice);
        } catch (error) {
          failedLine = { index: i, message: (error as Error).message };
          break;
        }
      }

      if (failedLine) {
        notice.status = 'failed';
        notice.lastError = `第 ${failedLine.index + 1} 个批次「${notice.batches[failedLine.index].batchNo}」处理中断：${failedLine.message}`;
        notice.importedAt = new Date().toISOString();
        await db.notices.put(toPlain(notice));
        this.upsertNotice(notice);
        await this.refreshReviews();
        throw new Error(notice.lastError);
      }

      // 提示信息只做对账提醒，不影响冻结结果
      await this.refreshReviews();
      notice.batches.forEach((line) => {
        const ledger = this.batchByNo(line.batchNo);
        if (!ledger) {
          warnings.push(`批次 ${line.batchNo} 未在台账登记，已按实际使用记录冻结，请补录批次信息`);
        } else if (line.materialType && ledger.materialType !== line.materialType) {
          warnings.push(`批次 ${line.batchNo} 台账材料为「${ledger.materialType}」，与通知填写的「${line.materialType}」不一致`);
        }
        const hits = this.reviews.filter((task) => task.noticeId === notice.id && task.batchNo === line.batchNo).length;
        if (hits === 0) {
          warnings.push(`批次 ${line.batchNo} 没有任何工序记录使用，未冻结任何琴或遍次`);
        }
      });
      notice.status = 'processed';
      notice.lastMessage = warnings.length ? warnings.join('；') : '全部停用批次对账完成';
      await db.notices.put(toPlain(notice));
      this.upsertNotice(notice);

      return { notice, frozen, duplicated: false, resumed, warnings };
    },

    /**
     * 冻结一个停用批次：只冻结批次号完全相等的实际使用记录。
     * - 逐遍次/逐记录匹配：没碰过该批次的琴与遍次不受牵连
     * - 来源不明（旧数据无批次号）永不匹配，不当作污染
     * - taskKey 幂等：重复导入/断点续导不重复冻结
     */
    async freezeBatchLine(notice: QcNotice, line: NoticeBatchLine): Promise<number> {
      const batchNo = line.batchNo.trim();
      let created = 0;
      await db.transaction('rw', db.notices, db.reviews, db.boards, db.lacquers, db.stringings, async () => {
        const refs = await collectRefsByBatch(batchNo);
        for (const ref of refs) {
          const key = reviewTaskKey(notice.noticeNo, ref.table, ref.refId);
          const exists = await db.reviews.where('taskKey').equals(key).count();
          if (exists > 0) continue;
          const task: ReviewTask = {
            id: uid('review'),
            taskKey: key,
            noticeId: notice.id,
            noticeNo: notice.noticeNo,
            batchNo,
            materialType: TABLE_MATERIAL[ref.table],
            guqinNo: ref.guqinNo,
            table: ref.table,
            refId: ref.refId,
            snapshot: snapshotOf(ref),
            frozenAt: new Date().toISOString(),
            status: 'pending',
          };
          await db.reviews.put(toPlain(task));
          created += 1;
        }
      });
      return created;
    },

    // ---------- 复核处理 ----------

    /** 复核单条记录：选定替代批次并留下结果；原使用记录快照继续保留可追溯 */
    async resolveReview(taskId: string, input: ReviewInput): Promise<void> {
      const task = this.reviews.find((t) => t.id === taskId);
      if (!task) throw new Error('待复核记录不存在');
      if (task.status === 'reviewed') throw new Error('该记录已复核');

      const note = input.resultNote.trim();
      if (!note) throw new Error('请填写复核结果');
      const reviewer = input.reviewer.trim();
      if (!reviewer) throw new Error('请填写复核人');

      let replacementBatchNo: string | undefined;
      if (input.verdict === 'replace') {
        replacementBatchNo = input.replacementBatchNo?.trim();
        if (!replacementBatchNo) throw new Error('请选定替代批次');
        const replacement = this.batchByNo(replacementBatchNo);
        if (!replacement) throw new Error(`替代批次 ${replacementBatchNo} 不在台账中`);
        if (replacement.materialType !== task.materialType) {
          throw new Error(`替代批次必须为${task.materialType}类材料`);
        }
        if (replacementBatchNo === task.batchNo) throw new Error('替代批次不能与原停用批次相同');
      }

      const reviewedAt = new Date().toISOString();
      await db.transaction('rw', db.reviews, db.boards, db.lacquers, db.stringings, async () => {
        const update: Partial<ReviewTask> = {
          status: 'reviewed',
          verdict: input.verdict,
          replacementBatchNo,
          resultNote: note,
          reviewer,
          reviewedAt,
        };
        await db.reviews.update(taskId, toPlain(update));
        // 换料：原记录改挂替代批次；原批次与快照仍留在复核记录中可追溯
        if (input.verdict === 'replace' && replacementBatchNo) {
          await reassignUsageBatch(task.table, task.refId, replacementBatchNo);
        }
      });

      await this.refreshReviews();
      await this.refreshUsageTable(task.table);
    },

    /** 同通知同批次的待复核记录批量给出结论（逐把琴仍可单独改判），返回成功条数与逐条失败原因 */
    async resolveBatch(noticeId: string, batchNo: string, input: ReviewInput): Promise<{ done: number; errors: string[] }> {
      const tasks = this.reviews.filter(
        (task) => task.noticeId === noticeId && task.batchNo === batchNo && task.status === 'pending',
      );
      let done = 0;
      const errors: string[] = [];
      for (const task of tasks) {
        try {
          await this.resolveReview(task.id, input);
          done += 1;
        } catch (error) {
          errors.push(`${task.guqinNo} ${task.snapshot.label}：${(error as Error).message}`);
        }
      }
      return { done, errors };
    },

    // ---------- 成琴归档 ----------

    canArchive(guqinNo: string): boolean {
      return !this.blockedGuqinNos.has(guqinNo);
    },

    async archiveGuqin(guqinNo: string, remark?: string): Promise<void> {
      if (!this.canArchive(guqinNo)) {
        throw new Error(`${guqinNo} 还有 ${this.pendingCountOf(guqinNo)} 条待复核记录，暂缓成琴归档`);
      }
      if (this.archivedGuqinNos.has(guqinNo)) return;
      const archive: GuqinArchive = {
        id: uid('archive'),
        guqinNo,
        archivedAt: new Date().toISOString(),
        remark: remark?.trim() || undefined,
      };
      await db.archives.put(toPlain(archive));
      this.archives = [archive, ...this.archives];
    },

    async unarchiveGuqin(guqinNo: string): Promise<void> {
      const archive = this.archives.find((a) => a.guqinNo === guqinNo);
      if (!archive) return;
      await db.archives.delete(archive.id);
      this.archives = this.archives.filter((a) => a.id !== archive.id);
    },

    // ---------- 内部辅助 ----------

    upsertNotice(notice: QcNotice) {
      this.notices = [notice, ...this.notices.filter((n) => n.id !== notice.id)].sort((a, b) =>
        b.receivedAt.localeCompare(a.receivedAt),
      );
    },

    async refreshReviews() {
      this.reviews = await db.reviews.toArray();
    },

    async refreshUsageTable(table: UsageTable) {
      if (table === 'boards') await useBoardStore().hydrate();
      if (table === 'lacquers') await useLacquerStore().hydrate();
      if (table === 'stringings') await useStringingStore().hydrate();
    },
  },
});

/** 整理通知中的停用批次行：去空白、按批次号去重（保留首次出现的材料类型） */
function normalizeLines(lines: NoticeBatchLine[]): NoticeBatchLine[] {
  const map = new Map<string, NoticeBatchLine>();
  lines.forEach((line) => {
    const batchNo = line.batchNo.trim();
    if (!batchNo || map.has(batchNo)) return;
    map.set(batchNo, { batchNo, materialType: line.materialType });
  });
  return Array.from(map.values());
}

/** 在三个工序表中按批次号精确收集使用记录（在导入事务内调用） */
async function collectRefsByBatch(batchNo: string): Promise<UsageRef[]> {
  const [boards, layers, stringings] = await Promise.all([
    db.boards.where('batchNo').equals(batchNo).toArray(),
    db.lacquers.where('batchNo').equals(batchNo).toArray(),
    db.stringings.where('batchNo').equals(batchNo).toArray(),
  ]);
  return collectUsageRefs({ boards, layers, stringings }).filter((ref) => ref.batchNo === batchNo);
}

/** 复核换料时把原使用记录改挂替代批次（原去向仍保留在复核快照里） */
async function reassignUsageBatch(table: UsageTable, refId: string, batchNo: string): Promise<void> {
  if (table === 'boards') await db.boards.update(refId, { batchNo });
  if (table === 'lacquers') await db.lacquers.update(refId, { batchNo });
  if (table === 'stringings') await db.stringings.update(refId, { batchNo });
}

export { UNKNOWN_BATCH };
