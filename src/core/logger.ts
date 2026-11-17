import { Context } from '@deepseek-ai/cordis';
import type { FF } from './fs.ts';

export interface LogEntry {
  ts: number;
  level: 'error' | 'warn' | 'info';
  tag: string;
  msg: string;
  meta?: Record<string, unknown>;
}

export interface DiagLogger {
  log(level: LogEntry['level'], tag: string, msg: unknown, meta?: Record<string, unknown>): Promise<void>;
  recent(n?: number): Promise<LogEntry[]>;
  trim(max?: number): Promise<void>;
  clear(): Promise<void>;
  path: string;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    diag: DiagLogger;
  }
}

const PATH = 'logs/app.jsonl';
const MAX_LINES = 500;

// 诊断日志：只记元数据（时间/级别/标签/消息/上下文 id），不记聊天内容与人设
export function createLogger(ffs: FF): DiagLogger {
  const logger: DiagLogger = {
    path: PATH,

    async log(level, tag, msg, meta) {
      const entry: LogEntry = {
        ts: Date.now(),
        level,
        tag,
        msg: String(msg instanceof Error ? msg.message : msg).slice(0, 500),
        ...(meta ? { meta } : {}),
      };
      await ffs.appendText(PATH, JSON.stringify(entry) + '\n').catch(() => {});
    },

    async recent(n = 200) {
      const text = (await ffs.readText(PATH).catch(() => null)) ?? '';
      const out: LogEntry[] = [];
      for (const line of text.split('\n').slice(-n)) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line) as LogEntry);
        } catch {
          /* 跳过损坏行 */
        }
      }
      return out;
    },

    async trim(max = MAX_LINES) {
      const text = await ffs.readText(PATH).catch(() => null);
      if (!text) return;
      const lines = text.split('\n').filter((l) => l.trim());
      if (lines.length > max) {
        await ffs.writeText(PATH, lines.slice(-max).join('\n') + '\n').catch(() => {});
      }
    },

    async clear() {
      await ffs.remove(PATH).catch(() => {});
    },
  };
  return logger;
}

export async function LoggerPlugin(ctx: Context): Promise<void> {
  const logger = createLogger(ctx.ffs);
  await logger.trim();
  ctx.provide('diag', logger);
}