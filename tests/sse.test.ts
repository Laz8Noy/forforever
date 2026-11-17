import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SSEParser, parseDelta } from '../src/api/sse.ts';

test('跨 chunk 截断的事件能正确拼接', () => {
  const p = new SSEParser();
  assert.deepEqual(p.push('data: {"choices":[{"delta":{"content":"你"}}]}\n'), []);
  const out = p.push('\ndata: {"choices":[{"delta":{"content":"好"}}]}\n\n');
  assert.equal(out.length, 2);
  assert.equal(parseDelta(out[0])!.content, '你');
  assert.equal(parseDelta(out[1])!.content, '好');
});

test('一个 chunk 含多个事件', () => {
  const p = new SSEParser();
  const out = p.push('data: a\n\ndata: b\n\n');
  assert.deepEqual(out, ['a', 'b']);
});

test('CRLF 兼容', () => {
  const p = new SSEParser();
  assert.deepEqual(p.push('data: x\r\n\r\n'), ['x']);
});

test('reasoning_content 分流', () => {
  const d = parseDelta('{"choices":[{"delta":{"reasoning_content":"思考","content":"正文"}}]}')!;
  assert.equal(d.reasoning, '思考');
  assert.equal(d.content, '正文');
  assert.equal(d.done, false);
});

test('[DONE] 与 finish_reason', () => {
  assert.equal(parseDelta('[DONE]')!.done, true);
  assert.equal(parseDelta('{"choices":[{"finish_reason":"stop","delta":{}}]}')!.done, true);
});

test('usage 与错误帧', () => {
  const d = parseDelta('{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}')!;
  assert.equal(d.usage!.prompt_tokens, 10);
  const e = parseDelta('{"error":{"message":"审核失败"}}')!;
  assert.equal(e.error, '审核失败');
  assert.equal(e.done, true);
});

test('非法 JSON 不崩溃', () => {
  assert.equal(parseDelta('{broken'), null);
});