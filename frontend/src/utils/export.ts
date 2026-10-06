import { db, SCHEMA_VERSION } from './db';

export interface BackupPayload {
  app: string;
  schemaVersion: number;
  exportedAt: string;
  boards: unknown[];
  chambers: unknown[];
  lacquers: unknown[];
  stringings: unknown[];
  materialBatches: unknown[];
  qualityNotices: unknown[];
  materialReviews: unknown[];
  archives: unknown[];
}

/** 汇总全部本地表为 JSON 备份（schema 迁移前先导出） */
export async function buildBackup(): Promise<BackupPayload> {
  const [boards, chambers, lacquers, stringings, materialBatches, qualityNotices, materialReviews, archives] =
    await Promise.all([
      db.boards.toArray(),
      db.chambers.toArray(),
      db.lacquers.toArray(),
      db.stringings.toArray(),
      db.materialBatches.toArray(),
      db.qualityNotices.toArray(),
      db.materialReviews.toArray(),
      db.archives.toArray(),
    ]);
  return {
    app: 'gbguqin',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    boards,
    chambers,
    lacquers,
    stringings,
    materialBatches,
    qualityNotices,
    materialReviews,
    archives,
  };
}

export async function exportBackupJson(): Promise<string> {
  return JSON.stringify(await buildBackup(), null, 2);
}

export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** 导出 CSV（工序档案打印用） */
export function downloadCsv<T extends Record<string, unknown>>(
  filename: string,
  rows: T[],
  columns: Array<{ key: keyof T; title: string }>,
): void {
  const header = columns.map((c) => `"${c.title}"`).join(',');
  const body = rows
    .map((row) => columns.map((c) => `"${String(row[c.key] ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
  downloadText(filename, `﻿${header}\n${body}`, 'text/csv');
}

/** 恢复 JSON 备份（v3 起含批次台账 / 通知 / 复核单 / 归档；旧备份缺失这些表时按空恢复） */
export async function importBackup(text: string): Promise<{
  boards: number;
  chambers: number;
  lacquers: number;
  stringings: number;
  materialBatches: number;
  qualityNotices: number;
  materialReviews: number;
  archives: number;
}> {
  const payload = JSON.parse(text) as Partial<BackupPayload>;
  if (!payload || payload.app !== 'gbguqin') {
    throw new Error('备份文件格式不匹配（缺少 app=gbguqin 标记）');
  }
  const counts = {
    boards: payload.boards?.length ?? 0,
    chambers: payload.chambers?.length ?? 0,
    lacquers: payload.lacquers?.length ?? 0,
    stringings: payload.stringings?.length ?? 0,
    materialBatches: payload.materialBatches?.length ?? 0,
    qualityNotices: payload.qualityNotices?.length ?? 0,
    materialReviews: payload.materialReviews?.length ?? 0,
    archives: payload.archives?.length ?? 0,
  };
  await db.transaction(
    'rw',
    [
      db.boards,
      db.chambers,
      db.lacquers,
      db.stringings,
      db.materialBatches,
      db.qualityNotices,
      db.materialReviews,
      db.archives,
    ],
    async () => {
      await Promise.all([
        db.boards.clear(),
        db.chambers.clear(),
        db.lacquers.clear(),
        db.stringings.clear(),
        db.materialBatches.clear(),
        db.qualityNotices.clear(),
        db.materialReviews.clear(),
        db.archives.clear(),
      ]);
      if (payload.boards?.length) await db.boards.bulkPut(payload.boards as never[]);
      if (payload.chambers?.length) await db.chambers.bulkPut(payload.chambers as never[]);
      if (payload.lacquers?.length) await db.lacquers.bulkPut(payload.lacquers as never[]);
      if (payload.stringings?.length) await db.stringings.bulkPut(payload.stringings as never[]);
      if (payload.materialBatches?.length) await db.materialBatches.bulkPut(payload.materialBatches as never[]);
      if (payload.qualityNotices?.length) await db.qualityNotices.bulkPut(payload.qualityNotices as never[]);
      if (payload.materialReviews?.length) await db.materialReviews.bulkPut(payload.materialReviews as never[]);
      if (payload.archives?.length) await db.archives.bulkPut(payload.archives as never[]);
    },
  );
  return counts;
}
