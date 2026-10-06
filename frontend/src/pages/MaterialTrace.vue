<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import StatBadge from '../components/common/StatBadge.vue';
import { useMaterialStore } from '../stores/materialStore';
import { useStageProgress } from '../hooks/useStageProgress';
import { batchLabelOf, isUnknownBatch, stageLabelOf } from '../utils/material';
import { formatDate } from '../utils/layer';
import {
  MATERIAL_TYPES,
  type MaterialBatch,
  type MaterialType,
  type NoticeBatchLine,
  type QcNotice,
  type ReviewTask,
  type ReviewVerdict,
} from '../types/material';

const materialStore = useMaterialStore();
const { progressList } = useStageProgress();

const activeTab = ref('batch');

// ============ 批次台账 ============

const batchTypeFilter = ref<MaterialType | ''>('');
const batchKeyword = ref('');
const selectedBatchNo = ref('');
const traceGuqinNo = ref('');

const batchDialogVisible = ref(false);
const editingBatchId = ref('');
const batchFormRef = ref<FormInstance>();
interface BatchForm {
  batchNo: string;
  materialType: MaterialType;
  supplier: string;
  receivedAt: string;
  remark: string;
}
const batchForm = ref<BatchForm>({
  batchNo: '',
  materialType: '木料',
  supplier: '',
  receivedAt: new Date().toISOString().slice(0, 10),
  remark: '',
});
const batchRules: FormRules = {
  batchNo: [{ required: true, message: '请输入批次号', trigger: 'blur' }],
  supplier: [{ required: true, message: '请输入供应商', trigger: 'blur' }],
};

const filteredBatches = computed(() => {
  const kw = batchKeyword.value.trim().toLowerCase();
  return materialStore.batches.filter((batch) => {
    if (batchTypeFilter.value && batch.materialType !== batchTypeFilter.value) return false;
    if (kw && !`${batch.batchNo} ${batch.supplier} ${batch.remark ?? ''}`.toLowerCase().includes(kw)) return false;
    return true;
  });
});

const selectedBatch = computed(() => materialStore.batchByNo(selectedBatchNo.value));
const selectedBatchRefs = computed(() => (selectedBatchNo.value ? materialStore.refsOfBatch(selectedBatchNo.value) : []));
const guqinTraceRefs = computed(() => (traceGuqinNo.value ? materialStore.refsOfGuqin(traceGuqinNo.value) : []));

function openBatchCreate(type?: MaterialType) {
  editingBatchId.value = '';
  batchForm.value = {
    batchNo: '',
    materialType: type ?? '木料',
    supplier: '',
    receivedAt: new Date().toISOString().slice(0, 10),
    remark: '',
  };
  batchDialogVisible.value = true;
}

function openBatchEdit(batch: MaterialBatch) {
  editingBatchId.value = batch.id;
  batchForm.value = {
    batchNo: batch.batchNo,
    materialType: batch.materialType,
    supplier: batch.supplier,
    receivedAt: batch.receivedAt.slice(0, 10),
    remark: batch.remark ?? '',
  };
  batchDialogVisible.value = true;
}

async function submitBatch() {
  const ok = await batchFormRef.value?.validate().catch(() => false);
  if (!ok) return;
  const payload = {
    batchNo: batchForm.value.batchNo,
    materialType: batchForm.value.materialType,
    supplier: batchForm.value.supplier,
    receivedAt: new Date(`${batchForm.value.receivedAt}T09:00:00`).toISOString(),
    remark: batchForm.value.remark,
  };
  try {
    if (editingBatchId.value) {
      await materialStore.updateBatch(editingBatchId.value, payload);
      ElMessage.success(`已更新批次 ${payload.batchNo}`);
    } else {
      await materialStore.addBatch(payload);
      ElMessage.success(`已登记 ${payload.materialType}批次 ${payload.batchNo}`);
    }
    batchDialogVisible.value = false;
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

async function removeBatch(batch: MaterialBatch) {
  const confirmed = await ElMessageBox.confirm(`确认删除批次 ${batch.batchNo}？已有工序记录引用的批次不能删除。`, '删除确认', {
    type: 'warning',
  })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  try {
    await materialStore.removeBatch(batch.id);
    if (selectedBatchNo.value === batch.batchNo) selectedBatchNo.value = '';
    ElMessage.success('已删除批次');
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

function usageTagType(ref: { table: string; refId: string }): 'danger' | 'info' {
  return materialStore.reviews.some((task) => task.table === ref.table && task.refId === ref.refId && task.status === 'pending')
    ? 'danger'
    : 'info';
}
function usageTagText(ref: { table: string; refId: string }): string {
  return materialStore.reviews.some((task) => task.table === ref.table && task.refId === ref.refId && task.status === 'pending')
    ? '待复核'
    : '正常';
}

// ============ 质检通知导入 ============

const noticeDialogVisible = ref(false);
const noticeFormRef = ref<FormInstance>();
interface NoticeForm {
  noticeNo: string;
  title: string;
  supplier: string;
  receivedAt: string;
  content: string;
  lines: NoticeBatchLine[];
}
const noticeForm = ref<NoticeForm>({
  noticeNo: '',
  title: '',
  supplier: '',
  receivedAt: new Date().toISOString().slice(0, 10),
  content: '',
  lines: [{ batchNo: '' }],
});
const noticeRules: FormRules = {
  noticeNo: [{ required: true, message: '请填写通知文号', trigger: 'blur' }],
  title: [{ required: true, message: '请填写通知标题', trigger: 'blur' }],
};

const selectedNoticeId = ref('');
const selectedNotice = computed<QcNotice | undefined>(() => materialStore.notices.find((n) => n.id === selectedNoticeId.value));
const selectedNoticeTasks = computed(() => (selectedNotice.value ? materialStore.tasksOfNotice(selectedNotice.value.id) : []));

function openNoticeCreate() {
  noticeForm.value = {
    noticeNo: '',
    title: '',
    supplier: '',
    receivedAt: new Date().toISOString().slice(0, 10),
    content: '',
    lines: [{ batchNo: '' }],
  };
  noticeDialogVisible.value = true;
}

function addNoticeLine() {
  noticeForm.value.lines.push({ batchNo: '' });
}
function removeNoticeLine(index: number) {
  noticeForm.value.lines.splice(index, 1);
}

async function submitNotice() {
  const ok = await noticeFormRef.value?.validate().catch(() => false);
  if (!ok) return;
  const lines = noticeForm.value.lines
    .map((line) => ({ batchNo: line.batchNo.trim(), materialType: line.materialType }))
    .filter((line) => line.batchNo);
  if (!lines.length) {
    ElMessage.warning('请至少填写一个停用批次号');
    return;
  }
  try {
    const result = await materialStore.importNotice({
      noticeNo: noticeForm.value.noticeNo,
      title: noticeForm.value.title,
      supplier: noticeForm.value.supplier,
      receivedAt: new Date(`${noticeForm.value.receivedAt}T09:00:00`).toISOString(),
      content: noticeForm.value.content,
      batches: lines,
    });
    if (result.duplicated) {
      ElMessage.info(`通知 ${result.notice.noticeNo} 已处理完成，重复导入不重复冻结`);
    } else if (result.resumed) {
      ElMessage.success(`已从原进度续导完成，新增冻结 ${result.frozen} 条记录`);
    } else {
      ElMessage.success(`通知已处理，冻结 ${result.frozen} 条确实使用该批次的记录`);
    }
    result.warnings.forEach((warning) => ElMessage.warning(warning));
    selectedNoticeId.value = result.notice.id;
    noticeDialogVisible.value = false;
    if (result.frozen > 0) activeTab.value = 'review';
  } catch (error) {
    ElMessage.error(`导入中断（已保留进度，可重试续导）：${(error as Error).message}`);
    const latest = materialStore.notices.find((n) => n.noticeNo === noticeForm.value.noticeNo.trim());
    if (latest) selectedNoticeId.value = latest.id;
  }
}

async function retryNotice(notice: QcNotice) {
  const confirmed = await ElMessageBox.confirm(
    `通知 ${notice.noticeNo} 在第 ${notice.cursor + 1}/${notice.batches.length} 个批次处中断，是否从原进度继续？`,
    '断点续导',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  try {
    const result = await materialStore.importNotice({
      noticeNo: notice.noticeNo,
      title: notice.title,
      supplier: notice.supplier,
      receivedAt: notice.receivedAt,
      content: notice.content,
      batches: notice.batches,
    });
    ElMessage.success(`续导完成，新增冻结 ${result.frozen} 条记录`);
    result.warnings.forEach((warning) => ElMessage.warning(warning));
  } catch (error) {
    ElMessage.error(`仍未完成：${(error as Error).message}`);
  }
}

const noticeStatusMeta: Record<string, { label: string; type: 'success' | 'warning' | 'danger' }> = {
  processed: { label: '已处理', type: 'success' },
  processing: { label: '处理中', type: 'warning' },
  failed: { label: '中断待续导', type: 'danger' },
};

// ============ 待复核 ============

const reviewStatusFilter = ref<'' | 'pending' | 'reviewed'>('pending');
const reviewKeyword = ref('');

const filteredReviews = computed(() =>
  materialStore.reviews
    .filter((task) => {
      if (reviewStatusFilter.value && task.status !== reviewStatusFilter.value) return false;
      const kw = reviewKeyword.value.trim().toLowerCase();
      if (kw && !`${task.guqinNo} ${task.batchNo} ${task.noticeNo} ${task.snapshot.label}`.toLowerCase().includes(kw)) return false;
      return true;
    })
    .sort((a, b) => b.frozenAt.localeCompare(a.frozenAt)),
);

const reviewDialogVisible = ref(false);
const reviewTarget = ref<ReviewTask | null>(null);
interface ReviewForm {
  verdict: ReviewVerdict;
  replacementBatchNo: string;
  resultNote: string;
  reviewer: string;
}
const reviewForm = ref<ReviewForm>({ verdict: 'replace', replacementBatchNo: '', resultNote: '', reviewer: '' });

const replacementOptions = computed(() => {
  if (!reviewTarget.value) return [];
  return materialStore.batchesOfType(reviewTarget.value.materialType).filter((b) => b.batchNo !== reviewTarget.value!.batchNo);
});

const verdictMeta: Record<ReviewVerdict, { label: string; hint: string }> = {
  replace: { label: '换用替代批次', hint: '原记录改挂替代批次，停用批次与冻结快照保留可追溯' },
  keep: { label: '复检可用 · 维持原批次', hint: '经复核该道用料不受通知影响，维持现状' },
  scrap: { label: '该道用料作废返工', hint: '记录保留在停用批次上作为追溯依据，安排返工重做' },
};

function openReview(task: ReviewTask) {
  reviewTarget.value = task;
  reviewForm.value = {
    verdict: task.verdict ?? 'replace',
    replacementBatchNo:
      task.replacementBatchNo ??
      materialStore.batchesOfType(task.materialType).find((b) => b.batchNo !== task.batchNo)?.batchNo ??
      '',
    resultNote: task.resultNote ?? '',
    reviewer: task.reviewer ?? '',
  };
  reviewDialogVisible.value = true;
}

async function submitReview() {
  if (!reviewTarget.value) return;
  try {
    await materialStore.resolveReview(reviewTarget.value.id, { ...reviewForm.value });
    ElMessage.success('复核结果已保存');
    reviewDialogVisible.value = false;
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

// 同通知同批次批量复核
const batchReviewDialogVisible = ref(false);
const batchReviewTarget = ref<{ noticeId: string; batchNo: string; type: MaterialType } | null>(null);
const batchReviewForm = ref<ReviewForm>({ verdict: 'replace', replacementBatchNo: '', resultNote: '', reviewer: '' });
const batchReplacementOptions = computed(() =>
  batchReviewTarget.value
    ? materialStore.batchesOfType(batchReviewTarget.value.type).filter((b) => b.batchNo !== batchReviewTarget.value!.batchNo)
    : [],
);

function openBatchReview(notice: QcNotice, batchNo: string) {
  // 材料类型直接取自该批待复核任务；台账缺失时也不会误选
  const type =
    materialStore.tasksOfNotice(notice.id).find((task) => task.batchNo === batchNo && task.status === 'pending')?.materialType ??
    materialStore.batchByNo(batchNo)?.materialType ??
    '木料';
  batchReviewTarget.value = { noticeId: notice.id, batchNo, type };
  batchReviewForm.value = {
    verdict: 'replace',
    replacementBatchNo: materialStore.batchesOfType(type).find((b) => b.batchNo !== batchNo)?.batchNo ?? '',
    resultNote: '',
    reviewer: '',
  };
  batchReviewDialogVisible.value = true;
}

async function submitBatchReview() {
  if (!batchReviewTarget.value) return;
  try {
    const { done, errors } = await materialStore.resolveBatch(
      batchReviewTarget.value.noticeId,
      batchReviewTarget.value.batchNo,
      { ...batchReviewForm.value },
    );
    if (done > 0) ElMessage.success(`已批量复核 ${done} 条待复核记录`);
    errors.forEach((message) => ElMessage.warning(message));
    if (done > 0 || errors.length === 0) batchReviewDialogVisible.value = false;
  } catch (error) {
    ElMessage.error((error as Error).message);
  }
}

function pendingOfBatchInNotice(notice: QcNotice, batchNo: string): number {
  return materialStore.tasksOfNotice(notice.id).filter((task) => task.batchNo === batchNo && task.status === 'pending').length;
}

// ============ 成琴归档 ============

async function archive(guqinNo: string) {
  try {
    await materialStore.archiveGuqin(guqinNo);
    ElMessage.success(`${guqinNo} 已成琴归档`);
  } catch (error) {
    ElMessage.warning((error as Error).message);
  }
}

async function unarchive(guqinNo: string) {
  const confirmed = await ElMessageBox.confirm(`确认撤销 ${guqinNo} 的成琴归档？`, '撤销归档', { type: 'warning' })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await materialStore.unarchiveGuqin(guqinNo);
  ElMessage.success('已撤销归档');
}

function archiveOf(guqinNo: string) {
  return materialStore.archives.find((a) => a.guqinNo === guqinNo);
}

const pendingTotal = computed(() => materialStore.pendingReviews.length);
const blockedGuqinCount = computed(() => materialStore.blockedGuqinNos.size);
const tracedBatchCount = computed(() => materialStore.batches.length);
</script>

<template>
  <div>
    <h2 class="page-title">材料去向对账</h2>
    <p class="page-desc">
      板材、髹漆遍次与上弦记录全部挂材料批次：从批次查到琴与各工序，也可从琴回看材料来源。供应商质检通知到达后，只把确实用过停用批次的记录转待复核并暂缓成琴归档；旧数据无批次号标为「来源不明」，不直接当作污染。
    </p>

    <el-row :gutter="12" class="stat-row">
      <el-col :xs="12" :md="6">
        <StatBadge label="材料批次台账" :value="tracedBatchCount" unit="批" />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge label="待复核记录" :value="pendingTotal" unit="条" :status="pendingTotal ? 'danger' : 'success'" />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge label="暂缓归档琴坯" :value="blockedGuqinCount" unit="张" :status="blockedGuqinCount ? 'warning' : 'success'" />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge label="来源不明旧记录" :value="materialStore.unknownBatchCount" unit="条" status="default" />
      </el-col>
    </el-row>

    <el-tabs v-model="activeTab" type="border-card">
      <!-- ============ 批次去向 ============ -->
      <el-tab-pane label="批次台账与去向" name="batch">
        <div class="toolbar">
          <el-button type="primary" @click="openBatchCreate()">登记材料批次</el-button>
          <el-select v-model="batchTypeFilter" placeholder="材料类型" clearable style="width: 140px">
            <el-option v-for="type in MATERIAL_TYPES" :key="type" :label="type" :value="type" />
          </el-select>
          <el-input v-model="batchKeyword" placeholder="批次号 / 供应商 / 备注" clearable style="width: 240px" />
        </div>

        <el-alert
          v-if="materialStore.danglingBatchNos.length"
          class="alert"
          type="warning"
          :closable="false"
          show-icon
          title="以下批次号出现在工序记录中，但批次台账尚未登记，请补录后再处理通知："
          :description="materialStore.danglingBatchNos.join('、')"
        />

        <el-table :data="filteredBatches" size="small" border class="block" @row-click="(row: MaterialBatch) => (selectedBatchNo = row.batchNo)">
          <el-table-column prop="batchNo" label="批次号" width="130" />
          <el-table-column prop="materialType" label="材料" width="80" />
          <el-table-column prop="supplier" label="供应商" min-width="150" />
          <el-table-column label="入库" width="110">
            <template #default="scope">{{ formatDate(scope.row.receivedAt) }}</template>
          </el-table-column>
          <el-table-column label="去向" width="130">
            <template #default="scope">
              <el-tag size="small" effect="plain">{{ materialStore.refsOfBatch(scope.row.batchNo).length }} 条记录</el-tag>
              <el-tag size="small" type="info" effect="plain" class="guqin-count">{{ materialStore.guqinsOfBatch(scope.row.batchNo).length }} 张琴</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="remark" label="备注" min-width="120" show-overflow-tooltip />
          <el-table-column label="操作" width="170" fixed="right">
            <template #default="scope">
              <el-button link type="primary" @click.stop="selectedBatchNo = scope.row.batchNo">查去向</el-button>
              <el-button link type="primary" @click.stop="openBatchEdit(scope.row)">编辑</el-button>
              <el-button link type="danger" @click.stop="removeBatch(scope.row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-card v-if="selectedBatch" shadow="never" class="block">
          <template #header>
            <div class="card-head">
              <span>批次 {{ selectedBatch.batchNo }} 的去向（{{ selectedBatch.materialType }} · {{ selectedBatch.supplier }}）</span>
              <el-tag size="small" type="info" effect="plain">
                涉及 {{ materialStore.guqinsOfBatch(selectedBatch.batchNo).join('、') || '暂无使用记录' }}
              </el-tag>
            </div>
          </template>
          <el-table :data="selectedBatchRefs" size="small" border>
            <el-table-column prop="guqinNo" label="琴号" width="100" />
            <el-table-column label="工序" width="160">
              <template #default="scope">{{ stageLabelOf(scope.row.table) }}</template>
            </el-table-column>
            <el-table-column label="使用记录" min-width="220">
              <template #default="scope">
                <div class="ref-label">{{ scope.row.label }}</div>
                <div class="ref-detail">{{ scope.row.detail }}</div>
              </template>
            </el-table-column>
            <el-table-column label="用料日期" width="100">
              <template #default="scope">{{ formatDate(scope.row.usedAt) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="scope">
                <el-tag size="small" :type="usageTagType(scope.row)">{{ usageTagText(scope.row) }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
        </el-card>

        <el-card shadow="never" class="block">
          <template #header>
            <div class="card-head">
              <span>从琴回看材料来源</span>
              <el-select v-model="traceGuqinNo" placeholder="选择琴号" clearable filterable style="width: 200px">
                <el-option v-for="item in progressList" :key="item.guqinNo" :label="item.guqinNo" :value="item.guqinNo" />
              </el-select>
            </div>
          </template>
          <el-empty v-if="!traceGuqinNo" :image-size="60" description="选择琴号，查看其板材、各遍髹漆与生漆、上弦与琴弦的全部批次来源" />
          <el-table v-else :data="guqinTraceRefs" size="small" border>
            <el-table-column label="工序" width="170">
              <template #default="scope">{{ stageLabelOf(scope.row.table) }}</template>
            </el-table-column>
            <el-table-column label="使用记录" min-width="200">
              <template #default="scope">
                <div class="ref-label">{{ scope.row.label }}</div>
                <div class="ref-detail">{{ scope.row.detail }}</div>
              </template>
            </el-table-column>
            <el-table-column label="材料批次" min-width="160">
              <template #default="scope">
                <el-tag v-if="isUnknownBatch(scope.row.batchNo)" size="small" type="info">来源不明（旧数据）</el-tag>
                <el-tag v-else size="small" type="warning" effect="plain">{{ batchLabelOf(scope.row.batchNo) }}</el-tag>
                <span v-if="!isUnknownBatch(scope.row.batchNo)" class="supplier-name">
                  {{ materialStore.batchByNo(scope.row.batchNo)?.supplier ?? '（台账未登记）' }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="用料日期" width="100">
              <template #default="scope">{{ formatDate(scope.row.usedAt) }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ============ 质检通知 ============ -->
      <el-tab-pane label="供应商质检通知" name="notice">
        <div class="toolbar">
          <el-button type="primary" @click="openNoticeCreate">导入质检通知</el-button>
          <span class="card-note">同一文号重复导入不重复冻结；中断后重试从原批次游标继续</span>
        </div>

        <el-table :data="materialStore.notices" size="small" border class="block">
          <el-table-column prop="noticeNo" label="文号" width="140" />
          <el-table-column prop="title" label="标题" min-width="160" show-overflow-tooltip />
          <el-table-column prop="supplier" label="供应商" width="130" />
          <el-table-column label="到达" width="100">
            <template #default="scope">{{ formatDate(scope.row.receivedAt) }}</template>
          </el-table-column>
          <el-table-column label="停用批次" width="90">
            <template #default="scope">{{ scope.row.batches.length }}</template>
          </el-table-column>
          <el-table-column label="已冻结记录" width="100">
            <template #default="scope">
              {{ scope.row.frozenCount }} 条
              <span class="cursor">（{{ scope.row.cursor }}/{{ scope.row.batches.length }} 批）</span>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="scope">
              <el-tag size="small" :type="noticeStatusMeta[scope.row.status].type">{{ noticeStatusMeta[scope.row.status].label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="scope">
              <el-button link type="primary" @click="selectedNoticeId = scope.row.id">查看</el-button>
              <el-button v-if="scope.row.status !== 'processed'" link type="warning" @click="retryNotice(scope.row)">重试续导</el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-card v-if="selectedNotice" shadow="never" class="block">
          <template #header>
            <div class="card-head">
              <span>通知 {{ selectedNotice.noticeNo }} · {{ selectedNotice.title }}</span>
              <el-button size="small" type="primary" @click="activeTab = 'review'">去处理待复核</el-button>
            </div>
          </template>

          <el-descriptions :column="2" border size="small" class="block">
            <el-descriptions-item label="供应商">{{ selectedNotice.supplier || '—' }}</el-descriptions-item>
            <el-descriptions-item label="到达日期">{{ formatDate(selectedNotice.receivedAt) }}</el-descriptions-item>
            <el-descriptions-item label="通知摘要" :span="2">{{ selectedNotice.content || '—' }}</el-descriptions-item>
            <el-descriptions-item v-if="selectedNotice.lastError" label="中断原因" :span="2">
              <span class="error-text">{{ selectedNotice.lastError }}</span>
            </el-descriptions-item>
          </el-descriptions>

          <el-table :data="selectedNotice.batches" size="small" border>
            <el-table-column prop="batchNo" label="停用批次号" width="160" />
            <el-table-column label="材料类型（通知填写）" width="180">
              <template #default="scope">{{ scope.row.materialType ?? '未填写（按台账核对）' }}</template>
            </el-table-column>
            <el-table-column label="台账核对" min-width="160">
              <template #default="scope">
                <el-tag v-if="materialStore.batchByNo(scope.row.batchNo)" size="small" type="success">
                  {{ materialStore.batchByNo(scope.row.batchNo)?.materialType }} · {{ materialStore.batchByNo(scope.row.batchNo)?.supplier }}
                </el-tag>
                <el-tag v-else size="small" type="warning">台账未登记</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="待复核" width="90">
              <template #default="scope">
                <el-tag size="small" :type="pendingOfBatchInNotice(selectedNotice, scope.row.batchNo) ? 'danger' : 'info'">
                  {{ pendingOfBatchInNotice(selectedNotice, scope.row.batchNo) }} 条
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120">
              <template #default="scope">
                <el-button
                  v-if="pendingOfBatchInNotice(selectedNotice, scope.row.batchNo)"
                  link
                  type="primary"
                  @click="openBatchReview(selectedNotice, scope.row.batchNo)"
                >
                  同批复核
                </el-button>
                <span v-else class="card-note">无待处理</span>
              </template>
            </el-table-column>
          </el-table>

          <el-table :data="selectedNoticeTasks" size="small" border class="block">
            <template #empty>该通知没有命中任何使用记录（没碰过这些批次的琴不受牵连）</template>
            <el-table-column prop="guqinNo" label="琴号" width="100" />
            <el-table-column label="工序" width="150">
              <template #default="scope">{{ stageLabelOf(scope.row.table) }}</template>
            </el-table-column>
            <el-table-column label="冻结时使用记录（原记录快照，持续可追溯）" min-width="240">
              <template #default="scope">
                <div class="ref-label">{{ scope.row.snapshot.label }}</div>
                <div class="ref-detail">{{ scope.row.snapshot.detail }}</div>
              </template>
            </el-table-column>
            <el-table-column prop="batchNo" label="停用批次" width="120" />
            <el-table-column label="状态/结果" width="200">
              <template #default="scope">
                <el-tag v-if="scope.row.status === 'pending'" size="small" type="danger">待复核</el-tag>
                <div v-else>
                  <el-tag size="small" type="success">{{ verdictMeta[scope.row.verdict as ReviewVerdict].label }}</el-tag>
                  <div v-if="scope.row.replacementBatchNo" class="ref-detail">替代：{{ scope.row.replacementBatchNo }}</div>
                  <div class="ref-detail">{{ scope.row.reviewer }} · {{ formatDate(scope.row.reviewedAt ?? '') }}</div>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="90" fixed="right">
              <template #default="scope">
                <el-button link :type="scope.row.status === 'pending' ? 'primary' : 'info'" @click="openReview(scope.row)">
                  {{ scope.row.status === 'pending' ? '复核' : '查看' }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ============ 待复核 ============ -->
      <el-tab-pane :label="pendingTotal ? `待复核（${pendingTotal}）` : '待复核'" name="review">
        <div class="toolbar">
          <el-radio-group v-model="reviewStatusFilter">
            <el-radio-button label="pending">待复核</el-radio-button>
            <el-radio-button label="reviewed">已复核</el-radio-button>
            <el-radio-button label="">全部</el-radio-button>
          </el-radio-group>
          <el-input v-model="reviewKeyword" placeholder="琴号 / 批次 / 通知文号" clearable style="width: 240px" />
        </div>

        <el-table :data="filteredReviews" size="small" border>
          <el-table-column prop="guqinNo" label="琴号" width="100" />
          <el-table-column label="工序" width="140">
            <template #default="scope">{{ stageLabelOf(scope.row.table) }}</template>
          </el-table-column>
          <el-table-column label="使用记录" min-width="200">
            <template #default="scope">
              <div class="ref-label">{{ scope.row.snapshot.label }}</div>
              <div class="ref-detail">{{ scope.row.snapshot.detail }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="batchNo" label="停用批次" width="110" />
          <el-table-column prop="noticeNo" label="通知文号" width="130" />
          <el-table-column label="冻结" width="100">
            <template #default="scope">{{ formatDate(scope.row.frozenAt) }}</template>
          </el-table-column>
          <el-table-column label="复核状态" min-width="210">
            <template #default="scope">
              <el-tag v-if="scope.row.status === 'pending'" size="small" type="danger">待复核 · 暂缓归档</el-tag>
              <div v-else>
                <el-tag size="small" type="success">{{ verdictMeta[scope.row.verdict as ReviewVerdict].label }}</el-tag>
                <div v-if="scope.row.replacementBatchNo" class="ref-detail">替代批次：{{ scope.row.replacementBatchNo }}</div>
                <div class="ref-detail" show-overflow-tooltip>{{ scope.row.resultNote }}</div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="90" fixed="right">
            <template #default="scope">
              <el-button link :type="scope.row.status === 'pending' ? 'primary' : 'info'" @click="openReview(scope.row)">
                {{ scope.row.status === 'pending' ? '复核' : '查看' }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ============ 成琴归档 ============ -->
      <el-tab-pane label="成琴归档" name="archive">
        <el-alert
          class="alert"
          type="info"
          :closable="false"
          show-icon
          title="存在待复核记录的琴暂缓成琴归档；待复核全部处理完才能归档。没碰过停用批次的琴不受影响。"
        />
        <el-table :data="progressList" size="small" border>
          <el-table-column prop="guqinNo" label="琴号" width="110" />
          <el-table-column label="推进比" width="170">
            <template #default="scope">
              <el-progress :percentage="scope.row.ratio" :status="scope.row.ratio === 100 ? 'success' : undefined" />
            </template>
          </el-table-column>
          <el-table-column label="待复核" width="120">
            <template #default="scope">
              <el-tag v-if="materialStore.pendingCountOf(scope.row.guqinNo)" size="small" type="danger">
                {{ materialStore.pendingCountOf(scope.row.guqinNo) }} 条 · 暂缓
              </el-tag>
              <el-tag v-else size="small" type="success">可归档</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="归档状态" min-width="180">
            <template #default="scope">
              <template v-if="archiveOf(scope.row.guqinNo)">
                <el-tag size="small" type="success">已归档 · {{ formatDate(archiveOf(scope.row.guqinNo)?.archivedAt ?? '') }}</el-tag>
                <span v-if="archiveOf(scope.row.guqinNo)?.remark" class="ref-detail">{{ archiveOf(scope.row.guqinNo)?.remark }}</span>
              </template>
              <span v-else class="card-note">未归档</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="150" fixed="right">
            <template #default="scope">
              <el-button
                v-if="!archiveOf(scope.row.guqinNo)"
                link
                :type="materialStore.canArchive(scope.row.guqinNo) ? 'primary' : 'info'"
                :disabled="!materialStore.canArchive(scope.row.guqinNo)"
                @click="archive(scope.row.guqinNo)"
              >
                成琴归档
              </el-button>
              <el-button v-else link type="warning" @click="unarchive(scope.row.guqinNo)">撤销归档</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
    </el-tabs>

    <!-- ============ 批次登记对话框 ============ -->
    <el-dialog v-model="batchDialogVisible" :title="editingBatchId ? '编辑材料批次' : '登记材料批次'" width="560px">
      <el-form ref="batchFormRef" :model="batchForm" :rules="batchRules" label-width="100px">
        <el-form-item label="批次号" prop="batchNo">
          <el-input v-model="batchForm.batchNo" placeholder="如：WD-2511 / LQ-2509 / SX-2507" maxlength="24" />
        </el-form-item>
        <el-form-item label="材料类型">
          <el-select v-model="batchForm.materialType" style="width: 200px">
            <el-option v-for="type in MATERIAL_TYPES" :key="type" :label="type" :value="type" />
          </el-select>
        </el-form-item>
        <el-form-item label="供应商" prop="supplier">
          <el-input v-model="batchForm.supplier" placeholder="供料商名称" maxlength="30" />
        </el-form-item>
        <el-form-item label="入库日期">
          <el-date-picker v-model="batchForm.receivedAt" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="batchForm.remark" type="textarea" :rows="2" maxlength="80" placeholder="产地、规格、割漆季等" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="batchDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitBatch">保存</el-button>
      </template>
    </el-dialog>

    <!-- ============ 通知导入对话框 ============ -->
    <el-dialog v-model="noticeDialogVisible" title="导入供应商外部质检通知" width="680px">
      <el-form ref="noticeFormRef" :model="noticeForm" :rules="noticeRules" label-width="100px">
        <el-form-item label="通知文号" prop="noticeNo">
          <el-input v-model="noticeForm.noticeNo" placeholder="如：QC-2026-031（重复导入自动识别）" maxlength="30" />
        </el-form-item>
        <el-form-item label="通知标题" prop="title">
          <el-input v-model="noticeForm.title" placeholder="如：2026 年 9 月生漆批次停用通知" maxlength="40" />
        </el-form-item>
        <el-form-item label="供应商">
          <el-input v-model="noticeForm.supplier" placeholder="供料商名称" maxlength="30" />
        </el-form-item>
        <el-form-item label="到达日期">
          <el-date-picker v-model="noticeForm.receivedAt" type="date" value-format="YYYY-MM-DD" placeholder="选择日期" />
        </el-form-item>
        <el-form-item label="通知摘要">
          <el-input v-model="noticeForm.content" type="textarea" :rows="2" maxlength="120" placeholder="判定结论、影响范围等" />
        </el-form-item>
        <el-form-item label="停用批次">
          <div class="line-list">
            <div v-for="(line, index) in noticeForm.lines" :key="index" class="line-row">
              <el-input v-model="line.batchNo" placeholder="停用批次号" maxlength="24" style="width: 220px" />
              <el-select v-model="line.materialType" placeholder="材料（可空）" clearable style="width: 170px">
                <el-option v-for="type in MATERIAL_TYPES" :key="type" :label="type" :value="type" />
              </el-select>
              <el-button link type="danger" :disabled="noticeForm.lines.length === 1" @click="removeNoticeLine(index)">删除</el-button>
            </div>
            <el-button size="small" @click="addNoticeLine">+ 添加停用批次</el-button>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="noticeDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitNotice">导入并对账冻结</el-button>
      </template>
    </el-dialog>

    <!-- ============ 单条复核对话框 ============ -->
    <el-dialog v-model="reviewDialogVisible" :title="reviewTarget?.status === 'reviewed' ? '复核结果（查看）' : '材料复核处理'" width="620px">
      <template v-if="reviewTarget">
        <el-descriptions :column="2" border size="small" class="block">
          <el-descriptions-item label="琴号">{{ reviewTarget.guqinNo }}</el-descriptions-item>
          <el-descriptions-item label="工序">{{ stageLabelOf(reviewTarget.table) }}</el-descriptions-item>
          <el-descriptions-item label="停用批次">{{ reviewTarget.batchNo }}</el-descriptions-item>
          <el-descriptions-item label="通知文号">{{ reviewTarget.noticeNo }}</el-descriptions-item>
          <el-descriptions-item label="原使用记录" :span="2">
            <div class="ref-label">{{ reviewTarget.snapshot.label }}</div>
            <div class="ref-detail">{{ reviewTarget.snapshot.detail }}</div>
            <div class="ref-detail">{{ formatDate(reviewTarget.snapshot.usedAt) }} · {{ reviewTarget.snapshot.operator || '—' }}</div>
          </el-descriptions-item>
        </el-descriptions>

        <el-form label-width="100px" :disabled="reviewTarget.status === 'reviewed'">
          <el-form-item label="复核结论">
            <el-radio-group v-model="reviewForm.verdict">
              <el-radio v-for="(meta, key) in verdictMeta" :key="key" :value="key" :label="key">{{ meta.label }}</el-radio>
            </el-radio-group>
            <div class="verdict-hint">{{ verdictMeta[reviewForm.verdict].hint }}</div>
          </el-form-item>
          <el-form-item v-if="reviewForm.verdict === 'replace'" label="替代批次">
            <el-select v-model="reviewForm.replacementBatchNo" placeholder="选择同类型替代批次" style="width: 280px">
              <el-option
                v-for="batch in replacementOptions"
                :key="batch.id"
                :label="`${batch.batchNo} · ${batch.supplier}`"
                :value="batch.batchNo"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="复核结果">
            <el-input v-model="reviewForm.resultNote" type="textarea" :rows="2" maxlength="120" placeholder="复检情况、返工安排等" />
          </el-form-item>
          <el-form-item label="复核人">
            <el-input v-model="reviewForm.reviewer" maxlength="16" placeholder="复核人姓名" style="width: 200px" />
          </el-form-item>
        </el-form>
      </template>
      <template #footer>
        <el-button @click="reviewDialogVisible = false">{{ reviewTarget?.status === 'reviewed' ? '关闭' : '取消' }}</el-button>
        <el-button v-if="reviewTarget?.status !== 'reviewed'" type="primary" @click="submitReview">保存复核结果</el-button>
      </template>
    </el-dialog>

    <!-- ============ 同批批量复核对话框 ============ -->
    <el-dialog v-model="batchReviewDialogVisible" title="同通知同批次批量复核" width="560px">
      <template v-if="batchReviewTarget">
        <p class="card-note">
          将对通知下停用批次「{{ batchReviewTarget.batchNo }}」的全部待复核记录统一给出结论；个别琴需要不同处理的，可之后在待复核列表单独改判。
        </p>
        <el-form label-width="100px">
          <el-form-item label="复核结论">
            <el-radio-group v-model="batchReviewForm.verdict">
              <el-radio v-for="(meta, key) in verdictMeta" :key="key" :value="key" :label="key">{{ meta.label }}</el-radio>
            </el-radio-group>
            <div class="verdict-hint">{{ verdictMeta[batchReviewForm.verdict].hint }}</div>
          </el-form-item>
          <el-form-item v-if="batchReviewForm.verdict === 'replace'" label="替代批次">
            <el-select v-model="batchReviewForm.replacementBatchNo" placeholder="选择同类型替代批次" style="width: 280px">
              <el-option
                v-for="batch in batchReplacementOptions"
                :key="batch.id"
                :label="`${batch.batchNo} · ${batch.supplier}`"
                :value="batch.batchNo"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="复核结果">
            <el-input v-model="batchReviewForm.resultNote" type="textarea" :rows="2" maxlength="120" />
          </el-form-item>
          <el-form-item label="复核人">
            <el-input v-model="batchReviewForm.reviewer" maxlength="16" style="width: 200px" />
          </el-form-item>
        </el-form>
      </template>
      <template #footer>
        <el-button @click="batchReviewDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitBatchReview">批量保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page-title {
  margin: 0 0 4px;
  font-size: 20px;
  color: #4a3728;
}
.page-desc {
  margin: 0 0 14px;
  color: #8a7a68;
  font-size: 13px;
}
.stat-row {
  margin-bottom: 12px;
}
.stat-row .el-col {
  margin-bottom: 12px;
}
.toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.block {
  margin-bottom: 16px;
}
.alert {
  margin-bottom: 12px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.card-note {
  font-size: 12px;
  color: #8a7a68;
}
.guqin-count {
  margin-left: 6px;
}
.ref-label {
  font-weight: 600;
  color: #4a3728;
}
.ref-detail {
  font-size: 12px;
  color: #8a7a68;
}
.supplier-name {
  margin-left: 8px;
  font-size: 12px;
  color: #8a7a68;
}
.cursor {
  font-size: 12px;
  color: #8a7a68;
}
.error-text {
  color: #c62828;
}
.verdict-hint {
  font-size: 12px;
  color: #8a7a68;
  margin-top: 4px;
}
.line-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.line-row {
  display: flex;
  gap: 8px;
  align-items: center;
}
</style>
