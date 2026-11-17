import { Context } from '@deepseek-ai/cordis';
import { Capacitor } from '@capacitor/core';
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin';
import type { FF } from './fs.ts';
import { createFF } from './fs.ts';
import type {
  Character, CharState, MemoryEntry, Message, Session, Settings, Secrets, UsageLog, Thinking, ModelId,
} from './types.ts';
import { DEFAULT_SETTINGS } from './types.ts';
import { uid } from './ids.ts';
import { now } from './time.ts';
import { memoryBlock } from '../memory/prompts.ts';

export interface Store {
  settings: Settings;
  secrets: Secrets;
  characters: Map<string, Character>;
  sessions: Map<string, Session>;
  saveSettings(patch: Partial<Settings>): Promise<void>;
  setApiKey(key: string): Promise<void>;
  touchActive(): Promise<void>;
  saveCharacter(c: Character): Promise<void>;
  deleteCharacter(id: string): Promise<void>;
  createSession(charId: string, opts?: { title?: string; model?: ModelId; thinking?: Thinking; memoryTiers?: { user: boolean; character: boolean } }): Promise<Session>;
  saveSession(s: Session): Promise<void>;
  deleteSession(id: string): Promise<void>;
  messages(sessionId: string): Promise<Message[]>;
  appendMessage(sessionId: string, m: Message): Promise<void>;
  charState(charId: string): Promise<CharState>;
  saveCharState(charId: string, st: CharState): Promise<void>;
  memoryEntries(charId: string): Promise<MemoryEntry[]>;
  saveMemoryEntries(charId: string, entries: MemoryEntry[]): Promise<void>;
  diaryNames(charId: string): Promise<string[]>;
  readDiary(charId: string, name: string): Promise<string | null>;
  writeDiary(charId: string, name: string, text: string): Promise<void>;
  appendUsage(log: UsageLog): Promise<void>;
  saveAvatar(charId: string, blob: Blob): Promise<string>;
  saveBackground(blob: Blob): Promise<string>;
  imageUrl(path: string | null): Promise<string>;
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    ffs: FF;
    store: Store;
  }
}

export function FFPlugin(ctx: Context): Promise<void> {
  return createFF().then((ffs) => {
    ctx.provide('ffs', ffs);
  });
}

const emptyState = (): CharState => ({ lastCollectedAt: null, cursors: {}, diaryPending: [], lastRun: null });

const NATIVE = Capacitor.isNativePlatform();

// 安卓上 key 存系统 Keystore；secrets.json 仅作迁移来源与降级兜底
async function readSecrets(ffs: FF): Promise<Secrets> {
  const file = { apiKey: '', ...((await ffs.readJSON<Secrets>('secrets.json')) ?? {}) };
  if (!NATIVE) return file;
  try {
    const { value } = await SecureStoragePlugin.get({ key: 'apiKey' });
    if (value) return { apiKey: value };
  } catch {
    /* Keystore 不可用：降级文件 */
  }
  if (file.apiKey) {
    try {
      await SecureStoragePlugin.set({ key: 'apiKey', value: file.apiKey });
      await ffs.remove('secrets.json');
    } catch {
      /* 迁移失败保留文件兜底 */
    }
  }
  return file;
}

export async function StorePlugin(ctx: Context): Promise<void> {
  const ffs = ctx.ffs;

  const settings: Settings = { ...DEFAULT_SETTINGS, ...((await ffs.readJSON<Settings>('settings.json')) ?? {}) };
  const secrets: Secrets = await readSecrets(ffs);
  const characters = new Map<string, Character>();
  const sessions = new Map<string, Session>();
  const msgCache = new Map<string, Message[]>();

  for (const id of await ffs.list('characters')) {
    const c = await ffs.readJSON<Character>(`characters/${id}/character.json`);
    if (c) characters.set(id, c);
  }
  for (const id of await ffs.list('sessions')) {
    const s = await ffs.readJSON<Session>(`sessions/${id}/session.json`);
    if (s) {
      if (!s.memoryTiers) s.memoryTiers = { user: true, character: true };
      sessions.set(id, s);
    }
  }
  if (!(await ffs.exists('meta.json'))) {
    await ffs.writeJSON('meta.json', { schemaVersion: 1, createdAt: now() });
  }

  const store: Store = {
    settings,
    secrets,
    characters,
    sessions,

    async saveSettings(patch) {
      Object.assign(settings, patch);
      await ffs.writeJSON('settings.json', settings);
      ctx.emit('store/settings', settings);
    },

    async setApiKey(key) {
      secrets.apiKey = key.trim();
      if (NATIVE) {
        try {
          await SecureStoragePlugin.set({ key: 'apiKey', value: secrets.apiKey });
          await ffs.remove('secrets.json');
          return;
        } catch {
          /* 降级文件存储 */
        }
      }
      await ffs.writeJSON('secrets.json', secrets);
    },

    async touchActive() {
      settings.lastActiveAt = now();
      await ffs.writeJSON('settings.json', settings);
    },

    async saveCharacter(c) {
      c.updatedAt = now();
      characters.set(c.id, c);
      await ffs.writeJSON(`characters/${c.id}/character.json`, c);
      if (!(await ffs.exists(`characters/${c.id}/memory.json`))) {
        await ffs.writeJSON(`characters/${c.id}/memory.json`, []);
      }
      if (!(await ffs.exists(`characters/${c.id}/state.json`))) {
        await ffs.writeJSON(`characters/${c.id}/state.json`, emptyState());
      }
      ctx.emit('store/character', c);
    },

    async deleteCharacter(id) {
      characters.delete(id);
      for (const [sid, s] of [...sessions]) {
        if (s.charId === id) {
          sessions.delete(sid);
          msgCache.delete(sid);
          await ffs.remove(`sessions/${sid}`);
        }
      }
      await ffs.remove(`characters/${id}`);
      ctx.emit('store/character', null);
    },

    async createSession(charId, opts = {}) {
      const s: Session = {
        id: uid(),
        charId,
        title: opts.title ?? '新的对话',
        createdAt: now(),
        updatedAt: now(),
        lastActiveAt: now(),
        model: opts.model ?? settings.defaultModel,
        thinking: opts.thinking ?? { ...settings.defaultThinking },
        memoryTiers: opts.memoryTiers ?? { user: true, character: true },
      };
      sessions.set(s.id, s);
      await ffs.writeJSON(`sessions/${s.id}/session.json`, s);
      await ffs.writeText(`sessions/${s.id}/messages.jsonl`, '');
      ctx.emit('store/session', s);
      return s;
    },

    async saveSession(s) {
      s.updatedAt = now();
      sessions.set(s.id, s);
      await ffs.writeJSON(`sessions/${s.id}/session.json`, s);
      ctx.emit('store/session', s);
    },

    async deleteSession(id) {
      sessions.delete(id);
      msgCache.delete(id);
      await ffs.remove(`sessions/${id}`);
      ctx.emit('store/session', null);
    },

    async messages(sessionId) {
      const cached = msgCache.get(sessionId);
      if (cached) return cached;
      const text = (await ffs.readText(`sessions/${sessionId}/messages.jsonl`)) ?? '';
      const list: Message[] = [];
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          list.push(JSON.parse(line) as Message);
        } catch {
          /* 跳过损坏行 */
        }
      }
      msgCache.set(sessionId, list);
      return list;
    },

    async appendMessage(sessionId, m) {
      const list = await this.messages(sessionId);
      list.push(m);
      await ffs.appendText(`sessions/${sessionId}/messages.jsonl`, JSON.stringify(m) + '\n');
      const s = sessions.get(sessionId);
      if (s) {
        s.lastActiveAt = now();
        await ffs.writeJSON(`sessions/${sessionId}/session.json`, s);
      }
    },

    async charState(charId) {
      return (await ffs.readJSON<CharState>(`characters/${charId}/state.json`)) ?? emptyState();
    },

    async saveCharState(charId, st) {
      await ffs.writeJSON(`characters/${charId}/state.json`, st);
    },

    async memoryEntries(charId) {
      const list = (await ffs.readJSON<MemoryEntry[]>(`characters/${charId}/memory.json`)) ?? [];
      for (const e of list) if (!e.level) e.level = 'user';
      return list;
    },

    async saveMemoryEntries(charId, entries) {
      await ffs.writeJSON(`characters/${charId}/memory.json`, entries);
      const enabled = entries.filter((e) => e.enabled);
      const md = `# ${characters.get(charId)?.name ?? ''} 的长期记忆\n\n${memoryBlock(enabled)}\n`;
      await ffs.writeText(`characters/${charId}/memory.md`, md);
      ctx.emit('store/memory', charId);
    },

    async diaryNames(charId) {
      const names = await ffs.list(`characters/${charId}/diary`);
      return names.filter((n) => n.endsWith('.md')).sort().reverse();
    },

    async readDiary(charId, name) {
      return ffs.readText(`characters/${charId}/diary/${name}`);
    },

    async writeDiary(charId, name, text) {
      await ffs.writeText(`characters/${charId}/diary/${name}`, text);
      ctx.emit('store/diary', charId);
    },

    async appendUsage(log) {
      await ffs.appendText('logs/usage.jsonl', JSON.stringify(log) + '\n');
    },

    async saveAvatar(charId, blob) {
      const path = `characters/${charId}/avatar.jpg`;
      await ffs.writeBlob(path, blob);
      return path;
    },

    async saveBackground(blob) {
      const path = `assets/backgrounds/bg-${Date.now()}.jpg`;
      await ffs.writeBlob(path, blob);
      return path;
    },

    async imageUrl(path) {
      if (!path) return '';
      return ffs.getUrl(path);
    },
  };

  ctx.provide('store', store);
}