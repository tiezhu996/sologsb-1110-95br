/**
 * 材料去向对账集成测试（node 直跑，fake-indexeddb 模拟浏览器库）。
 * 覆盖：双向追溯、精确冻结、来源不明不冻结、重复导入幂等、断点续导、
 * 复核换料可追溯、成琴归档闸门。
 */
import 'fake-indexeddb/auto';
import { setActivePinia, createPinia } from 'pinia';
import assert from 'node:assert/strict';
import { db } from '../src/utils/db';
import { useBoardStore } from '../src/stores/boardStore';
import { useLacquerStore } from '../src/stores/lacquerStore';
import { useStringingStore } from '../src/stores/stringingStore';
import { useMaterialStore } from '../src/stores/materialStore';
import type { NoticeInput } from '../src/stores/materialStore';

const FAIL_AT = Number(process.env.FAIL_AT ?? '-1'); // 1-based，在第 N 个批次线抛错
let failArmed = FAIL_AT > 0;

async function seed() {
  setActivePinia(createPinia());
  const boardStore = useBoardStore();
  const lacquerStore = useLacquerStore();
  const stringingStore = useStringingStore();
  const materialStore = useMaterialStore();

  await Promise.all([
    materialStore.addBatch({ batchNo: 'WD-A', materialType: '木料', supplier: '甲林场', receivedAt: '2026-01-01T09:00:00Z' }),
    materialStore.addBatch({ batchNo: 'LQ-A', materialType: '生漆', supplier: '乙漆庄', receivedAt: '2026-01-01T09:00:00Z' }),
    materialStore.addBatch({ batchNo: 'LQ-B', materialType: '生漆', supplier: '乙漆庄', receivedAt: '2026-02-01T09:00:00Z' }),
    materialStore.addBatch({ batchNo: 'LQ-C', materialType: '生漆', supplier: '丙漆行', receivedAt: '2026-03-01T09:00:00Z' }),
    materialStore.addBatch({ batchNo: 'SX-A', materialType: '琴弦', supplier: '丁弦坊', receivedAt: '2026-01-01T09:00:00Z' }),
  ]);

  // 两张琴：Q-1 用 LQ-A 第1遍 + LQ-B 第2遍；Q-2 用 LQ-A 第1遍，第2遍无批次（来源不明）
  await boardStore.addBoard({ boardNo: 'B1', guqinNo: 'Q-1', part: '面板', species: '桐木', dryYears: 5, thicknessMm: 30, grain: '直纹', defect: '无', batchNo: 'WD-A' });
  await lacquerStore.appendLayer({ guqinNo: 'Q-1', mixRatio: '1:1', curingTemp: 25, curingHumidity: 78, polishGrit: 320, layerThickness: 0.1, operator: '林', batchNo: 'LQ-A', appliedAt: '2026-04-01T09:00:00Z' });
  await lacquerStore.appendLayer({ guqinNo: 'Q-1', mixRatio: '1:1', curingTemp: 25, curingHumidity: 78, polishGrit: 400, layerThickness: 0.1, operator: '林', batchNo: 'LQ-B', appliedAt: '2026-04-05T09:00:00Z' });
  await lacquerStore.appendLayer({ guqinNo: 'Q-2', mixRatio: '1:1', curingTemp: 25, curingHumidity: 78, polishGrit: 320, layerThickness: 0.1, operator: '周', batchNo: 'LQ-A', appliedAt: '2026-04-02T09:00:00Z' });
  await lacquerStore.appendLayer({ guqinNo: 'Q-2', mixRatio: '1:1', curingTemp: 25, curingHumidity: 78, polishGrit: 400, layerThickness: 0.1, operator: '周', appliedAt: '2026-04-06T09:00:00Z' }); // 无批次
  await stringingStore.addStringing({ guqinNo: 'Q-1', stringType: '丝弦', nut: '雁足', stringGap: 17, sanNote: '', anNote: '', fanNote: '', nineVirtues: '', defects: ['无'], operator: '周', batchNo: 'SX-A', strungAt: '2026-05-01T09:00:00Z' });

  await Promise.all([boardStore.hydrate(), lacquerStore.hydrate(), stringingStore.hydrate(), materialStore.hydrate()]);
  return { boardStore, lacquerStore, stringingStore, materialStore };
}

/** 包装 freezeBatchLine：在指定批次线（按批次号序号）注入一次失败 */
async function importWithFail(materialStore: ReturnType<typeof useMaterialStore>, input: NoticeInput) {
  const targetLine = input.batches[FAIL_AT - 1];
  if (failArmed && targetLine) {
    const original = materialStore.freezeBatchLine;
    materialStore.freezeBatchLine = async function patched(notice, line) {
      if (line.batchNo === targetLine.batchNo && failArmed) {
        failArmed = false;
        throw new Error('注入故障：模拟写入中断');
      }
      return original.call(materialStore, notice, line);
    };
  }
  return materialStore.importNotice(input);
}

const noticeBase = (): NoticeInput => ({
  noticeNo: 'QC-T-001',
  title: '生漆 LQ-A 停用',
  supplier: '乙漆庄',
  receivedAt: '2026-06-01T09:00:00Z',
  content: '含水率超标',
  batches: [{ batchNo: 'LQ-A' }, { batchNo: 'LQ-B' }, { batchNo: 'LQ-X' }],
});

async function run() {
  const { materialStore, lacquerStore } = await seed();

  // 1. 双向追溯：批次 → 琴与遍次
  const refsA = materialStore.refsOfBatch('LQ-A');
  assert.equal(refsA.length, 2, 'LQ-A 应有 2 条使用记录（Q-1 第1遍、Q-2 第1遍）');
  assert.deepEqual(refsA.map((r) => r.guqinNo).sort(), ['Q-1', 'Q-2']);
  const backRefs = materialStore.refsOfGuqin('Q-1');
  assert.ok(backRefs.some((r) => r.batchNo === 'LQ-A' && r.label.includes('第 1 遍')));
  assert.ok(backRefs.some((r) => r.batchNo === 'LQ-B' && r.label.includes('第 2 遍')));
  assert.ok(backRefs.some((r) => r.table === 'stringings' && r.batchNo === 'SX-A'));

  // 2. 来源不明旧数据标记，不计污染
  assert.equal(materialStore.unknownBatchCount, 1, 'Q-2 第2遍髹漆无批次 = 来源不明');
  assert.ok(materialStore.refsOfGuqin('Q-2').some((r) => r.batchNo === '' && r.label.includes('第 2 遍')));

  // 3. 导入通知（含故障注入时先断后续导）
  let notice;
  if (FAIL_AT > 0) {
    let rejected: unknown;
    try {
      await importWithFail(materialStore, noticeBase());
    } catch (error) {
      rejected = error;
    }
    assert.ok(rejected instanceof Error, '首次导入应抛出中断错误');
    assert.match((rejected as Error).message, /注入故障/);
    const partial = materialStore.notices.find((n) => n.noticeNo === 'QC-T-001')!;
    assert.equal(partial.status, 'failed');
    assert.equal(partial.cursor, FAIL_AT - 1, '游标停在故障批次前');
    // 重试：从原进度继续
    const resumed = await materialStore.importNotice(noticeBase());
    assert.equal(resumed.resumed, true);
    notice = resumed.notice;
    assert.equal(notice.status, 'processed');
    assert.equal(notice.cursor, 3);
  } else {
    const result = await importWithFail(materialStore, noticeBase());
    notice = result.notice;
    assert.equal(result.duplicated, false);
  }

  // 4. 精确冻结：LQ-A 命中 2 遍，LQ-B 命中 1 遍（Q-1 第2遍），LQ-X 无使用不冻结
  assert.equal(notice.frozenCount, 3, '只冻结确实使用过停用批次的 3 条记录');
  const tasks = materialStore.tasksOfNotice(notice.id);
  assert.deepEqual(tasks.map((t) => t.batchNo).sort(), ['LQ-A', 'LQ-A', 'LQ-B']);
  // 来源不明遍次与 Q-2 第2遍不受牵连
  assert.ok(!tasks.some((t) => t.guqinNo === 'Q-2' && t.snapshot.label.includes('第 2 遍')), '来源不明遍次不冻结');
  // 没碰过停用批次的琴弦记录不受牵连
  assert.ok(!tasks.some((t) => t.table === 'stringings'));
  // 快照保留原使用记录
  const lqATask = tasks.find((t) => t.guqinNo === 'Q-1' && t.batchNo === 'LQ-A')!;
  assert.ok(lqATask.snapshot.detail.includes('累计'));

  // 5. 重复导入不重复冻结
  const dup = await materialStore.importNotice(noticeBase());
  assert.equal(dup.duplicated, true);
  assert.equal(dup.frozen, 0);
  assert.equal((await useMaterialStore().tasksOfNotice(notice.id)).length, 3, '重复导入后待复核仍为 3 条');

  // 6. 成琴归档闸门
  assert.equal(materialStore.pendingCountOf('Q-1'), 2, 'Q-1 有 2 条待复核');
  assert.equal(materialStore.canArchive('Q-1'), false);
  await assert.rejects(() => materialStore.archiveGuqin('Q-1'), /暂缓成琴归档/);
  assert.equal(materialStore.canArchive('Q-2'), false, 'Q-2 也有 1 条 LQ-A 待复核');

  // 7. 复核：Q-1 的 LQ-A 换用 LQ-C
  await materialStore.resolveReview(lqATask.id, { verdict: 'replace', replacementBatchNo: 'LQ-C', resultNote: '复检换批', reviewer: '林师傅' });
  await lacquerStore.hydrate();
  const q1Layers = lacquerStore.layersOf('Q-1');
  assert.equal(q1Layers.find((l) => l.seq === 1)!.batchNo, 'LQ-C', '原记录改挂替代批次');
  const keptTask = useMaterialStore().reviews.find((t) => t.id === lqATask.id)!;
  assert.equal(keptTask.status, 'reviewed');
  assert.equal(keptTask.batchNo, 'LQ-A', '复核记录保留原停用批次可追溯');
  assert.equal(keptTask.replacementBatchNo, 'LQ-C');

  // 8. 替代批次类型不符拒绝
  const q2Task = useMaterialStore().reviews.find((t) => t.guqinNo === 'Q-2')!;
  await assert.rejects(
    () => materialStore.resolveReview(q2Task.id, { verdict: 'replace', replacementBatchNo: 'SX-A', resultNote: 'x', reviewer: 'y' }),
    /必须为生漆/,
  );

  // 9. 其余两条维持原批次（复检可用）
  for (const task of useMaterialStore().reviews.filter((t) => t.status === 'pending')) {
    await materialStore.resolveReview(task.id, { verdict: 'keep', resultNote: '复检可用', reviewer: '周师傅' });
  }
  assert.equal(useMaterialStore().pendingReviews.length, 0);
  assert.equal(useMaterialStore().canArchive('Q-1'), true);
  assert.equal(useMaterialStore().canArchive('Q-2'), true);
  await materialStore.archiveGuqin('Q-1');
  assert.ok(useMaterialStore().archivedGuqinNos.has('Q-1'));

  console.log(FAIL_AT > 0 ? '✔ 断点续导场景全部通过' : '✔ 基础对账场景全部通过');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
