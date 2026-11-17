import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// 假 Filesystem：内存 map 模拟安卓私有目录，可注入 IO 错误与崩溃窗口
function fakeFs() {
  const files = new Map();
  const dirs = new Set(['ffdata']);
  const api = {
    files,
    dirs,
    failRead: null,
    async mkdir({ path }) {
      const parts = path.split('/');
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    },
    async readFile({ path }) {
      if (api.failRead && path.startsWith(api.failRead)) throw new Error('EIO: disk read failure');
      if (!files.has(path)) throw new Error('File does not exist');
      return { data: files.get(path) };
    },
    async writeFile({ path, data }) {
      files.set(path, data);
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    },
    async appendFile({ path, data }) {
      files.set(path, (files.get(path) ?? '') + data);
    },
    async deleteFile({ path }) {
      if (!files.has(path)) throw new Error('File does not exist');
      files.delete(path);
    },
    async rename({ from, to }) {
      if (!files.has(from)) throw new Error('File does not exist');
      files.set(to, files.get(from));
      files.delete(from);
    },
    async stat({ path }) {
      if (files.has(path)) return { type: 'file' };
      if (dirs.has(path)) return { type: 'directory' };
      throw new Error('File does not exist');
    },
    async readdir({ path }) {
      const prefix = path.replace(/\/$/, '') + '/';
      const names = new Map();
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        const seg = rest.split('/')[0];
        if (seg) names.set(seg, rest.includes('/') ? 'directory' : 'file');
      }
      for (const d of dirs) {
        if (!d.startsWith(prefix)) continue;
        const seg = d.slice(prefix.length).split('/')[0];
        if (seg) names.set(seg, 'directory');
      }
      return { files: [...names].map(([name, type]) => ({ name, type })) };
    },
    async rmdir({ path }) {
      for (const k of [...files.keys()]) if (k === path || k.startsWith(path + '/')) files.delete(k);
      for (const d of [...dirs]) if (d === path || d.startsWith(path + '/')) dirs.delete(d);
    },
    async getUri({ path }) {
      return { uri: 'file:///data/' + path };
    },
  };
  return api;
}

async function loadFs(t) {
  const fake = fakeFs();
  globalThis.__ffStorageTest = fake;
  const server = await createServer({
    root: fileURLToPath(new URL('../', import.meta.url)), configFile: false,
    appType: 'custom', server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true, include: [], entries: [] },
    ssr: { noExternal: ['@capacitor/core', '@capacitor/filesystem'] },
    plugins: [{
      name: 'storage-test-fs', enforce: 'pre',
      resolveId(id) {
        if (id === '@capacitor/core' || id === '@capacitor/filesystem') return '\0storage:' + id;
      },
      load(id) {
        if (id === '\0storage:@capacitor/core') return `
          export const Capacitor = { isNativePlatform: () => true, convertFileSrc: (u) => u };`;
        if (id === '\0storage:@capacitor/filesystem') return `
          export const Directory = { Data: 'DATA' };
          export const Encoding = { UTF8: 'utf8' };
          export const Filesystem = globalThis.__ffStorageTest;`;
      },
    }],
  });
  t.after(async () => { await server.close(); delete globalThis.__ffStorageTest; });
  const mod = await server.ssrLoadModule('/src/core/fs.ts');
  const loggerMod = await server.ssrLoadModule('/src/core/logger.ts');
  const ff = await mod.createFF();
  return { ff, fake, createLogger: loggerMod.createLogger };
}

test('存储层鲁棒性', async (t) => {
  await t.test('原子写正常路径不留 .tmp', async () => {
    const { ff, fake } = await loadFs(t);
    await ff.writeText('a.json', '{"v":1}');
    assert.equal(await ff.readText('a.json'), '{"v":1}');
    assert.ok(!fake.files.has('ffdata/a.json.tmp'));
  });

  await t.test('崩溃窗口：原文件缺失 + 完整 .tmp → 读取时提升', async () => {
    const { ff, fake } = await loadFs(t);
    await ff.writeText('a.json', '{"v":1}');
    fake.files.set('ffdata/a.json.tmp', '{"v":2}');
    fake.files.delete('ffdata/a.json');
    assert.equal(await ff.readText('a.json'), '{"v":2}');
    assert.ok(!fake.files.has('ffdata/a.json.tmp'));
  });

  await t.test('启动恢复：孤儿 .tmp 被提升', async () => {
    const { ff, fake } = await loadFs(t);
    fake.files.set('ffdata/b.json.tmp', '{"ok":true}');
    await ff.init();
    assert.equal(await ff.readText('b.json'), '{"ok":true}');
  });

  await t.test('半截 JSON 的 .tmp 不提升', async () => {
    const { ff, fake } = await loadFs(t);
    fake.files.set('ffdata/c.json.tmp', '{"broken":');
    assert.equal(await ff.readText('c.json'), null);
    assert.ok(!fake.files.has('ffdata/c.json.tmp'));
  });

  await t.test('原文件存在时丢弃 .tmp（保守保留已提交状态）', async () => {
    const { ff, fake } = await loadFs(t);
    await ff.writeText('d.json', '{"v":1}');
    fake.files.set('ffdata/d.json.tmp', '{"v":2}');
    await ff.init();
    assert.equal(await ff.readText('d.json'), '{"v":1}');
    assert.ok(!fake.files.has('ffdata/d.json.tmp'));
  });

  await t.test('真 IO 错误抛错而非当空文件；appendFile 不读旧内容故不受读错误影响、不覆盖', async () => {
    const { ff, fake } = await loadFs(t);
    await ff.writeText('e.jsonl', '{"i":0}\n');
    fake.failRead = 'ffdata/e.jsonl';
    await assert.rejects(() => ff.readText('e.jsonl'), /EIO/);
    await ff.appendText('e.jsonl', '{"i":1}\n');
    fake.failRead = null;
    const raw = await ff.readText('e.jsonl');
    assert.ok(raw.startsWith('{"i":0}\n'));
    const lines = raw.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    assert.deepEqual(lines, [{ i: 0 }, { i: 1 }]);
  });

  await t.test('8 路并发追加不丢行', async () => {
    const { ff } = await loadFs(t);
    await ff.writeText('f.jsonl', '');
    await Promise.all(Array.from({ length: 8 }, (_, i) => ff.appendText('f.jsonl', `{"i":${i}}\n`)));
    const lines = (await ff.readText('f.jsonl')).split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 8);
  });

  await t.test('崩溃半行后追加：新记录独立成行', async () => {
    const { ff, fake } = await loadFs(t);
    fake.files.set('ffdata/g.jsonl', '{"half":');
    await ff.appendText('g.jsonl', '{"i":1}\n');
    const lines = (await ff.readText('g.jsonl')).split('\n').filter((l) => l.trim());
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[1]), { i: 1 });
  });

  await t.test('损坏 JSON 留 .corrupt 现场并返回 null', async () => {
    const { ff, fake } = await loadFs(t);
    await ff.writeText('h.json', '{oops');
    assert.equal(await ff.readJSON('h.json'), null);
    assert.ok([...fake.files.keys()].some((k) => k.startsWith('ffdata/h.json.corrupt-')));
  });

  await t.test('list 过滤 .tmp 与 .corrupt', async () => {
    const { ff, fake } = await loadFs(t);
    await ff.writeText('x.json', '{}');
    fake.files.set('ffdata/x.json.tmp', '{}');
    fake.files.set('ffdata/x.json.corrupt-1', '{}');
    assert.deepEqual(await ff.list(''), ['x.json']);
  });
});

test('诊断日志环限与读写', async (t) => {
  await t.test('超过 500 条自动裁剪保留最新', async () => {
    const { ff, createLogger } = await loadFs(t);
    const logger = createLogger(ff);
    for (let i = 0; i < 520; i++) await logger.log('error', 't', `msg-${i}`);
    await logger.trim();
    const recent = await logger.recent(1000);
    assert.equal(recent.length, 500);
    assert.equal(recent[recent.length - 1].msg, 'msg-519');
    assert.equal(recent[0].msg, 'msg-20');
  });

  await t.test('clear 清空且 recent 容错损坏行', async () => {
    const { ff, fake, createLogger } = await loadFs(t);
    const logger = createLogger(ff);
    await logger.log('warn', 't', 'ok');
    fake.files.set('ffdata/logs/app.jsonl', (fake.files.get('ffdata/logs/app.jsonl') ?? '') + '{bad\n');
    const recent = await logger.recent();
    assert.equal(recent.length, 1);
    await logger.clear();
    assert.equal((await logger.recent()).length, 0);
  });
});