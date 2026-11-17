export const now = (): number => Date.now();

export function beijingParts(ts: number): { h: number; m: number; date: string } {
  const d = new Date(ts + 8 * 3600e3);
  return { h: d.getUTCHours(), m: d.getUTCMinutes(), date: d.toISOString().slice(0, 10) };
}

// 官方闲时：北京时间 00:30–08:30（以官方公告为准）
export function isOffPeak(ts: number = Date.now()): boolean {
  const { h, m } = beijingParts(ts);
  const t = h * 60 + m;
  return t >= 30 && t < 8 * 60 + 30;
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fmtRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  if (diff < 7 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`;
  return fmtDate(ts);
}