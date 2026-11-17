export type ModelId = 'deepseek-flash' | 'deepseek-v4-pro';
export type Effort = 'low' | 'high' | 'max';

export interface Thinking {
  type: 'enabled' | 'disabled';
  effort: Effort;
}

export interface Character {
  id: string;
  name: string;
  persona: string;
  avatar: string | null;
  greeting: string;
  createdAt: number;
  updatedAt: number;
}

export type MemoryType = 'fact' | 'event' | 'preference' | 'relationship' | 'emotion';
export type MemoryLevel = 'user' | 'character';

export interface MemoryEntry {
  id: string;
  level: MemoryLevel;
  type: MemoryType;
  content: string;
  importance: number;
  pinned: boolean;
  enabled: boolean;
  sourceSessionId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DiaryPending {
  runId: string;
  transcript: string;
  highlights: string;
  createdAt: number;
}

export interface CharState {
  lastCollectedAt: number | null;
  cursors: Record<string, string>;
  diaryPending: DiaryPending[];
  lastRun: { runId: string; status: 'ok' | 'failed' | 'running'; error?: string; at: number } | null;
}

export interface Session {
  id: string;
  charId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastActiveAt: number;
  model: ModelId;
  thinking: Thinking;
  memoryTiers: { user: boolean; character: boolean };
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string;
  ts: number;
  usage?: Usage;
  costEst?: number;
  error?: string;
}

export interface Settings {
  theme: 'light' | 'dark';
  backgroundPath: string | null;
  bgDim: number;
  tokenBudget: number;
  defaultModel: ModelId;
  defaultThinking: Thinking;
  collectThresholdHours: number;
  offPeakOnlyCollect: boolean;
  streamEnabled: boolean;
  lastActiveAt: number;
  calibration: number;
  onboarded: boolean;
}

export interface Secrets {
  apiKey: string;
}

export interface UsageLog {
  ts: number;
  model: ModelId;
  kind: 'chat' | 'memory' | 'diary' | 'test';
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  peak: boolean;
  costEst: number;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  backgroundPath: null,
  bgDim: 0.55,
  tokenBudget: 131072,
  defaultModel: 'deepseek-flash',
  defaultThinking: { type: 'disabled', effort: 'low' },
  collectThresholdHours: 3,
  offPeakOnlyCollect: false,
  streamEnabled: true,
  lastActiveAt: 0,
  calibration: 1,
  onboarded: false,
};

export const MAX_OUTPUT_BY_THINKING: Record<string, number> = {
  disabled: 8192,
  low: 16384,
  high: 32768,
  max: 65536,
};

export function maxOutputFor(t: Thinking): number {
  return t.type === 'disabled' ? MAX_OUTPUT_BY_THINKING.disabled : MAX_OUTPUT_BY_THINKING[t.effort];
}

export const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  fact: '事实',
  event: '事件',
  preference: '偏好',
  relationship: '关系',
  emotion: '情绪',
};

export const MEMORY_LEVEL_LABEL: Record<MemoryLevel, string> = {
  user: '用户记忆',
  character: '角色记忆',
};