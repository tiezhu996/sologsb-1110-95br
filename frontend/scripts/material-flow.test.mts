import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { seedIfEmpty } from '../src/utils/seed.ts';
import { db } from '../src/utils/db.ts';
import { useMaterialStore } from '../src/stores/materialStore.ts';
import { useLacquerStore } from '../src/stores/lacquerStore.ts';
import { useBoardStore } from '../src/stores/boardStore.ts';
import { useStringingStore } from '../src/stores/stringingStore.ts';
import { createPinia, setActivePinia } from 'pinia';

const log = (...a: unknown[]) => console.log('  ›', ...a);

async function freshContext() {
  setActivePinia(createPinia());
  // 清空全部表，保证各场景互不影响（同库名单例 Dexie）
  await Promise.all([
    db.boards.clear(),
    db.chambers.clear(),
    db.lacquers.clear(),
    db.stringings.clear(),
    db.materialBatches.clear(),
    db.qualityNotices.clear(),
    db.materialReviews.clear(),
    db.archives.clear(),
    db.meta.clear(),
  ]);
  await seedIfEmpty();
  const material = useMaterialStore();
  const lacquer = useLacquerStore();
  const board = useBoardStore();
  const stringing = useStringingStore();
  await Promise.all([material.hydrate(), lacquer.hydrate(), board.hydrate(), stringing.hydrate()]);
  return { material, lacquer, board, stringing };
}

// ---------- 场景 1：通知命中 → 精确冻结、来源不明不受牵连 ----------
{
  const { material, lacquer } = await freshContext();
  const notice = JSON.stringify({
    noticeNo: 'QC-1',
    category: '生漆',
    batchNo: 'LQ-2510',
    notifiedAt: '2026-10-01',
    reason: '含水率超标',
  });

  const before = lacquer.layers.length;
  const r = await material.importNoticeText(notice);
  log('场景1 导入结果', r);
  assert.equal(r.created, 1, '新建 1 张通知');

  const pending = await db.materialReviews.where('status').equals('pending').toArray();
  log('冻结记录数', pending.length, '琴号', [...new Set(pending.map((p) => p.guqinNo))].sort());
  // LQ-2510 用在 Q-2501 第3遍、Q-2502 第2/3遍、Q-2503 第2遍、Q-2504 第2遍 = 5 条
  assert.equal(pending.length, 5, '只冻结实际用过 LQ-2510 的 5 条遍次');
  const frozenGuqins = [...new Set(pending.map((p) => p.guqinNo))].sort();
  assert.deepEqual(frozenGuqins, ['Q-2501', 'Q-2502', 'Q-2503', 'Q-2504'], '四张琴各有遍次命中');

  // 来源不明（layer-012，Q-2502 纯生漆）与其它批次遍次未冻结
  const unhit = lacquer.layers.find((l) => l.id === 'layer-012');
  assert.equal(unhit?.batchNo, undefined, 'layer-012 是来源不明旧记录');
  assert.ok(!pending.some((p) => p.recordId === 'layer-012'), '来源不明遍次不冻结');
  assert.equal(lacquer.layers.length, before, '原使用记录未被删除/改写');

  const batchRow = await db.materialBatches.get('lacquer:LQ-2510');
  assert.equal(batchRow?.status, 'stopped', '判废批次自动停用');

  const n = await db.qualityNotices.where('noticeNo').equals('QC-1').first();
  assert.equal(n?.status, 'done');
  assert.equal(n?.frozenCount, 5);

  // 原批次字段仍保留可追溯
  const frozenLayer3 = lacquer.layers.find((l) => l.id === pending[0].recordId || l.seq === 3);
  assert.ok(frozenLayer3, '冻结后原遍次仍可查到');
  log('场景1 通过');
}

// ---------- 场景 2：重复导入不重复冻结 ----------
{
  const { material } = await freshContext();
  const text = 'QC-2,生漆,LQ-2508,秦岭漆源,2026-10-02,抽检不合格';
  const r1 = await material.importNoticeText(text);
  const count1 = await db.materialReviews.count();
  const r2 = await material.importNoticeText(text);
  const count2 = await db.materialReviews.count();
  log('场景2', r1, r2, '复核单', count1, count2);
  assert.equal(r2.skipped, 1, '同一通知重复导入被跳过');
  assert.equal(count1, count2, '不重复冻结');
  log('场景2 通过');
}

// ---------- 场景 3：失败后断点续传 ----------
{
  const { material } = await freshContext();
  // LQ-2508 目标按 (琴号,遍次) 排序：layer-001/002(Q-2501)、004(Q-2502)、007(Q-2503)、009(Q-2504)
  // 模拟扫描中断在第 2 条之后：通知游标 processedCount=2，且前 2 条复核单已落库
  const idb = await db.qualityNotices.add({
    id: 'notice-stuck',
    noticeNo: 'QC-3',
    category: 'lacquer',
    batchNo: 'LQ-2508',
    notifiedAt: new Date().toISOString(),
    importedAt: new Date().toISOString(),
    rawText: '',
    status: 'failed',
    processedCount: 2, // 已扫 2 条
    totalCount: 5,
    frozenCount: 2,
    lastError: '模拟中断',
  });
  await db.materialReviews.bulkPut([
    {
      id: 'review-pre-1',
      noticeId: 'notice-stuck',
      noticeNo: 'QC-3',
      category: 'lacquer',
      batchNo: 'LQ-2508',
      recordId: 'layer-001',
      guqinNo: 'Q-2501',
      stageLabel: '第 1 遍髹漆',
      frozenAt: new Date().toISOString(),
      status: 'pending',
    },
    {
      id: 'review-pre-2',
      noticeId: 'notice-stuck',
      noticeNo: 'QC-3',
      category: 'lacquer',
      batchNo: 'LQ-2508',
      recordId: 'layer-002',
      guqinNo: 'Q-2501',
      stageLabel: '第 2 遍髹漆',
      frozenAt: new Date().toISOString(),
      status: 'pending',
    },
  ]);
  const r = await material.importNoticeText('QC-3,lacquer,LQ-2508');
  log('场景3 续传结果', r);
  assert.equal(r.resumed, 1, '识别为断点续传而非新建/跳过');
  const notice = await db.qualityNotices.get(idb);
  assert.equal(notice.status, 'done');
  assert.equal(notice.processedCount, notice.totalCount);
  const reviews = await db.materialReviews.where('noticeId').equals('notice-stuck').toArray();
  // 续传只补扫第 3~5 条；中断前已冻结的 2 条因幂等去重不重复
  log('场景3 复核单总数', reviews.length, 'totalCount', notice.totalCount);
  assert.deepEqual(
    reviews.map((x) => x.recordId).sort(),
    ['layer-001', 'layer-002', 'layer-004', 'layer-007', 'layer-009'],
    '续传后全部命中记录各一条，无重复',
  );
  assert.equal(notice.frozenCount, 5);
  log('场景3 通过');
}

// ---------- 场景 4：复核处理 + 替代批次校验 + 暂缓/解除归档 ----------
{
  const { material } = await freshContext();
  await material.importNoticeText(
    JSON.stringify({ noticeNo: 'QC-4', category: '琴弦', batchNo: 'STR-S01', notifiedAt: '2026-10-03' }),
  );
  const review = material.reviews.find((r) => r.guqinNo === 'Q-2501' && r.status === 'pending');
  assert.ok(review, 'Q-2501 丝弦上弦记录被冻结');

  // replace 但未给替代批次 → 拒绝
  await assert.rejects(() => material.resolveReview(review.id, { result: 'replace' }), /替代批次/);
  // 停用批次不能当替代
  await material.setBatchStatus('string:STR-G01', 'stopped');
  await assert.rejects(
    () => material.resolveReview(review.id, { result: 'replace', replacementBatchNo: 'STR-G01' }),
    /已停用/,
  );
  // 同批次不能替代自身
  await material.setBatchStatus('string:STR-G01', 'active');
  await material.setBatchStatus('string:STR-S01', 'active'); // 临时恢复以测同批校验
  await assert.rejects(
    () => material.resolveReview(review.id, { result: 'replace', replacementBatchNo: 'STR-S01' }),
    /不能与停用批次相同/,
  );
  // 正常用替代批次复核
  await material.resolveReview(review.id, {
    result: 'replace',
    replacementBatchNo: 'STR-G01',
    reviewer: '周砚秋',
    reviewNote: '换装钢弦复测',
  });
  const resolved = await db.materialReviews.get(review.id);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.replacementBatchNo, 'STR-G01');
  log('场景4 复核通过，原批次仍为', review.batchNo);

  // Q-2503 的 STR-S01 仍 pending → Q-2503 暂缓；Q-2501 已解除
  assert.equal(material.pendingReviewsOfGuqin('Q-2501').length, 0);
  assert.ok(material.pendingReviewsOfGuqin('Q-2503').length >= 1);
  log('场景4 通过');
}

// ---------- 场景 5：木料冻结只挂具体板材，弦通知不牵连髹漆 ----------
{
  const { material } = await freshContext();
  await material.importNoticeText(
    JSON.stringify({ noticeNo: 'QC-5', category: '木料', batchNo: 'WD-2501', notifiedAt: '2026-10-04' }),
  );
  const woodReviews = material.reviews.filter((r) => r.category === 'wood');
  log('场景5 木料冻结', woodReviews.map((r) => r.recordId).sort());
  // WD-2501 → board-003..006（Q-2502、Q-2503），WD-2408 的 Q-2501/Q-2504 与来源不明 Q-2505 不冻结
  assert.deepEqual(
    woodReviews.map((r) => r.recordId).sort(),
    ['board-003', 'board-004', 'board-005', 'board-006'],
  );
  assert.ok(!woodReviews.some((r) => r.recordId === 'board-009'), '来源不明板材不当污染');
  log('场景5 通过');
}

// ---------- 场景 6：非法通知整体失败，不写半成品 ----------
{
  const { material } = await freshContext();
  await assert.rejects(
    () => material.importNoticeText(JSON.stringify({ noticeNo: 'QC-6', category: '生漆' })),
    /缺少批次号/,
  );
  assert.equal(await db.qualityNotices.count(), 0, '解析/校验失败不产生通知');
  assert.equal(await db.materialReviews.count(), 0, '也不产生复核单');
  log('场景6 通过');
}

console.log('\n全部对账场景断言通过 ✅');
db.close();
process.exit(0);
