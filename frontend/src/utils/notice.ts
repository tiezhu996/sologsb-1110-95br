import type { MaterialCategory } from '../types/material';
import { MATERIAL_CATEGORIES, MATERIAL_CATEGORY_LABELS } from '../types/material';

/** 解析后的通知条目（批量导入可含多张通知） */
export interface NoticeInput {
  noticeNo: string;
  category: MaterialCategory;
  batchNo: string;
  supplier?: string;
  /** 可被 Date 解析的日期；缺省时按导入时间 */
  notifiedAt?: string;
  reason?: string;
}

/** 类别反查：接受中文名（木料/生漆/琴弦）与英文键 */
export function normalizeCategory(value: unknown): MaterialCategory | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if ((MATERIAL_CATEGORIES as string[]).includes(v)) return v as MaterialCategory;
  const hit = MATERIAL_CATEGORIES.find((c) => MATERIAL_CATEGORY_LABELS[c] === v);
  return hit;
}

/**
 * 解析供料商质检通知文本。支持：
 * - JSON：单对象或数组（{ noticeNo, category, batchNo, supplier?, notifiedAt?, reason? }）；
 * - 纯文本按行：每行「通知号,类别,批次号[,供料商][,日期][,事由]」，# 开头为注释。
 *
 * 解析/校验失败直接抛错：一条非法都不导入（调用方据此整体提示，不产生半成品进度）。
 */
export function parseNoticeText(text: string): NoticeInput[] {
  const raw = text.trim();
  if (!raw) throw new Error('通知内容为空');

  let entries: unknown[];
  if (raw.startsWith('{') || raw.startsWith('[')) {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      throw new Error(`通知 JSON 解析失败：${(e as Error).message}`);
    }
    entries = Array.isArray(json) ? json : [json];
  } else {
    entries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const cells = line.split(/[,，\t]/).map((c) => c.trim());
        return {
          noticeNo: cells[0],
          category: cells[1],
          batchNo: cells[2],
          supplier: cells[3] || undefined,
          notifiedAt: cells[4] || undefined,
          reason: cells[5] || undefined,
        };
      });
  }

  if (!entries.length) throw new Error('没有可导入的通知条目');

  return entries.map((entry, index) => {
    const pos = `第 ${index + 1} 条`;
    if (!entry || typeof entry !== 'object') throw new Error(`${pos}：不是有效对象`);
    const e = entry as Record<string, unknown>;

    const noticeNo = String(e.noticeNo ?? e.id ?? '').trim();
    if (!noticeNo) throw new Error(`${pos}：缺少通知号 noticeNo`);

    const category = normalizeCategory(e.category ?? e.material ?? e.type);
    if (!category) {
      throw new Error(`${pos}：材料类别无效（应为 木料 / 生漆 / 琴弦）`);
    }

    const batchNo = String(e.batchNo ?? e.batch ?? '').trim();
    if (!batchNo) throw new Error(`${pos}：缺少批次号 batchNo`);

    let notifiedAt: string | undefined;
    if (e.notifiedAt !== undefined && e.notifiedAt !== '') {
      const d = new Date(String(e.notifiedAt));
      if (Number.isNaN(d.getTime())) throw new Error(`${pos}：通知日期无法识别（${String(e.notifiedAt)}）`);
      notifiedAt = d.toISOString();
    }

    return {
      noticeNo,
      category,
      batchNo,
      supplier: e.supplier ? String(e.supplier).trim() : undefined,
      notifiedAt,
      reason: e.reason ? String(e.reason).trim() : undefined,
    };
  });
}

/** 生成一份可下载/粘贴的示例通知文本 */
export const SAMPLE_NOTICE_TEXT = JSON.stringify(
  [
    {
      noticeNo: 'QC-LQ-2603-01',
      category: '生漆',
      batchNo: 'LQ-2510',
      supplier: '秦岭漆源',
      notifiedAt: new Date().toISOString().slice(0, 10),
      reason: '抽检含水率超标，判不能再用',
    },
  ],
  null,
  2,
);
