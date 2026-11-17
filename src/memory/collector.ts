import { Context } from '@deepseek-ai/cordis';
import type { CharState, MemoryEntry, MemoryLevel, MemoryType, Message } from '../core/types.ts';
import { uid } from '../core/ids.ts';
import { now, beijingParts, isOffPeak } from '../core/time.ts';
import { estimateTokens } from '../core/tokens.ts';
import { ApiError } from '../api/deepseek.ts';
import type { DeepSeek } from '../api/deepseek.ts';
import type { Store } from '../core/store.ts';
import { extractionSystem, diarySystem, diaryUserPrompt, buildTranscript } from './prompts.ts';

export interface MemoryStatus {
  running: boolean;
  current: string | null;
  lastError: string | null;
  lastOkAt: number | null;
}

export interface MemorySvc {
  status: MemoryStatus;
  maybeAutoCollect(): Promise<void>;
  collectAll(): Promise<void>;
  collectCharacter(charId: string): Promise<void>;
  addEntry(charId: string, e: { level?: MemoryLevel; type: MemoryType; content: string; importance?: number }): Promise<MemoryEntry>;
  updateEntry(charId: string, id: string, patch: Partial<MemoryEntry>): Promise<void>;
  deleteEntry(charId: string, id: string): Promise<void>;
  newMessagesCount(charId: string): Promise<number>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemorySvc;
  }
}

const MIN_COLLECT_TOKENS = 200;

interface Ops {
  add?: { level?: string; type: MemoryType; content: string; importance?: number }[];
  update?: { id: string; content?: string; importance?: number }[];
  delete?: string[];
}

function parseOps(text: string): Ops {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  const j = JSON.parse(t);
  return {
    add: Array.isArray(j.add) ? j.add : [],
    update: Array.isArray(j.update) ? j.update : [],
    delete: Array.isArray(j.delete) ? j.delete : [],
  };
}

const VALID_TYPES: MemoryType[] = ['fact', 'event', 'preference', 'relationship', 'emotion'];

export async function MemoryPlugin(ctx: Context): Promise<void> {
  const store: Store = ctx.store;
  const ds: DeepSeek = ctx.deepseek;

  const status: MemoryStatus = { running: false, current: null, lastError: null, lastOkAt: null };
  const emit = () => ctx.emit('memory/status', status);

  async function gatherNew(charId: string, state: CharState): Promise<{ transcript: string; count: number; lastIds: Record<string, string>; since: number }> {
    const char = store.characters.get(charId)!;
    const parts: string[] = [];
    const lastIds: Record<string, string> = {};
    let count = 0;
    let since = state.lastCollectedAt ?? 0;
    for (const s of store.sessions.values()) {
      if (s.charId !== charId) continue;
      const msgs = await store.messages(s.id);
      if (!msgs.length) continue;
      const cursor = state.cursors[s.id];
      let startIdx = 0;
      if (cursor) {
        const idx = msgs.findIndex((m) => m.id === cursor);
        startIdx = idx >= 0 ? idx + 1 : msgs.findIndex((m) => m.ts > since);
        if (startIdx < 0) startIdx = msgs.length;
      } else if (since > 0) {
        startIdx = msgs.findIndex((m) => m.ts > since);
        if (startIdx < 0) startIdx = msgs.length;
      }
      const fresh = msgs.slice(startIdx).filter((m) => !m.error);
      if (!fresh.length) continue;
      parts.push(buildTranscript(fresh, char.name));
      lastIds[s.id] = fresh[fresh.length - 1].id;
      count += fresh.length;
      since = Math.min(since || fresh[0].ts, fresh[0].ts);
    }
    return { transcript: parts.join('\n\n'), count, lastIds, since: since || now() };
  }

  async function writeDiaryEntry(charId: string, transcript: string, highlights: string, since: number, runId: string): Promise<void> {
    const char = store.characters.get(charId)!;
    const r = await ds.complete(
      {
        model: 'deepseek-flash',
        thinking: { type: 'disabled', effort: 'low' },
        messages: [
          { role: 'system', content: diarySystem(char) },
          { role: 'user', content: diaryUserPrompt(transcript, highlights, since) },
        ],
        maxTokens: 2048,
      },
      'diary',
    );
    const { date, h, m } = beijingParts(now());
    const name = `${date}T${String(h).padStart(2, '0')}-${String(m).padStart(2, '0')}.md`;
    const body = `---\ndate: ${date} ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}\ncharId: ${charId}\nrunId: ${runId}\n---\n\n${r.content.trim()}\n`;
    await store.writeDiary(charId, name, body);
  }

  async function collectCharacter(charId: string): Promise<void> {
    const char = store.characters.get(charId);
    if (!char) return;
    if (!store.secrets.apiKey) return;
    const state = await store.charState(charId);
    const runId = uid();
    state.lastRun = { runId, status: 'running', at: now() };
    await store.saveCharState(charId, state);
    status.current = char.name;
    emit();

    try {
      // 先补写上次失败的日记
      for (const pending of [...state.diaryPending]) {
        try {
          await writeDiaryEntry(charId, pending.transcript, pending.highlights, pending.createdAt, pending.runId);
          state.diaryPending = state.diaryPending.filter((p) => p.runId !== pending.runId);
          await store.saveCharState(charId, state);
        } catch (e) {
          if (e instanceof ApiError && !e.retryable) {
            state.diaryPending = state.diaryPending.filter((p) => p.runId !== pending.runId);
            await store.saveCharState(charId, state);
          }
          break;
        }
      }

      const { transcript, count, lastIds, since } = await gatherNew(charId, state);
      if (!count || estimateTokens(transcript) < MIN_COLLECT_TOKENS) {
        state.lastRun = { runId, status: 'ok', at: now() };
        await store.saveCharState(charId, state);
        return;
      }

      // 阶段1：记忆提炼（成功即提交并推进游标）
      const entries = await store.memoryEntries(charId);
      const r = await ds.complete(
        {
          model: 'deepseek-flash',
          thinking: { type: 'disabled', effort: 'low' },
          messages: [
            { role: 'system', content: extractionSystem(char, entries) },
            { role: 'user', content: `【新增对话】\n${transcript}` },
          ],
          maxTokens: 4096,
          responseFormat: 'json_object',
        },
        'memory',
      );
      let ops: Ops = { add: [], update: [], delete: [] };
      try {
        ops = parseOps(r.content);
      } catch {
        /* 解析失败视为空操作，不污染记忆 */
      }
      const highlights: string[] = [];
      const next = [...entries];
      for (const a of ops.add ?? []) {
        if (!a.content || !VALID_TYPES.includes(a.type)) continue;
        if (next.some((e) => e.content === a.content)) continue;
        next.push({
          id: uid(),
          level: a.level === 'character' ? 'character' : 'user',
          type: a.type,
          content: String(a.content).slice(0, 200),
          importance: Math.min(5, Math.max(1, Math.round(a.importance ?? 3))),
          pinned: false,
          enabled: true,
          sourceSessionId: null,
          createdAt: now(),
          updatedAt: now(),
        });
        highlights.push(a.content);
      }
      for (const u of ops.update ?? []) {
        const e = next.find((x) => x.id === u.id);
        if (!e) continue;
        if (u.content) e.content = String(u.content).slice(0, 200);
        if (u.importance) e.importance = Math.min(5, Math.max(1, Math.round(u.importance)));
        e.updatedAt = now();
        highlights.push(e.content);
      }
      const delSet = new Set(ops.delete ?? []);
      const finalEntries = next.filter((e) => !delSet.has(e.id));
      await store.saveMemoryEntries(charId, finalEntries);
      Object.assign(state.cursors, lastIds);
      state.lastCollectedAt = now();
      await store.saveCharState(charId, state);

      // 阶段2：日记（失败进补写队列，不回滚记忆）
      try {
        await writeDiaryEntry(charId, transcript, highlights.join('\n'), since, runId);
      } catch (e) {
        if (!(e instanceof ApiError) || e.retryable) {
          state.diaryPending.push({ runId, transcript, highlights: highlights.join('\n'), createdAt: since });
          await store.saveCharState(charId, state);
        }
      }

      state.lastRun = { runId, status: 'ok', at: now() };
      await store.saveCharState(charId, state);
      status.lastOkAt = now();
      status.lastError = null;
    } catch (e) {
      state.lastRun = { runId, status: 'failed', error: e instanceof Error ? e.message : String(e), at: now() };
      await store.saveCharState(charId, state).catch(() => {});
      status.lastError = `${char.name}：${state.lastRun.error}`;
    } finally {
      status.current = null;
      emit();
    }
  }

  async function collectAll(): Promise<void> {
    if (status.running) return;
    if (!store.secrets.apiKey) return;
    status.running = true;
    status.lastError = null;
    emit();
    try {
      for (const charId of store.characters.keys()) {
        await collectCharacter(charId);
      }
    } finally {
      status.running = false;
      emit();
    }
  }

  const memory: MemorySvc = {
    status,

    async maybeAutoCollect() {
      const { lastActiveAt, collectThresholdHours, offPeakOnlyCollect } = store.settings;
      if (!lastActiveAt) return;
      const away = now() - lastActiveAt;
      if (away < collectThresholdHours * 3600e3) return;
      if (offPeakOnlyCollect && !isOffPeak()) {
        ctx.emit('memory/deferred', '当前为高峰时段，记忆收集将等到闲时（00:30–08:30）');
        return;
      }
      await collectAll();
    },

    collectAll,
    collectCharacter: async (charId) => {
      if (status.running) return;
      status.running = true;
      emit();
      try {
        await collectCharacter(charId);
      } finally {
        status.running = false;
        emit();
      }
    },

    async addEntry(charId, e) {
      const entries = await store.memoryEntries(charId);
      const entry: MemoryEntry = {
        id: uid(),
        level: e.level ?? 'user',
        type: e.type,
        content: e.content,
        importance: e.importance ?? 3,
        pinned: false,
        enabled: true,
        sourceSessionId: null,
        createdAt: now(),
        updatedAt: now(),
      };
      entries.push(entry);
      await store.saveMemoryEntries(charId, entries);
      return entry;
    },

    async updateEntry(charId, id, patch) {
      const entries = await store.memoryEntries(charId);
      const e = entries.find((x) => x.id === id);
      if (!e) return;
      Object.assign(e, patch, { updatedAt: now() });
      await store.saveMemoryEntries(charId, entries);
    },

    async deleteEntry(charId, id) {
      const entries = await store.memoryEntries(charId);
      await store.saveMemoryEntries(charId, entries.filter((e) => e.id !== id));
    },

    async newMessagesCount(charId) {
      const state = await store.charState(charId);
      const { count } = await gatherNew(charId, state);
      return count;
    },
  };

  ctx.provide('memory', memory);
}