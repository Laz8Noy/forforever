import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildContext } from '../src/chat/context.ts';
import type { Character, MemoryEntry, Message } from '../src/core/types.ts';

const char: Character = {
  id: 'c1', name: '小晚', persona: '温柔插画师', avatar: null, greeting: '', createdAt: 0, updatedAt: 0,
};

const entry = (id: string, content: string, importance = 3, pinned = false): MemoryEntry => ({
  id, level: 'user', type: 'fact', content, importance, pinned, enabled: true, sourceSessionId: null, createdAt: 0, updatedAt: 0,
});

const msg = (role: 'user' | 'assistant', content: string): Message => ({
  id: Math.random().toString(36), role, content, ts: 0,
});

test('人设永不裁剪，历史从新到旧保留', () => {
  const history = Array.from({ length: 50 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `第${i}条消息内容`.repeat(10)));
  const built = buildContext({
    char, entries: [], history, userText: '最新问题', budget: 2000, thinking: { type: 'disabled', effort: 'low' },
  });
  assert.ok(built.messages[0].content.includes('小晚'));
  assert.ok(built.messages.some((m) => m.content.includes('温柔插画师')));
  assert.equal(built.messages[built.messages.length - 1].content, '最新问题');
  assert.ok(built.droppedHistory > 0);
  assert.ok(built.estTokens <= 2000);
});

test('预算充足时历史全保留', () => {
  const history = [msg('user', '早'), msg('assistant', '早安')];
  const built = buildContext({
    char, entries: [entry('e1', '用户喜欢猫')], history, userText: '在干嘛', budget: 131072, thinking: { type: 'disabled', effort: 'low' },
  });
  assert.equal(built.droppedHistory, 0);
  assert.equal(built.droppedMemory, 0);
  assert.ok(built.messages.some((m) => m.content.includes('用户喜欢猫')));
});

test('记忆超预算按重要度裁剪，pinned 保留', () => {
  const entries = [
    entry('low', '低重要度'.repeat(30), 1),
    entry('pin', '置顶记忆'.repeat(30), 1, true),
    entry('high', '高重要度'.repeat(30), 5),
  ];
  const built = buildContext({
    char, entries, history: [], userText: 'hi', budget: 1500, thinking: { type: 'disabled', effort: 'low' },
  });
  const memMsg = built.messages.find((m) => m.content.includes('【长期记忆】'));
  assert.ok(memMsg);
  assert.ok(memMsg!.content.includes('置顶记忆'));
  assert.ok(built.droppedMemory >= 1);
});

test('思考强度越大输出预留越多', () => {
  const history = Array.from({ length: 200 }, (_, i) => msg('user', '长消息'.repeat(50)));
  const off = buildContext({ char, entries: [], history, userText: 'q', budget: 20000, thinking: { type: 'disabled', effort: 'low' } });
  const max = buildContext({ char, entries: [], history, userText: 'q', budget: 20000, thinking: { type: 'enabled', effort: 'max' } });
  assert.ok(max.droppedHistory > off.droppedHistory);
});