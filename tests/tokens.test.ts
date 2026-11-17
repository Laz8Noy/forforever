import { test } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, estimateMessagesTokens } from '../src/core/tokens.ts';

test('中文估算：4 个汉字 ≈ 3 tokens', () => {
  assert.equal(estimateTokens('你好世界'), Math.ceil(4 * 0.6 * 1.1));
});

test('英文估算更便宜', () => {
  assert.equal(estimateTokens('hello'), Math.ceil(5 * 0.3 * 1.1));
  assert.ok(estimateTokens('hellohel') < estimateTokens('你好世界你好世界'));
});

test('校准系数生效', () => {
  assert.equal(estimateTokens('你好世界', 2), Math.ceil(4 * 0.6 * 1.1 * 2));
});

test('消息附加开销', () => {
  const t = estimateMessagesTokens([{ content: '你好' }, { content: '世界' }]);
  assert.equal(t, estimateTokens('你好') + 4 + estimateTokens('世界') + 4);
});