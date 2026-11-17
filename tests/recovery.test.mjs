import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const params = {
  model: 'deepseek-flash', thinking: { type: 'disabled', effort: 'low' },
  messages: [{ role: 'user', content: '你好' }], maxTokens: 100,
};
const usage = { prompt_tokens: 10, completion_tokens: 5 };
const emptyOps = JSON.stringify({ add: [], update: [], delete: [] });
const completion = (content) => ({ content, reasoning: '', usage });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};
async function within(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('operation did not settle')), 1000);
    })]);
  } finally { clearTimeout(timer); }
}

// Only the platform transports are mocked. Load the real services through Vite so
// import.meta.env and TypeScript behave as in the app, without a device/API key.
async function services(t, native = true) {
  const listeners = new Map();
  const cancelled = [];
  let starts = 0;
  let posts = 0;
  const transport = {
    native,
    http: { async post() { posts++; return { status: 200, data: { choices: [{ message: { content: '完整回复' } }], usage } }; } },
    stream: {
      async addListener(event, callback) {
        const callbacks = listeners.get(event) ?? new Set();
        callbacks.add(callback);
        listeners.set(event, callbacks);
        return { async remove() { callbacks.delete(callback); } };
      },
      async startStream() { starts++; return { id: 'stream-1' }; },
      // capacitor-stream-http 0.2.2 emits no end/error after Android cancellation.
      async cancelStream({ id }) { cancelled.push(id); },
    },
    emit(event, data = {}) {
      for (const fn of listeners.get(event) ?? []) fn({ id: 'stream-1', ...data });
    },
    get listenerCount() { return [...listeners.values()].reduce((n, s) => n + s.size, 0); },
    get starts() { return starts; },
    get posts() { return posts; },
    cancelled,
  };
  globalThis.__ffRecoveryTest = transport;
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
    appType: 'custom', server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [], entries: [] },
    ssr: { noExternal: ['@capacitor/core', 'capacitor-stream-http'] },
    plugins: [{
      name: 'recovery-test-transports', enforce: 'pre',
      resolveId(id) {
        if (id === '@capacitor/core' || id === 'capacitor-stream-http') return '\0recovery:' + id;
      },
      load(id) {
        if (id === '\0recovery:@capacitor/core') return `
          export const Capacitor = { isNativePlatform: () => globalThis.__ffRecoveryTest.native };
          export const CapacitorHttp = { post: (...args) => globalThis.__ffRecoveryTest.http.post(...args) };`;
        if (id === '\0recovery:capacitor-stream-http') return 'export const StreamHttp = globalThis.__ffRecoveryTest.stream;';
      },
    }],
  });
  t.after(async () => { await server.close(); delete globalThis.__ffRecoveryTest; });
  const api = await server.ssrLoadModule('/src/api/deepseek.ts');
  const memory = await server.ssrLoadModule('/src/memory/collector.ts');
  return { ...api, ...memory, transport };
}

async function apiFixture(DeepSeekPlugin, streamEnabled = true) {
  const logs = [];
  const ctx = {
    store: {
      settings: { streamEnabled, calibration: 1 }, secrets: { apiKey: 'sk-offline-test' },
      async appendUsage(log) { logs.push(log); },
      async saveSettings(patch) { Object.assign(this.settings, patch); },
    },
    provide(name, value) { this[name] = value; },
    diag: { async log() {} },
  };
  await DeepSeekPlugin(ctx);
  return { api: ctx.deepseek, logs, store: ctx.store };
}

function memoryFixture(complete) {
  const fixed = Date.now() - 10000;
  let state = { lastCollectedAt: null, cursors: {}, diaryPending: [], lastRun: null };
  let entries = [];
  const messages = [{ id: 'm1', role: 'user', content: '我喜欢猫，周末会去公园散步。'.repeat(100), ts: fixed }];
  const diaries = new Map();
  const ctx = {
    store: {
      secrets: { apiKey: 'sk-offline-test' }, settings: {},
      characters: new Map([['c1', { id: 'c1', name: '小晚', persona: '温柔的插画师' }]]),
      sessions: new Map([['s1', { id: 's1', charId: 'c1' }]]),
      async charState() { return structuredClone(state); },
      async saveCharState(_, next) { state = structuredClone(next); },
      async messages() { return messages; },
      async memoryEntries() { return structuredClone(entries); },
      async saveMemoryEntries(_, next) { entries = structuredClone(next); },
      async diaryNames() { return [...diaries.keys()]; },
      async writeDiary(_, name, text) { diaries.set(name, text); },
    },
    deepseek: { complete }, emit() {}, provide(name, value) { this[name] = value; }, diag: { async log() {} },
  };
  return { ctx, messages, diaries, get state() { return state; }, get entries() { return entries; } };
}

const chunk = (delta) => 'data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\n';

test('记忆提炼与日记恢复', async (t) => {
  const { MemoryPlugin } = await services(t);
  const invalid = [
    ['截断 JSON', '{"add":['], ['null', 'null'], ['数组根节点', '[{"add":[],"update":[],"delete":[]}]'],
    ['缺少操作字段', '{}'], ['错误数组类型', '{"add":"bad","update":[],"delete":[]}'],
    ['无效条目', '{"add":[{"type":"fact","content":123}],"update":[],"delete":[]}'],
    ['未知记忆类型', '{"add":[{"type":"unknown","content":"test"}],"update":[],"delete":[]}'],
    ['无效 importance', '{"add":[{"type":"fact","content":"test","importance":"bad"}],"update":[],"delete":[]}'],
    ['无效更新', '{"add":[],"update":[{"content":"test"}],"delete":[]}'],
    ['无效删除', '{"add":[],"update":[],"delete":[null]}'],
  ];
  for (const [label, response] of invalid) await t.test(`${label} 不提交游标，修正响应后可以重试`, async () => {
    let malformed = true;
    let diaryCalls = 0;
    const f = memoryFixture(async (_, kind) => {
      if (kind === 'diary') { diaryCalls++; return completion('日记'); }
      return completion(malformed ? response : JSON.stringify({ add: [{ type: 'fact', content: '用户喜欢猫' }], update: [], delete: [] }));
    });
    await MemoryPlugin(f.ctx);
    await f.ctx.memory.collectCharacter('c1');
    assert.equal(f.state.lastRun.status, 'failed');
    assert.match(f.ctx.memory.status.lastError, /格式无效/);
    assert.deepEqual(f.state.cursors, {});
    assert.equal(f.state.lastCollectedAt, null);
    assert.equal(f.entries.length, 0);
    assert.equal(diaryCalls, 0);
    assert.equal(await f.ctx.memory.newMessagesCount('c1'), 1);
    malformed = false;
    await f.ctx.memory.collectCharacter('c1');
    assert.equal(f.state.lastRun.status, 'ok');
    assert.equal(f.state.cursors.s1, 'm1');
    assert.equal(f.entries[0].content, '用户喜欢猫');
    assert.equal(await f.ctx.memory.newMessagesCount('c1'), 0);
    assert.equal(diaryCalls, 1);
  });

  await t.test('合法空操作仍然推进游标并生成日记', async () => {
    const f = memoryFixture(async (_, kind) => completion(kind === 'memory' ? '```json\n' + emptyOps + '\n```' : '日记'));
    await MemoryPlugin(f.ctx);
    await f.ctx.memory.collectCharacter('c1');
    assert.equal(f.state.lastRun.status, 'ok');
    assert.equal(f.state.cursors.s1, 'm1');
    assert.equal(f.entries.length, 0);
    assert.equal(f.diaries.size, 1);
  });

  await t.test('同一分钟两次收集分别保存日记，旧格式日记仍保留', async (t) => {
    const fixed = Date.now();
    t.mock.method(Date, 'now', () => fixed);
    let calls = 0;
    const f = memoryFixture(async (_, kind) => completion(kind === 'memory' ? emptyOps : `日记-${++calls}`));
    f.diaries.set('2026-11-01T20-30.md', '旧日记');
    await MemoryPlugin(f.ctx);
    await f.ctx.memory.collectCharacter('c1');
    f.messages.push({ id: 'm2', role: 'user', content: '今天在公园看到了猫。'.repeat(100), ts: fixed + 1 });
    await f.ctx.memory.collectCharacter('c1');
    assert.equal(calls, 2);
    assert.equal(f.diaries.size, 3);
    assert.ok([...f.diaries.values()].some((text) => text.includes('日记-1')));
    assert.ok([...f.diaries.values()].some((text) => text.includes('日记-2')));
    assert.equal(f.diaries.get('2026-11-01T20-30.md'), '旧日记');
  });

  await t.test('补写队列重复执行同一 run 时不重复生成日记', async (t) => {
    let clock = Date.now();
    t.mock.method(Date, 'now', () => clock);
    let calls = 0;
    const f = memoryFixture(async (_, kind) => completion(kind === 'memory' ? emptyOps : `补写日记-${++calls}`));
    const pending = { runId: 'retry-run', transcript: '之前的对话', highlights: '', createdAt: clock - 60000 };
    const initial = { lastCollectedAt: clock, cursors: { s1: 'm1' }, diaryPending: [pending], lastRun: null };
    await f.ctx.store.saveCharState('c1', initial);
    await MemoryPlugin(f.ctx);
    await f.ctx.memory.collectCharacter('c1');
    assert.equal(calls, 1);
    assert.equal(f.state.diaryPending.length, 0);
    // Simulate the file being written, but clearing the pending state not surviving a crash.
    await f.ctx.store.saveCharState('c1', initial);
    clock += 120000;
    await f.ctx.memory.collectCharacter('c1');
    assert.equal(calls, 1);
    assert.equal(f.diaries.size, 1);
    assert.equal(f.state.diaryPending.length, 0);
  });
});

test('Android 流式恢复', async (t) => {
  const { DeepSeekPlugin, transport } = await services(t);
  await t.test('取消后无需插件发送 end，立即结束并移除监听器', async () => {
    const { api } = await apiFixture(DeepSeekPlugin);
    let content = '';
    const handle = api.stream(params, { onContent: (s) => { content += s; } });
    await tick();
    assert.equal(transport.listenerCount, 4);
    transport.emit('chunk', { chunk: chunk({ content: '部分回复' }) });
    handle.cancel();
    handle.cancel();
    await within(handle.done);
    assert.equal(transport.listenerCount, 0);
    assert.ok(transport.cancelled.includes('stream-1'));
    transport.emit('chunk', { chunk: chunk({ content: '迟到的内容' }) });
    assert.equal(content, '部分回复');
  });

  await t.test('注册监听器期间取消，不发起请求且清理迟到的监听器', async (t) => {
    const { api } = await apiFixture(DeepSeekPlugin);
    const gate = deferred();
    const add = transport.stream.addListener;
    t.mock.method(transport.stream, 'addListener', async (...args) => { await gate.promise; return add(...args); });
    const starts = transport.starts;
    const handle = api.stream(params, { onContent() {} });
    handle.cancel();
    await within(handle.done);
    gate.resolve();
    await tick();
    assert.equal(transport.starts, starts);
    assert.equal(transport.listenerCount, 0);
  });

  await t.test('等待原生 stream id 时取消，id 返回后立即取消底层请求', async (t) => {
    const { api } = await apiFixture(DeepSeekPlugin);
    const gate = deferred();
    t.mock.method(transport.stream, 'startStream', () => gate.promise);
    const handle = api.stream(params, { onContent() {} });
    await tick();
    handle.cancel();
    await within(handle.done);
    gate.resolve({ id: 'late-stream' });
    await tick();
    assert.ok(transport.cancelled.includes('late-stream'));
    assert.equal(transport.listenerCount, 0);
  });

  await t.test('正常回复分发正文和用量，清理监听器', async () => {
    const { api, logs } = await apiFixture(DeepSeekPlugin);
    let content = '';
    let actual;
    const handle = api.stream(params, { onContent: (s) => { content += s; }, onUsage: (u) => { actual = u; } });
    await tick();
    transport.emit('chunk', { id: 'unrelated', chunk: chunk({ content: '无关' }) });
    transport.emit('chunk', { chunk: chunk({ content: '你好' }) + 'data: ' + JSON.stringify({ choices: [], usage }) + '\n\n' });
    transport.emit('end');
    await within(handle.done);
    assert.equal(content, '你好');
    assert.deepEqual(actual, usage);
    assert.equal(logs.length, 1);
    assert.equal(transport.listenerCount, 0);
  });

  await t.test('原生流式请求启用 usage，末尾用量帧用于日志和校准', async (t) => {
    let body;
    t.mock.method(transport.stream, 'startStream', async (options) => {
      body = JSON.parse(options.body);
      return { id: 'stream-1' };
    });
    const { api, logs, store } = await apiFixture(DeepSeekPlugin);
    const actualUsage = { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 200 };
    let receivedUsage;
    let content = '';
    const handle = api.stream({ ...params, estPromptTokens: 500 }, {
      onContent: (text) => { content += text; }, onUsage: (value) => { receivedUsage = value; },
    });
    await tick();
    transport.emit('chunk', { chunk: chunk({ content: '你好' }) +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' });
    transport.emit('chunk', { chunk: 'data: ' + JSON.stringify({ choices: [], usage: actualUsage }) + '\n\ndata: [DONE]\n\n' });
    transport.emit('end');
    await within(handle.done);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(body.stream, true);
    assert.equal(content, '你好');
    assert.deepEqual(receivedUsage, actualUsage);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].promptTokens, 1000);
    assert.equal(logs[0].completionTokens, 50);
    assert.equal(logs[0].cacheHitTokens, 200);
    assert.ok(Math.abs(store.settings.calibration - 1.2) < 1e-9);
  });

  await t.test('非流式请求不携带 stream_options', async (t) => {
    let body;
    t.mock.method(transport.http, 'post', async (options) => {
      body = options.data;
      return { status: 200, data: { choices: [{ message: { content: '完整回复' } }], usage } };
    });
    const { api } = await apiFixture(DeepSeekPlugin, false);
    await within(api.stream(params, { onContent() {} }).done);
    assert.equal(body.stream, false);
    assert.equal(Object.hasOwn(body, 'stream_options'), false);
  });

  for (const field of ['content', 'reasoning_content']) await t.test(`已有 ${field} 时中断不重发请求`, async () => {
    const { api } = await apiFixture(DeepSeekPlugin);
    const posts = transport.posts;
    const received = [];
    const handle = api.stream(params, { onContent: (s) => received.push(s), onReasoning: (s) => received.push(s) });
    await tick();
    transport.emit('chunk', { chunk: chunk({ [field]: '部分内容' }) });
    transport.emit('error', { error: '连接中断' });
    await assert.rejects(within(handle.done), /连接中断/);
    assert.deepEqual(received, ['部分内容']);
    assert.equal(transport.posts, posts);
    assert.equal(transport.listenerCount, 0);
  });

  await t.test('尚无输出时仍可降级为非流式回复', async () => {
    const { api } = await apiFixture(DeepSeekPlugin);
    const posts = transport.posts;
    let content = '';
    const handle = api.stream(params, { onContent: (s) => { content += s; } });
    await tick();
    transport.emit('error', { error: '插件不可用' });
    await within(handle.done);
    assert.equal(content, '完整回复');
    assert.equal(transport.posts, posts + 1);
    assert.equal(transport.listenerCount, 0);
  });

  await t.test('401 不降级或重复调用 API', async () => {
    const { api } = await apiFixture(DeepSeekPlugin);
    const posts = transport.posts;
    const handle = api.stream(params, { onContent() {} });
    await tick();
    transport.emit('response', { status: 401 });
    transport.emit('end');
    await assert.rejects(within(handle.done), /API key/);
    assert.equal(transport.posts, posts);
  });

  await t.test('非流式请求尚未返回时取消，也会结束等待并屏蔽迟到的输出', async (t) => {
    const { api } = await apiFixture(DeepSeekPlugin, false);
    const gate = deferred();
    t.mock.method(transport.http, 'post', () => gate.promise);
    const received = [];
    const handle = api.stream(params, { onContent: (s) => received.push(s), onUsage: (u) => received.push(u) });
    handle.cancel();
    await within(handle.done);
    gate.resolve({ status: 200, data: { choices: [{ message: { content: '迟到的回复' } }], usage } });
    await tick();
    assert.deepEqual(received, []);
  });
});

test('Web 流式中断恢复', async (t) => {
  const { DeepSeekPlugin } = await services(t, false);
  await t.test('Web 流式请求启用 usage 并接收 finish_reason 后的用量帧', async (t) => {
    let body;
    const actualUsage = { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 200 };
    t.mock.method(globalThis, 'fetch', async (_, options) => {
      body = JSON.parse(options.body);
      const frames = chunk({ content: '你好' }) +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: ' + JSON.stringify({ choices: [], usage: actualUsage }) + '\n\ndata: [DONE]\n\n';
      return new Response(frames, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    });
    const { api, logs, store } = await apiFixture(DeepSeekPlugin);
    let receivedUsage;
    let content = '';
    await within(api.stream({ ...params, estPromptTokens: 500 }, {
      onContent: (text) => { content += text; }, onUsage: (value) => { receivedUsage = value; },
    }).done);
    assert.deepEqual(body.stream_options, { include_usage: true });
    assert.equal(body.stream, true);
    assert.equal(content, '你好');
    assert.deepEqual(receivedUsage, actualUsage);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].promptTokens, 1000);
    assert.equal(logs[0].completionTokens, 50);
    assert.equal(logs[0].cacheHitTokens, 200);
    assert.ok(Math.abs(store.settings.calibration - 1.2) < 1e-9);
  });

  for (const field of ['content', 'reasoning_content']) await t.test(`已有 ${field} 时断网只发一次请求`, async (t) => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      requests++;
      let reads = 0;
      return { ok: true, body: { getReader: () => ({
        async read() {
          if (reads++ === 0) return { done: false, value: new TextEncoder().encode(chunk({ [field]: '部分内容' })) };
          throw new Error('connection reset');
        },
      }) } };
    });
    const { api } = await apiFixture(DeepSeekPlugin);
    const received = [];
    const handle = api.stream(params, { onContent: (s) => received.push(s), onReasoning: (s) => received.push(s) });
    await assert.rejects(within(handle.done), /connection reset/);
    assert.equal(requests, 1);
    assert.deepEqual(received, ['部分内容']);
  });

  await t.test('尚无内容时 Web 流式失败仍可降级', async (t) => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      if (++requests === 1) throw new Error('stream unsupported');
      return { status: 200, json: async () => ({ choices: [{ message: { content: '完整回复' } }], usage }) };
    });
    const { api } = await apiFixture(DeepSeekPlugin);
    let content = '';
    await within(api.stream(params, { onContent: (s) => { content += s; } }).done);
    assert.equal(requests, 2);
    assert.equal(content, '完整回复');
  });
});
