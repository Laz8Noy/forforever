import type { Message, Thinking } from '../core/types.ts';
import { maxOutputFor } from '../core/types.ts';
import { estimateTokens } from '../core/tokens.ts';
import { chatFramework, characterBlock, memoryBlock, trimMemoryToBudget } from '../memory/prompts.ts';
import type { Character, MemoryEntry } from '../core/types.ts';

export interface BuiltContext {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  estTokens: number;
  droppedHistory: number;
  droppedMemory: number;
}

export function buildContext(opts: {
  char: Character;
  entries: MemoryEntry[];
  history: Message[];
  userText: string;
  budget: number;
  thinking: Thinking;
  calibration?: number;
}): BuiltContext {
  const cal = opts.calibration ?? 1;
  const est = (s: string) => estimateTokens(s, cal);
  const maxOutput = maxOutputFor(opts.thinking);

  const framework = chatFramework(opts.char.name);
  const charBlock = characterBlock(opts.char);
  const fixedBase = est(framework) + est(charBlock) + 24;

  // 记忆预算：总预算 - 输出预留 - 固定前缀 - 当前消息 - 历史最低保留
  const userCost = est(opts.userText) + 4;
  const memoryBudget = Math.max(0, opts.budget - maxOutput - fixedBase - userCost - 2048);
  const { kept, dropped: droppedMemory } = trimMemoryToBudget(opts.entries, memoryBudget, est);
  const memBlock = memoryBlock(kept);
  const prefixTokens = fixedBase + (memBlock ? est(memBlock) + 8 : 0);

  const available = Math.max(0, opts.budget - maxOutput - prefixTokens - userCost);

  // 历史从新到旧填，保持配对完整
  const picked: Message[] = [];
  let used = 0;
  let droppedHistory = 0;
  for (let i = opts.history.length - 1; i >= 0; i--) {
    const m = opts.history[i];
    if (m.error) continue;
    const cost = est(m.content) + 4;
    if (used + cost > available) {
      droppedHistory = i + 1;
      break;
    }
    picked.unshift(m);
    used += cost;
  }

  const messages: BuiltContext['messages'] = [
    { role: 'system', content: framework },
    { role: 'system', content: charBlock },
  ];
  if (memBlock) messages.push({ role: 'system', content: memBlock });
  for (const m of picked) messages.push({ role: m.role, content: m.content });
  messages.push({ role: 'user', content: opts.userText });

  return {
    messages,
    estTokens: prefixTokens + used + userCost,
    droppedHistory,
    droppedMemory,
  };
}