<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Upload } from '@element-plus/icons-vue';
import StatBadge from '../components/common/StatBadge.vue';
import { useMaterialStore } from '../stores/materialStore';
import { useBoardStore } from '../stores/boardStore';
import { useLacquerStore } from '../stores/lacquerStore';
import { useStringingStore } from '../stores/stringingStore';
import { useChamberStore } from '../stores/chamberStore';
import { useStageProgress } from '../hooks/useStageProgress';
import { buildUsageRefs, sourceLabel, ARCHIVE_STATE_LABELS, ARCHIVE_STATE_TAG_TYPE } from '../utils/material';
import { formatDate } from '../utils/layer';
import { SAMPLE_NOTICE_TEXT } from '../utils/notice';
import {
  MATERIAL_CATEGORIES,
  MATERIAL_CATEGORY_LABELS,
  NOTICE_STATUS_LABELS,
  REVIEW_RESULT_LABELS,
  REVIEW_RESULTS,
  type MaterialBatch,
  type MaterialCategory,
  type MaterialReview,
  type NoticeStatus,
  type ReviewResult,
  type ArchiveState,
  type UsageRef,
} from '../types/material';

type TraceMode = 'batch' | 'guqin';

const route = useRoute();
const router = useRouter();
const materialStore = useMaterialStore();
const boardStore = useBoardStore();
const lacquerStore = useLacquerStore();
const stringingStore = useStringingStore();
const chamberStore = useChamberStore();
const { progressList, guqinNos: allGuqinNos } = useStageProgress();

const tabs = [
  { key: 'batch', label: '批次台账' },
  { key: 'trace', label: '去向对账' },
  { key: 'notice', label: '质检通知' },
  { key: 'review', label: '复核处理' },
  { key: 'archive', label: '成琴归档' },
] as const;
type TabKey = (typeof tabs)[number]['key'];

const activeTab = ref<TabKey>(((route.query.tab as string) || 'batch') as TabKey);
watch(activeTab, (tab) => {
  void router.replace({ query: { ...route.query, tab } });
});

onMounted(() => {
  void materialStore.hydrate();
  if (route.query.tab === 'review' && typeof route.query.guqin === 'string') {
    reviewGuqinFilter.value = route.query.guqin;
  }
});

// ---------------- 共用：材料去向引用 ----------------

const allRefs = computed<UsageRef[]>(() =>
  buildUsageRefs(boardStore.boards, lacquerStore.layers, stringingStore.stringings),
);

/** 某批次被使用的条数（批次台账展示） */
function usageCountOf(category: MaterialCategory, batchNo: string): number {
  return allRefs.value.filter((r) => r.category === category && r.batchNo === batchNo).length;
}

function frozenRef(ref: UsageRef): MaterialReview | undefined {
  return materialStore.pendingReviewOf(ref.category, ref.recordId);
}

// ---------------- Tab 1：批次台账 ----------------

const batchDialogVisible = ref(false);
const batchEditingId = ref('');
const batchForm = ref<{ category: MaterialCategory; batchNo: string; supplier: string; receivedAt: string; remark: string }>(
  {
    category: 'wood',
    batchNo: '',
    supplier: '',
    receivedAt: new Date().toISOString().slice(0, 10),
    remark: '',
  },
);

const batchCategoryFilter = ref<MaterialCategory | ''>('');
const visibleBatches = computed(() =>
  batchCategoryFilter.value
    ? materialStore.batches
        .filter((b) => b.category === batchCategoryFilter.value)
        .sort((a, b) => a.batchNo.localeCompare(b.batchNo))
    : [...materialStore.batches].sort((a, b) =>
        `${a.category}${a.batchNo}`.localeCompare(`${b.category}${b.batchNo}`),
      ),
);

function openBatchCreate(category: MaterialCategory = 'wood') {
  batchEditingId.value = '';
  batchForm.value = {
    category,
    batchNo: '',
    supplier: '',
    receivedAt: new Date().toISOString().slice(0, 10),
    remark: '',
  };
  batchDialogVisible.value = true;
}

function openBatchEdit(batch: MaterialBatch) {
  batchEditingId.value = batch.id;
  batchForm.value = {
    category: batch.category,
    batchNo: batch.batchNo,
    supplier: batch.supplier ?? '',
    receivedAt: batch.receivedAt.slice(0, 10),
    remark: batch.remark ?? '',
  };
  batchDialogVisible.value = true;
}

async function submitBatch() {
  const batchNo = batchForm.value.batchNo.trim();
  if (!batchNo) {
    ElMessage.warning('请填写批次号');
    return;
  }
  try {
    await materialStore.upsertBatch({
      category: batchForm.value.category,
      batchNo,
      supplier: batchForm.value.supplier,
      receivedAt: new Date(`${batchForm.value.receivedAt}T09:00:00`).toISOString(),
      remark: batchForm.value.remark,
    });
    ElMessage.success(batchEditingId.value ? '已更新批次' : `已登记批次 ${batchNo}`);
    batchDialogVisible.value = false;
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

async function toggleBatchStatus(batch: MaterialBatch) {
  const toStop = batch.status === 'active';
  const confirmed = await ElMessageBox.confirm(
    toStop ? `确认手动停用批次 ${batch.batchNo}？停用后新记录不能再选用。` : `确认重新启用批次 ${batch.batchNo}？`,
    '批次状态',
    { type: 'warning' },
  )
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await materialStore.setBatchStatus(batch.id, toStop ? 'stopped' : 'active');
  ElMessage.success(toStop ? '已停用' : '已启用');
}

async function removeBatch(batch: MaterialBatch) {
  const confirmed = await ElMessageBox.confirm(`确认删除批次 ${batch.batchNo}？已被引用的批次无法删除。`, '删除确认', {
    type: 'warning',
  })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  try {
    await materialStore.removeBatch(batch.id);
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

// ---------------- Tab 2：去向对账 ----------------

const traceMode = ref<TraceMode>('batch');
const traceCategory = ref<MaterialCategory>('wood');
const traceBatchNo = ref('');
const traceGuqinNo = ref('');

const traceCategoryOptions = computed(() => materialStore.batchesOfCategory(traceCategory.value));

watch(traceCategory, () => {
  traceBatchNo.value = '';
});

function jumpBatch(batch: MaterialBatch) {
  traceMode.value = 'batch';
  traceCategory.value = batch.category;
  traceBatchNo.value = batch.batchNo;
  activeTab.value = 'trace';
}

const traceResults = computed<UsageRef[]>(() => {
  if (traceMode.value === 'batch') {
    if (!traceBatchNo.value) return [];
    return allRefs.value
      .filter((r) => r.category === traceCategory.value && r.batchNo === traceBatchNo.value)
      .sort((a, b) => b.at.localeCompare(a.at));
  }
  if (!traceGuqinNo.value) return [];
  const order: MaterialCategory[] = ['wood', 'lacquer', 'string'];
  return allRefs.value
    .filter((r) => r.guqinNo === traceGuqinNo.value)
    .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || b.at.localeCompare(a.at));
});

const traceBatchInfo = computed<MaterialBatch | undefined>(() =>
  traceMode.value === 'batch' && traceBatchNo.value
    ? materialStore.batches.find(
        (b) => b.category === traceCategory.value && b.batchNo === traceBatchNo.value,
      )
    : undefined,
);

// ---------------- Tab 3：质检通知 ----------------

const importDialogVisible = ref(false);
const importText = ref('');
const importing = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

function openImport() {
  importText.value = '';
  importDialogVisible.value = true;
}

function fillSample() {
  importText.value = SAMPLE_NOTICE_TEXT;
}

function triggerFile() {
  fileInput.value?.click();
}

function onFileChange(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    importText.value = String(reader.result ?? '');
  };
  reader.readAsText(file, 'utf-8');
  input.value = '';
}

async function submitImport() {
  if (!importText.value.trim()) {
    ElMessage.warning('请粘贴通知内容或选择通知文件');
    return;
  }
  importing.value = true;
  try {
    const result = await materialStore.importNoticeText(importText.value);
    ElMessage.success(
      `导入完成：新增 ${result.created} 张，断点续扫 ${result.resumed} 张，重复跳过 ${result.skipped} 张，失败 ${result.failed} 张`,
    );
    if (result.failed === 0) importDialogVisible.value = false;
  } catch (e) {
    ElMessage.error(`导入失败（未写入任何通知）：${(e as Error).message}`);
  } finally {
    importing.value = false;
  }
}

async function retryNotice(noticeId: string) {
  try {
    await materialStore.retryNotice(noticeId);
    ElMessage.success('已从原进度继续处理完成');
  } catch (e) {
    ElMessage.error(`重试仍失败：${(e as Error).message}`);
  }
}

function noticeProgress(notice: { processedCount: number; totalCount: number }): number {
  if (!notice.totalCount) return 0;
  return Math.round((notice.processedCount / notice.totalCount) * 100);
}

function noticeTagType(status: NoticeStatus): 'info' | 'warning' | 'success' | 'danger' {
  if (status === 'done') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'processing') return 'warning';
  return 'info';
}

// ---------------- Tab 4：复核处理 ----------------

const reviewStatusFilter = ref<'pending' | 'resolved' | ''>('pending');
const reviewCategoryFilter = ref<MaterialCategory | ''>('');
const reviewGuqinFilter = ref('');
const reviewKeyword = ref('');

const visibleReviews = computed(() =>
  materialStore.reviews.filter((r) => {
    if (reviewStatusFilter.value && r.status !== reviewStatusFilter.value) return false;
    if (reviewCategoryFilter.value && r.category !== reviewCategoryFilter.value) return false;
    if (reviewGuqinFilter.value && r.guqinNo !== reviewGuqinFilter.value) return false;
    const kw = reviewKeyword.value.trim().toLowerCase();
    if (kw) {
      const hay = `${r.noticeNo} ${r.batchNo} ${r.guqinNo} ${r.stageLabel} ${r.reviewNote ?? ''} ${
        r.replacementBatchNo ?? ''
      } ${r.reviewer ?? ''}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  }),
);

// 复核对话框
const reviewDialogVisible = ref(false);
const reviewEditing = ref<MaterialReview | null>(null);
const reviewResult = ref<ReviewResult>('replace');
const replacementBatchNo = ref('');
const reviewer = ref('');
const reviewNote = ref('');

function openReview(review: MaterialReview) {
  reviewEditing.value = review;
  reviewResult.value = review.result ?? 'replace';
  replacementBatchNo.value = review.replacementBatchNo ?? '';
  reviewer.value = review.reviewer ?? '';
  reviewNote.value = review.reviewNote ?? '';
  reviewDialogVisible.value = true;
}

const reviewReplacementOptions = computed(() =>
  reviewEditing.value ? materialStore.batchOptionsOfCategory(reviewEditing.value.category) : [],
);

/** 被冻结原使用记录的明细快照（只读，原记录继续可追溯） */
const reviewOriginal = computed(() => {
  const review = reviewEditing.value;
  if (!review) return null;
  if (review.category === 'wood') {
    const b = boardStore.boards.find((x) => x.id === review.recordId);
    if (!b) return { missing: true, lines: ['原板材记录已不存在（复核单保留批次与工序痕迹）'] };
    return {
      missing: false,
      lines: [
        `板材号 ${b.boardNo} · ${b.part} · ${b.species}`,
        `琴号 ${b.guqinNo} · 入库 ${formatDate(b.receivedAt)}`,
        `原批次 ${sourceLabel(b.batchNo)} · 登记人备注：${b.remark ?? '无'}`,
      ],
    };
  }
  if (review.category === 'lacquer') {
    const l = lacquerStore.layers.find((x) => x.id === review.recordId);
    if (!l) return { missing: true, lines: ['原髹漆遍次记录已不存在（复核单保留批次与工序痕迹）'] };
    return {
      missing: false,
      lines: [
        `琴号 ${l.guqinNo} · 第 ${l.seq} 遍 · ${l.mixRatio}`,
        `施工 ${formatDate(l.appliedAt)} · ${l.operator} · 荫房 ${l.curingTemp}℃/${l.curingHumidity}%`,
        `本遍 ${l.layerThickness}mm · 累计 ${l.totalThickness}mm · 原批次 ${sourceLabel(l.batchNo)}`,
      ],
    };
  }
  const s = stringingStore.stringings.find((x) => x.id === review.recordId);
  if (!s) return { missing: true, lines: ['原上弦记录已不存在（复核单保留批次与工序痕迹）'] };
  return {
    missing: false,
    lines: [
      `琴号 ${s.guqinNo} · ${s.stringType} · ${s.nut}`,
      `上弦 ${formatDate(s.strungAt)} · ${s.operator} · 弦距 ${s.stringGap}mm`,
      `原批次 ${sourceLabel(s.batchNo)} · 缺陷 ${s.defects.join('/')}`,
    ],
  };
});

async function submitReview() {
  const review = reviewEditing.value;
  if (!review) return;
  try {
    await materialStore.resolveReview(review.id, {
      result: reviewResult.value,
      replacementBatchNo: reviewResult.value === 'replace' ? replacementBatchNo.value : undefined,
      reviewer: reviewer.value,
      reviewNote: reviewNote.value,
    });
    ElMessage.success('复核结果已留存，原使用记录保持可追溯');
    reviewDialogVisible.value = false;
  } catch (e) {
    ElMessage.error((e as Error).message);
  }
}

// ---------------- Tab 5：成琴归档 ----------------

const archiveOperator = ref('档案员');

const archiveRows = computed(() =>
  allGuqinNos.value.map((guqinNo) => {
    const boards = boardStore.boards.filter((b) => b.guqinNo === guqinNo);
    const layers = lacquerStore.layers.filter((l) => l.guqinNo === guqinNo);
    const stringings = stringingStore.stringings.filter((s) => s.guqinNo === guqinNo);
    const pendingReviews = materialStore.pendingReviewsOfGuqin(guqinNo);
    const archive = materialStore.archiveOf(guqinNo);
    const progress = progressList.value.find((p) => p.guqinNo === guqinNo);
    const state = (() => {
      // 与 archiveStateOf 同一规则（held 优先），这里直接调用保持一致
      const held = pendingReviews.length > 0;
      if (held) return 'held' as const;
      if (archive) return 'archived' as const;
      const ready =
        boards.some((b) => b.part === '面板') &&
        boards.some((b) => b.part === '底板') &&
        Boolean(chamberStore.byGuqin(guqinNo)) &&
        layers.length > 0 &&
        stringings.length > 0;
      return ready ? ('ready' as const) : ('not_ready' as const);
    })();
    return {
      guqinNo,
      species: progress?.species ?? '',
      state,
      pendingReviews,
      missing: progress?.missing ?? [],
      archive,
    };
  }),
);

async function doArchive(guqinNo: string) {
  const { value } = await ElMessageBox.prompt(`确认将 ${guqinNo} 成琴归档？`, '成琴归档', {
    confirmButtonText: '归档',
    cancelButtonText: '取消',
    inputValue: archiveOperator.value || '档案员',
    inputPlaceholder: '归档操作人',
  }).catch(() => ({ value: '' }));
  if (!value) return;
  archiveOperator.value = value;
  await materialStore.archiveGuqin(guqinNo, value);
  ElMessage.success(`${guqinNo} 已成琴归档`);
}

async function doUnarchive(guqinNo: string) {
  const confirmed = await ElMessageBox.confirm(`确认撤销 ${guqinNo} 的成琴归档？`, '撤销归档', {
    type: 'warning',
  })
    .then(() => true)
    .catch(() => false);
  if (!confirmed) return;
  await materialStore.unarchiveGuqin(guqinNo);
  ElMessage.success('已撤销归档');
}

function goReviewGuqin(guqinNo: string) {
  reviewStatusFilter.value = 'pending';
  reviewGuqinFilter.value = guqinNo;
  activeTab.value = 'review';
}
</script>

<template>
  <div>
    <h2 class="page-title">材料去向对账</h2>
    <p class="page-desc">
      板材、髹漆遍次与上弦记录都挂材料批次：从批次能查到琴与各工序，从琴能回看材料来源。质检通知到达后仅冻结确实用过该批次的记录并暂缓成琴归档；来源不明的旧数据不当作污染。
    </p>

    <el-row :gutter="12" class="stat-row">
      <el-col :xs="12" :md="6">
        <StatBadge label="登记批次" :value="materialStore.batches.length" unit="个" />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge label="停用批次" :value="materialStore.batches.filter((b) => b.status === 'stopped').length" unit="个" status="warning" />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge label="待复核记录" :value="materialStore.pendingCount" unit="条" :status="materialStore.pendingCount ? 'danger' : 'success'" />
      </el-col>
      <el-col :xs="12" :md="6">
        <StatBadge label="暂缓归档琴" :value="archiveRows.filter((r) => r.state === 'held').length" unit="张" :status="archiveRows.some((r) => r.state === 'held') ? 'danger' : 'success'" />
      </el-col>
    </el-row>

    <el-tabs v-model="activeTab" class="trace-tabs">
      <!-- ========== 批次台账 ========== -->
      <el-tab-pane label="批次台账" name="batch">
        <div class="toolbar">
          <el-button type="primary" @click="openBatchCreate('wood')">登记批次</el-button>
          <el-radio-group v-model="batchCategoryFilter" size="small">
            <el-radio-button value="">全部</el-radio-button>
            <el-radio-button v-for="c in MATERIAL_CATEGORIES" :key="c" :value="c">
              {{ MATERIAL_CATEGORY_LABELS[c] }}
            </el-radio-button>
          </el-radio-group>
        </div>

        <el-card shadow="never" class="block">
          <el-table :data="visibleBatches" size="small" border>
            <el-table-column label="材料" width="90">
              <template #default="scope">{{ MATERIAL_CATEGORY_LABELS[scope.row.category as MaterialCategory] }}</template>
            </el-table-column>
            <el-table-column prop="batchNo" label="批次号" width="140" />
            <el-table-column prop="supplier" label="供料商" min-width="130">
              <template #default="scope">{{ scope.row.supplier || '—' }}</template>
            </el-table-column>
            <el-table-column label="入库日期" width="110">
              <template #default="scope">{{ formatDate(scope.row.receivedAt) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="90">
              <template #default="scope">
                <el-tag :type="scope.row.status === 'active' ? 'success' : 'danger'" size="small">
                  {{ scope.row.status === 'active' ? '在用' : '停用' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="已用于" width="90">
              <template #default="scope">{{ usageCountOf(scope.row.category, scope.row.batchNo) }} 条</template>
            </el-table-column>
            <el-table-column prop="remark" label="备注" min-width="140" show-overflow-tooltip />
            <el-table-column label="操作" width="230" fixed="right">
              <template #default="scope">
                <el-button link type="primary" @click="jumpBatch(scope.row)">查去向</el-button>
                <el-button link type="primary" @click="openBatchEdit(scope.row)">编辑</el-button>
                <el-button link :type="scope.row.status === 'active' ? 'warning' : 'success'" @click="toggleBatchStatus(scope.row)">
                  {{ scope.row.status === 'active' ? '停用' : '启用' }}
                </el-button>
                <el-button link type="danger" @click="removeBatch(scope.row)">删除</el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ========== 去向对账 ========== -->
      <el-tab-pane label="去向对账" name="trace">
        <el-card shadow="never" class="block">
          <el-radio-group v-model="traceMode" class="mode-switch">
            <el-radio-button value="batch">从批次查琴与工序</el-radio-button>
            <el-radio-button value="guqin">从琴回看材料来源</el-radio-button>
          </el-radio-group>

          <div v-if="traceMode === 'batch'" class="trace-filters">
            <el-select v-model="traceCategory" style="width: 120px">
              <el-option v-for="c in MATERIAL_CATEGORIES" :key="c" :label="MATERIAL_CATEGORY_LABELS[c]" :value="c" />
            </el-select>
            <el-select
              v-model="traceBatchNo"
              filterable
              clearable
              placeholder="选择批次号（未登记批次显示在各工序页为来源不明）"
              style="width: 320px"
            >
              <el-option
                v-for="no in traceCategoryOptions"
                :key="no"
                :label="no"
                :value="no"
              />
            </el-select>
            <el-tag v-if="traceBatchInfo" :type="traceBatchInfo.status === 'active' ? 'success' : 'danger'" effect="plain">
              {{ traceBatchInfo.status === 'active' ? '在用' : '已停用' }} · {{ traceBatchInfo.supplier || '供料商未登记' }}
            </el-tag>
            <el-button link type="primary" @click="activeTab = 'batch'">去登记/维护批次</el-button>
          </div>

          <div v-else class="trace-filters">
            <el-select v-model="traceGuqinNo" filterable clearable placeholder="选择琴号" style="width: 220px">
              <el-option v-for="no in allGuqinNos" :key="no" :label="no" :value="no" />
            </el-select>
          </div>
        </el-card>

        <el-card shadow="never" class="block">
          <template #header>
            <span>
              {{ traceMode === 'batch' ? `批次 ${traceBatchNo || '…'} 的去向（${traceResults.length} 条）` : `${traceGuqinNo || '琴'} 的材料来源（${traceResults.length} 条）` }}
            </span>
          </template>
          <el-empty v-if="traceResults.length === 0" :image-size="70" description="选择批次或琴号后展示去向明细；来源不明的旧记录按琴可查、不挂任何批次" />
          <el-table v-else :data="traceResults" size="small" border>
            <el-table-column label="材料" width="90">
              <template #default="scope">{{ MATERIAL_CATEGORY_LABELS[scope.row.category as MaterialCategory] }}</template>
            </el-table-column>
            <el-table-column prop="guqinNo" label="琴号" width="110" />
            <el-table-column prop="stageLabel" label="工序" min-width="170" />
            <el-table-column label="材料来源" width="160">
              <template #default="scope">
                <el-tag v-if="scope.row.batchNo" size="small" type="info">{{ scope.row.batchNo }}</el-tag>
                <el-tag v-else size="small" type="warning">来源不明</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="日期" width="110">
              <template #default="scope">{{ formatDate(scope.row.at) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="120">
              <template #default="scope">
                <el-tag v-if="frozenRef(scope.row)" type="danger" size="small">待复核冻结</el-tag>
                <el-tag v-else type="success" size="small">正常</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="110">
              <template #default="scope">
                <el-button v-if="frozenRef(scope.row)" link type="primary" @click="goReviewGuqin(scope.row.guqinNo)">
                  去复核
                </el-button>
                <span v-else class="card-note">—</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ========== 质检通知 ========== -->
      <el-tab-pane label="质检通知" name="notice">
        <div class="toolbar">
          <el-button type="primary" :icon="Upload" @click="openImport">导入质检通知</el-button>
          <span class="card-note">支持 JSON（单条/数组）或每行「通知号,类别,批次号,供料商,日期,事由」；同一通知重复导入不重复冻结。</span>
        </div>

        <el-card shadow="never" class="block">
          <el-table :data="materialStore.activeNotices" size="small" border>
            <el-table-column prop="noticeNo" label="通知号" width="150" />
            <el-table-column label="材料" width="80">
              <template #default="scope">{{ MATERIAL_CATEGORY_LABELS[scope.row.category as MaterialCategory] }}</template>
            </el-table-column>
            <el-table-column prop="batchNo" label="判废批次" width="130" />
            <el-table-column prop="supplier" label="供料商" min-width="110">
              <template #default="scope">{{ scope.row.supplier || '—' }}</template>
            </el-table-column>
            <el-table-column label="通知日期" width="105">
              <template #default="scope">{{ formatDate(scope.row.notifiedAt) }}</template>
            </el-table-column>
            <el-table-column label="状态" width="100">
              <template #default="scope">
                <el-tag :type="noticeTagType(scope.row.status as NoticeStatus)" size="small">
                  {{ NOTICE_STATUS_LABELS[scope.row.status as NoticeStatus] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="扫描进度" width="150">
              <template #default="scope">
                <el-progress :percentage="noticeProgress(scope.row)" :stroke-width="10" />
                <span class="card-note">{{ scope.row.processedCount }}/{{ scope.row.totalCount }}</span>
              </template>
            </el-table-column>
            <el-table-column label="冻结" width="70">
              <template #default="scope">{{ scope.row.frozenCount }}</template>
            </el-table-column>
            <el-table-column prop="reason" label="事由 / 错误" min-width="160" show-overflow-tooltip>
              <template #default="scope">
                <span v-if="scope.row.lastError" class="error-text">{{ scope.row.lastError }}</span>
                <span v-else>{{ scope.row.reason || '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="110" fixed="right">
              <template #default="scope">
                <el-button
                  v-if="scope.row.status === 'failed' || scope.row.status === 'processing'"
                  link
                  type="primary"
                  @click="retryNotice(scope.row.id)"
                >
                  断点重试
                </el-button>
                <span v-else class="card-note">已完结</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ========== 复核处理 ========== -->
      <el-tab-pane :label="materialStore.pendingCount ? `复核处理（${materialStore.pendingCount}）` : '复核处理'" name="review">
        <div class="toolbar toolbar-wrap">
          <el-select v-model="reviewStatusFilter" placeholder="状态" clearable style="width: 120px">
            <el-option label="待复核" value="pending" />
            <el-option label="已处理" value="resolved" />
          </el-select>
          <el-select v-model="reviewCategoryFilter" placeholder="材料" clearable style="width: 120px">
            <el-option v-for="c in MATERIAL_CATEGORIES" :key="c" :label="MATERIAL_CATEGORY_LABELS[c]" :value="c" />
          </el-select>
          <el-select v-model="reviewGuqinFilter" placeholder="琴号" filterable clearable style="width: 140px">
            <el-option v-for="no in allGuqinNos" :key="no" :label="no" :value="no" />
          </el-select>
          <el-input v-model="reviewKeyword" placeholder="通知号 / 批次 / 琴号 / 复核备注" clearable style="width: 260px" />
        </div>

        <el-card shadow="never" class="block">
          <el-table :data="visibleReviews" size="small" border>
            <el-table-column prop="noticeNo" label="通知号" width="140" />
            <el-table-column label="材料" width="80">
              <template #default="scope">{{ MATERIAL_CATEGORY_LABELS[scope.row.category as MaterialCategory] }}</template>
            </el-table-column>
            <el-table-column prop="batchNo" label="原批次" width="120" />
            <el-table-column prop="guqinNo" label="琴号" width="100" />
            <el-table-column prop="stageLabel" label="工序" min-width="150" />
            <el-table-column label="冻结日期" width="105">
              <template #default="scope">{{ formatDate(scope.row.frozenAt) }}</template>
            </el-table-column>
            <el-table-column label="状态/结果" width="200">
              <template #default="scope">
                <el-tag v-if="scope.row.status === 'pending'" type="danger" size="small">待复核</el-tag>
                <template v-else>
                  <el-tag type="success" size="small">{{ REVIEW_RESULT_LABELS[scope.row.result as ReviewResult] }}</el-tag>
                  <div v-if="scope.row.replacementBatchNo" class="card-note">替代批次 {{ scope.row.replacementBatchNo }}</div>
                  <div class="card-note">{{ scope.row.reviewer || '未署名' }} · {{ scope.row.resolvedAt ? formatDate(scope.row.resolvedAt) : '' }}</div>
                </template>
              </template>
            </el-table-column>
            <el-table-column prop="reviewNote" label="复核备注" min-width="140" show-overflow-tooltip>
              <template #default="scope">{{ scope.row.reviewNote || '—' }}</template>
            </el-table-column>
            <el-table-column label="操作" width="110" fixed="right">
              <template #default="scope">
                <el-button link type="primary" @click="openReview(scope.row)">
                  {{ scope.row.status === 'pending' ? '处理复核' : '查看' }}
                </el-button>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>

      <!-- ========== 成琴归档 ========== -->
      <el-tab-pane label="成琴归档" name="archive">
        <el-card shadow="never" class="block">
          <template #header>
            <span class="card-note">有待复核记录的琴暂缓成琴归档；通知全部复核完毕后恢复「可归档」。没碰过判废批次的琴不受牵连。</span>
          </template>
          <el-table :data="archiveRows" size="small" border>
            <el-table-column prop="guqinNo" label="琴号" width="110" />
            <el-table-column prop="species" label="树种" width="90" />
            <el-table-column label="待复核" min-width="200">
              <template #default="scope">
                <template v-if="scope.row.pendingReviews.length">
                  <el-tag
                    v-for="(rv, i) in scope.row.pendingReviews"
                    :key="i"
                    type="danger"
                    size="small"
                    class="frozen-tag"
                  >
                    {{ MATERIAL_CATEGORY_LABELS[rv.category as MaterialCategory] }}·{{ rv.stageLabel }}
                  </el-tag>
                </template>
                <el-tag v-else type="success" size="small">无</el-tag>
              </template>
            </el-table-column>
            <el-table-column label="缺失工序" min-width="130">
              <template #default="scope">
                <span v-if="scope.row.missing.length" class="missing">{{ scope.row.missing.join('、') }}</span>
                <span v-else class="card-note">四阶段齐备</span>
              </template>
            </el-table-column>
            <el-table-column label="归档状态" width="110">
              <template #default="scope">
                <el-tag :type="ARCHIVE_STATE_TAG_TYPE[scope.row.state as ArchiveState]" size="small">
                  {{ ARCHIVE_STATE_LABELS[scope.row.state as ArchiveState] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="归档时间/人" min-width="160">
              <template #default="scope">
                <template v-if="scope.row.archive">
                  {{ formatDate(scope.row.archive.archivedAt) }} · {{ scope.row.archive.operator }}
                </template>
                <span v-else class="card-note">—</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="180" fixed="right">
              <template #default="scope">
                <el-button
                  v-if="scope.row.state === 'ready'"
                  link
                  type="primary"
                  @click="doArchive(scope.row.guqinNo)"
                >
                  成琴归档
                </el-button>
                <el-button v-if="scope.row.state === 'held'" link type="primary" @click="goReviewGuqin(scope.row.guqinNo)">
                  去复核
                </el-button>
                <el-button v-if="scope.row.state === 'archived'" link type="warning" @click="doUnarchive(scope.row.guqinNo)">
                  撤销归档
                </el-button>
                <span v-if="scope.row.state === 'not_ready'" class="card-note">工序未齐</span>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <!-- 批次登记对话框 -->
    <el-dialog v-model="batchDialogVisible" :title="batchEditingId ? '编辑批次' : '登记材料批次'" width="560px">
      <el-form label-width="100px">
        <el-form-item label="材料类别" required>
          <el-select v-model="batchForm.category" :disabled="Boolean(batchEditingId)" style="width: 200px">
            <el-option v-for="c in MATERIAL_CATEGORIES" :key="c" :label="MATERIAL_CATEGORY_LABELS[c]" :value="c" />
          </el-select>
        </el-form-item>
        <el-form-item label="批次号" required>
          <el-input v-model="batchForm.batchNo" :disabled="Boolean(batchEditingId)" placeholder="如：LQ-2512" maxlength="30" style="width: 260px" />
        </el-form-item>
        <el-form-item label="供料商">
          <el-input v-model="batchForm.supplier" placeholder="如：秦岭漆源" maxlength="30" style="width: 260px" />
        </el-form-item>
        <el-form-item label="入库日期">
          <el-date-picker v-model="batchForm.receivedAt" type="date" value-format="YYYY-MM-DD" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="batchForm.remark" type="textarea" :rows="2" maxlength="80" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="batchDialogVisible = false">取消</el-button>
        <el-button type="primary" @click="submitBatch">保存</el-button>
      </template>
    </el-dialog>

    <!-- 通知导入对话框 -->
    <el-dialog v-model="importDialogVisible" title="导入供料商质检通知" width="640px">
      <el-input
        v-model="importText"
        type="textarea"
        :rows="10"
        placeholder='粘贴 JSON：&#10;[&#10;  { "noticeNo": "QC-LQ-2603-01", "category": "生漆", "batchNo": "LQ-2510", "supplier": "秦岭漆源", "notifiedAt": "2026-10-01", "reason": "含水率超标" }&#10;]&#10;类别可填 木料 / 生漆 / 琴弦'
      />
      <div class="dialog-actions">
        <input ref="fileInput" type="file" accept=".json,.txt,application/json,text/plain" hidden @change="onFileChange" />
        <el-button :icon="Upload" @click="triggerFile">选择通知文件</el-button>
        <el-button @click="fillSample">填入示例</el-button>
      </div>
      <template #footer>
        <el-button @click="importDialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="importing" @click="submitImport">导入并冻结去向</el-button>
      </template>
    </el-dialog>

    <!-- 复核处理对话框 -->
    <el-dialog v-model="reviewDialogVisible" title="材料复核处理" width="640px">
      <div v-if="reviewEditing">
        <el-descriptions :column="2" border size="small" class="review-desc">
          <el-descriptions-item label="通知号">{{ reviewEditing.noticeNo }}</el-descriptions-item>
          <el-descriptions-item label="停用批次">{{ reviewEditing.batchNo }}</el-descriptions-item>
          <el-descriptions-item label="琴号">{{ reviewEditing.guqinNo }}</el-descriptions-item>
          <el-descriptions-item label="工序">{{ reviewEditing.stageLabel }}</el-descriptions-item>
        </el-descriptions>

        <el-alert
          class="review-original"
          type="info"
          :closable="false"
          title="原使用记录（只读快照，原批次不被改写，继续可追溯）"
        >
          <div v-for="(line, i) in reviewOriginal?.lines" :key="i">{{ line }}</div>
        </el-alert>

        <el-form label-width="110px" class="review-form">
          <el-form-item label="复核结果" required>
            <el-radio-group v-model="reviewResult" :disabled="reviewEditing.status === 'resolved'">
              <el-radio v-for="r in REVIEW_RESULTS" :key="r" :value="r">{{ REVIEW_RESULT_LABELS[r] }}</el-radio>
            </el-radio-group>
          </el-form-item>
          <el-form-item v-if="reviewResult === 'replace'" label="替代批次" required>
            <el-select
              v-model="replacementBatchNo"
              filterable
              placeholder="选择同类别的在用替代批次"
              :disabled="reviewEditing.status === 'resolved'"
              style="width: 280px"
            >
              <el-option v-for="no in reviewReplacementOptions" :key="no" :label="no" :value="no" />
            </el-select>
            <el-button link type="primary" @click="activeTab = 'batch'">先去登记替代批次</el-button>
          </el-form-item>
          <el-form-item label="复核人">
            <el-input v-model="reviewer" :disabled="reviewEditing.status === 'resolved'" placeholder="如：周砚秋" maxlength="16" style="width: 240px" />
          </el-form-item>
          <el-form-item label="复核备注">
            <el-input
              v-model="reviewNote"
              type="textarea"
              :rows="3"
              :disabled="reviewEditing.status === 'resolved'"
              placeholder="复检数据、处置说明等"
              maxlength="120"
            />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="reviewDialogVisible = false">{{ reviewEditing?.status === 'resolved' ? '关闭' : '取消' }}</el-button>
        <el-button v-if="reviewEditing?.status === 'pending'" type="primary" @click="submitReview">提交复核结果</el-button>
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
  margin: 0 0 12px;
  color: #8a7a68;
  font-size: 13px;
}
.stat-row {
  margin-bottom: 8px;
}
.stat-row .el-col {
  margin-bottom: 12px;
}
.block {
  margin-bottom: 16px;
  border-radius: 8px;
}
.toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.toolbar-wrap {
  gap: 8px;
}
.trace-filters {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.mode-switch {
  margin-bottom: 12px;
}
.card-note {
  font-size: 12px;
  color: #8a7a68;
}
.error-text {
  color: #c62828;
  font-size: 12px;
}
.missing {
  color: #c62828;
  font-size: 13px;
}
.frozen-tag {
  margin: 2px 4px 2px 0;
}
.dialog-actions {
  margin-top: 8px;
  display: flex;
  gap: 8px;
}
.review-desc {
  margin-bottom: 12px;
}
.review-original {
  margin-bottom: 12px;
}
.review-form {
  margin-top: 8px;
}
</style>
