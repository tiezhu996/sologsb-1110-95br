import { defineStore } from 'pinia';
import { db } from '../utils/db';
import { uid } from '../utils/id';
import { toPlain } from '../utils/plain';
import { batchId, descByTime } from '../utils/material';
import { parseNoticeText, type NoticeInput } from '../utils/notice';
import type { LacquerLayer } from '../types/lacquer-layer';
import type { Stringing } from '../types/stringing';
import type { WoodBoard } from '../types/wood-board';
import type {
  GuqinArchive,
  MaterialBatch,
  MaterialCategory,
  MaterialReview,
  QualityNotice,
  ReviewResult,
} from '../types/material';
import { lacquerStageLabel, stringStageLabel, woodStageLabel } from '../utils/material';

/** 单批扫描条数：每扫一批让出一次事件循环并落游标，中断后可从原进度继续 */
const CHUNK_SIZE = 50;
const yieldTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface MaterialState {
  batches: MaterialBatch[];
  notices: QualityNotice[];
  reviews: MaterialReview[];
  archives: GuqinArchive[];
  hydrated: boolean;
}

interface ResolveInput {
  result: ReviewResult;
  replacementBatchNo?: string;
  reviewer?: string;
  reviewNote?: string;
}

/** 一张通知对应一条「记录 × 通知」的待复核单 */
function reviewOf(notice: QualityNotice, recordId: string, guqinNo: string, stageLabel: string): MaterialReview {
  return {
    id: uid('review'),
    noticeId: notice.id,
    noticeNo: notice.noticeNo,
    category: notice.category,
    batchNo: notice.batchNo,
    recordId,
    guqinNo,
    stageLabel,
    frozenAt: new Date().toISOString(),
    status: 'pending',
  };
}

/** 材料批次台账 + 质检通知 + 复核单 + 成琴归档 */
export const useMaterialStore = defineStore('material', {
  state: (): MaterialState => ({ batches: [], notices: [], reviews: [], archives: [], hydrated: false }),

  getters: {
    /** 待复核总数（顶栏/菜单角标可用） */
    pendingCount(state): number {
      return state.reviews.filter((r) => r.status === 'pending').length;
    },
    activeNotices(state): QualityNotice[] {
      return [...state.notices].sort(descByTime);
    },
    batchesOfCategory(state) {
      return (category: MaterialCategory): MaterialBatch[] =>
        state.batches
          .filter((b) => b.category === category)
          .sort((a, b) => a.batchNo.localeCompare(b.batchNo));
    },
    batchOptionsOfCategory(state) {
      return (category: MaterialCategory): string[] =>
        state.batches
          .filter((b) => b.category === category && b.status === 'active')
          .map((b) => b.batchNo)
          .sort((a, b) => a.localeCompare(b));
    },
    /** 某记录的待复核单（冻结态） */
    pendingReviewOf(state) {
      return (category: MaterialCategory, recordId: string): MaterialReview | undefined =>
        state.reviews.find((r) => r.category === category && r.recordId === recordId && r.status === 'pending');
    },
    /** 某琴的待复核（暂缓成琴归档判定用） */
    pendingReviewsOfGuqin(state) {
      return (guqinNo: string): MaterialReview[] =>
        state.reviews.filter((r) => r.guqinNo === guqinNo && r.status === 'pending');
    },
    archiveOf(state) {
      return (guqinNo: string): GuqinArchive | undefined => state.archives.find((a) => a.guqinNo === guqinNo);
    },
  },

  actions: {
    async hydrate() {
      const [batches, notices, reviews, archives] = await Promise.all([
        db.materialBatches.toArray(),
        db.qualityNotices.toArray(),
        db.materialReviews.orderBy('frozenAt').reverse().toArray(),
        db.archives.toArray(),
      ]);
      this.batches = batches;
      this.notices = notices;
      this.reviews = reviews;
      this.archives = archives;
      this.hydrated = true;
    },

    // ---------------- 批次台账 ----------------

    async upsertBatch(input: {
      category: MaterialCategory;
      batchNo: string;
      supplier?: string;
      receivedAt?: string;
      status?: MaterialBatch['status'];
      remark?: string;
    }): Promise<MaterialBatch> {
      const batchNo = input.batchNo.trim();
      if (!batchNo) throw new Error('请填写批次号');
      const id = batchId(input.category, batchNo);
      const existed = this.batches.find((b) => b.id === id);
      const batch: MaterialBatch = {
        id,
        category: input.category,
        batchNo,
        supplier: input.supplier?.trim() || existed?.supplier,
        receivedAt: input.receivedAt ?? existed?.receivedAt ?? new Date().toISOString(),
        status: input.status ?? existed?.status ?? 'active',
        remark: input.remark !== undefined ? input.remark.trim() || undefined : existed?.remark,
      };
      await db.materialBatches.put(toPlain(batch));
      this.batches = this.batches.some((b) => b.id === id)
        ? this.batches.map((b) => (b.id === id ? batch : b))
        : [...this.batches, batch];
      return batch;
    },

    async setBatchStatus(id: string, status: MaterialBatch['status']) {
      const batch = this.batches.find((b) => b.id === id);
      if (!batch) return;
      const next = { ...batch, status };
      await db.materialBatches.put(toPlain(next));
      this.batches = this.batches.map((b) => (b.id === id ? next : b));
    },

    /** 删除批次：已被使用记录或复核单引用的批次不能删，避免去向断链 */
    async removeBatch(id: string): Promise<void> {
      const batch = this.batches.find((b) => b.id === id);
      if (!batch) return;
      const usedBoards = await db.boards.where('batchNo').equals(batch.batchNo).count();
      const usedLayers = await db.lacquers.where('batchNo').equals(batch.batchNo).count();
      const usedStrings = await db.stringings.where('batchNo').equals(batch.batchNo).count();
      const reviewed = this.reviews.filter(
        (r) => r.category === batch.category && r.batchNo === batch.batchNo,
      ).length;
      if (usedBoards + usedLayers + usedStrings + reviewed > 0) {
        throw new Error('该批次已被使用记录或复核单引用，不能删除（可改为停用）');
      }
      await db.materialBatches.delete(id);
      this.batches = this.batches.filter((b) => b.id !== id);
    },

    // ---------------- 质检通知导入（幂等 + 断点续传） ----------------

    /**
     * 导入供料商质检通知文本。
     * - noticeNo 重复且已处理完成：跳过，不重复冻结；
     * - 处于处理中/失败：沿用原通知记录从 processedCount 续扫；
     * - 新通知：建档后立即扫描；任一通知抛错不影响其它通知，失败信息记录在通知上。
     */
    async importNoticeText(text: string): Promise<{ created: number; resumed: number; skipped: number; failed: number }> {
      const inputs = parseNoticeText(text); // 先整体校验，非法则一条都不导入
      const result = { created: 0, resumed: 0, skipped: 0, failed: 0 };

      for (const input of inputs) {
        try {
          const existed = await db.qualityNotices.where('noticeNo').equals(input.noticeNo).first();
          if (existed) {
            if (existed.status === 'done') {
              result.skipped += 1;
              continue;
            }
            // processing / failed / imported：从原进度继续
            result.resumed += 1;
            await this.processNotice(existed.id);
          } else {
            const notice: QualityNotice = {
              id: uid('notice'),
              noticeNo: input.noticeNo,
              category: input.category,
              batchNo: input.batchNo,
              supplier: input.supplier,
              notifiedAt: input.notifiedAt ?? new Date().toISOString(),
              importedAt: new Date().toISOString(),
              reason: input.reason,
              rawText: text,
              status: 'processing',
              processedCount: 0,
              totalCount: 0,
              frozenCount: 0,
            };
            await db.qualityNotices.put(toPlain(notice));
            result.created += 1;
            await this.processNotice(notice.id);
          }
        } catch (e) {
          result.failed += 1;
          // 兜底：记录最近一次错误到对应通知（能定位到时）
          const notice = await db.qualityNotices.where('noticeNo').equals(input.noticeNo).first();
          if (notice && notice.status !== 'done') {
            await db.qualityNotices.put(toPlain({ ...notice, status: 'failed', lastError: (e as Error).message }));
            this.syncNotice(await db.qualityNotices.get(notice.id));
          }
        }
      }

      await this.hydrate();
      return result;
    },

    /** 失败通知重试：从原进度（processedCount）继续 */
    async retryNotice(noticeId: string): Promise<void> {
      await this.processNotice(noticeId);
      await this.hydrate();
    },

    /**
     * 扫描一张通知命中的使用记录。
     * 只冻结确实用过该批次（精确匹配非空批次号）的记录；来源不明与其它批次不受牵连。
     * 按批次索引取目标 → 按稳定顺序逐条扫描 → 已存在复核单则不重复冻结；
     * 每处理 CHUNK_SIZE 条落一次游标，中断/失败后重试从游标继续。
     */
    async processNotice(noticeId: string): Promise<void> {
      const notice = await db.qualityNotices.get(noticeId);
      if (!notice) throw new Error('通知不存在');
      if (notice.status === 'done') return;

      const targets = await this.fetchTargets(notice.category, notice.batchNo);

      let processed = notice.processedCount;
      let frozen = notice.frozenCount;
      await this.markNotice(noticeId, { status: 'processing', totalCount: targets.length, lastError: undefined });

      try {
        while (processed < targets.length) {
          const end = Math.min(processed + CHUNK_SIZE, targets.length);
          const chunk = targets.slice(processed, end);
          for (const target of chunk) {
            const dup = await db.materialReviews
              .where({ recordId: target.recordId })
              .toArray()
              .then((list) => list.some((r) => r.noticeId === noticeId));
            if (!dup) {
              await db.materialReviews.put(toPlain(reviewOf(notice, target.recordId, target.guqinNo, target.stageLabel)));
              frozen += 1;
            }
          }
          processed = end;
          await this.markNotice(noticeId, { processedCount: processed, frozenCount: frozen });
          await yieldTick();
        }

        // 扫描完成：批次停用（后续新记录不能再选），通知收尾
        const batch = await db.materialBatches.get(batchId(notice.category, notice.batchNo));
        if (batch && batch.status !== 'stopped') {
          await db.materialBatches.put(toPlain({ ...batch, status: 'stopped' }));
        }
        await this.markNotice(noticeId, {
          status: 'done',
          processedCount: targets.length,
          totalCount: targets.length,
          frozenCount: frozen,
        });
      } catch (e) {
        // 保留已推进的 processedCount / frozenCount，重试从原进度继续
        await this.markNotice(noticeId, { status: 'failed', lastError: (e as Error).message });
        throw e;
      }
    },

    /** 取确实使用了该批次的记录（batchNo 索引精确匹配，天然排除来源不明） */
    async fetchTargets(
      category: MaterialCategory,
      batchNo: string,
    ): Promise<Array<{ recordId: string; guqinNo: string; stageLabel: string }>> {
      if (category === 'wood') {
        const rows: WoodBoard[] = await db.boards.where('batchNo').equals(batchNo).toArray();
        return rows
          .sort((a, b) => a.boardNo.localeCompare(b.boardNo))
          .map((r) => ({ recordId: r.id, guqinNo: r.guqinNo, stageLabel: woodStageLabel(r) }));
      }
      if (category === 'lacquer') {
        const rows: LacquerLayer[] = await db.lacquers.where('batchNo').equals(batchNo).toArray();
        return rows
          .sort((a, b) => a.guqinNo.localeCompare(b.guqinNo) || a.seq - b.seq)
          .map((r) => ({ recordId: r.id, guqinNo: r.guqinNo, stageLabel: lacquerStageLabel(r) }));
      }
      const rows: Stringing[] = await db.stringings.where('batchNo').equals(batchNo).toArray();
      return rows
        .sort((a, b) => b.strungAt.localeCompare(a.strungAt))
        .map((r) => ({ recordId: r.id, guqinNo: r.guqinNo, stageLabel: stringStageLabel(r) }));
    },

    async markNotice(noticeId: string, patch: Partial<QualityNotice>) {
      const current = await db.qualityNotices.get(noticeId);
      if (!current) return;
      const next = { ...current, ...patch };
      await db.qualityNotices.put(toPlain(next));
      this.syncNotice(next);
    },

    /** 不触发整库 hydrate 的单条同步（扫描循环里频繁落游标时用） */
    syncNotice(notice: QualityNotice | undefined) {
      if (!notice) return;
      this.notices = this.notices.some((n) => n.id === notice.id)
        ? this.notices.map((n) => (n.id === notice.id ? notice : n))
        : [...this.notices, notice];
    },

    // ---------------- 复核处理 ----------------

    /**
     * 处理复核单：选定替代批次、留下复核结果与复核人。
     * 只更新复核单，原使用记录不动（原批次、原工序继续可追溯）。
     */
    async resolveReview(reviewId: string, input: ResolveInput): Promise<void> {
      const review = this.reviews.find((r) => r.id === reviewId);
      if (!review) throw new Error('复核单不存在');
      if (review.status === 'resolved') throw new Error('该复核单已处理');

      let replacementBatchNo: string | undefined;
      if (input.result === 'replace') {
        replacementBatchNo = input.replacementBatchNo?.trim();
        if (!replacementBatchNo) throw new Error('选择「更换替代批次」时必须选定替代批次');
        const replacement = await db.materialBatches.get(batchId(review.category, replacementBatchNo));
        if (!replacement) throw new Error(`替代批次 ${replacementBatchNo} 未登记，请先在批次台账登记`);
        if (replacement.status === 'stopped') throw new Error(`替代批次 ${replacementBatchNo} 已停用，不能选用`);
        if (replacementBatchNo === review.batchNo) throw new Error('替代批次不能与停用批次相同');
      }

      const next: MaterialReview = {
        ...review,
        status: 'resolved',
        result: input.result,
        replacementBatchNo,
        reviewer: input.reviewer?.trim() || undefined,
        reviewNote: input.reviewNote?.trim() || undefined,
        resolvedAt: new Date().toISOString(),
      };
      await db.materialReviews.put(toPlain(next));
      this.reviews = this.reviews.map((r) => (r.id === reviewId ? next : r));
    },

    // ---------------- 成琴归档 ----------------

    async archiveGuqin(guqinNo: string, operator: string, remark?: string): Promise<void> {
      const archive: GuqinArchive = {
        guqinNo,
        archivedAt: new Date().toISOString(),
        operator: operator.trim() || '档案员',
        remark: remark?.trim() || undefined,
      };
      await db.archives.put(toPlain(archive));
      this.archives = this.archives.some((a) => a.guqinNo === guqinNo)
        ? this.archives.map((a) => (a.guqinNo === guqinNo ? archive : a))
        : [...this.archives, archive];
    },

    async unarchiveGuqin(guqinNo: string): Promise<void> {
      await db.archives.delete(guqinNo);
      this.archives = this.archives.filter((a) => a.guqinNo !== guqinNo);
    },
  },
});
