import type { Context } from '@deepseek-ai/cordis';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type { ModelId } from '../../core/types.ts';
import { esc, toast, confirm, promptModal, modal, imageToJpeg } from '../dom.ts';
import { topbar, openPlatform, thinkingSelect, applyAppearance, statusDot } from '../shared.ts';
import { priceLabel } from '../../api/pricing.ts';
import { now } from '../../core/time.ts';

const BUDGETS = [
  { label: '32K（最省）', value: 32768 },
  { label: '64K', value: 65536 },
  { label: '128K（默认）', value: 131072 },
  { label: '256K', value: 262144 },
  { label: '最大 ~900K（最贵）', value: 921600 },
];

export async function settingsPage(ctx: Context, _p: Record<string, string>, root: HTMLElement): Promise<void> {
  const store = ctx.store;
  const page = document.createElement('div');
  page.className = 'page';
  root.appendChild(page);
  page.appendChild(topbar('设置', { back: () => (location.hash = '#/') }));

  const scroll = document.createElement('div');
  scroll.className = 'scroll';
  page.appendChild(scroll);
  const box = document.createElement('div');
  box.className = 'container';
  scroll.appendChild(box);

  const keyMasked = store.secrets.apiKey ? store.secrets.apiKey.slice(0, 6) + '••••••••' + store.secrets.apiKey.slice(-4) : '未设置';

  box.innerHTML = `
    <div class="settings-section">
      <h4>DEEPSEEK API</h4>
      <div class="card">
        <div class="setting-row">
          <div><div class="lbl">API key</div><div class="sub">${esc(keyMasked)} · 仅存本机</div></div>
          <button class="btn small" id="key-edit">修改</button>
        </div>
        <div class="row mt">
          <button class="btn small grow" id="key-test">测试连接</button>
          <button class="btn small grow primary" id="open-platform">🔗 开放平台</button>
        </div>
        <div class="row mt">
          <button class="btn small grow" id="tutorial">重看新手教程</button>
        </div>
        <p class="tiny mt">${esc(priceLabel(store.settings.defaultModel))} · 闲时为北京时间 00:30–08:30</p>
      </div>
    </div>

    <div class="settings-section">
      <h4>外观</h4>
      <div class="card">
        <div class="setting-row">
          <div class="lbl">深色主题</div>
          <label class="switch"><input type="checkbox" id="theme-dark" ${store.settings.theme === 'dark' ? 'checked' : ''}><i></i></label>
        </div>
        <div class="setting-row">
          <div><div class="lbl">照片背景</div><div class="sub">${store.settings.backgroundPath ? '已设置' : '未设置'}</div></div>
          <div class="row">
            <button class="btn small" id="bg-pick">选择照片</button>
            ${store.settings.backgroundPath ? '<button class="btn small danger" id="bg-clear">移除</button>' : ''}
          </div>
        </div>
        <div class="setting-row" style="display:block">
          <div class="lbl mb">背景遮罩浓度（保证文字可读）</div>
          <input type="range" id="bg-dim" min="0.2" max="0.9" step="0.05" value="${esc(String(store.settings.bgDim))}" />
        </div>
        <input type="file" id="bg-file" accept="image/*" style="display:none" />
      </div>
    </div>

    <div class="settings-section">
      <h4>对话默认值</h4>
      <div class="card">
        <div class="setting-row">
          <div class="lbl">默认模型</div>
          <select class="input" id="def-model" style="width:auto">
            <option value="deepseek-flash" ${store.settings.defaultModel === 'deepseek-flash' ? 'selected' : ''}>flash</option>
            <option value="deepseek-v4-pro" ${store.settings.defaultModel === 'deepseek-v4-pro' ? 'selected' : ''}>v4-pro</option>
          </select>
        </div>
        <div class="setting-row">
          <div class="lbl">默认思考强度</div>
          <div id="def-think"></div>
        </div>
        <div class="setting-row">
          <div><div class="lbl">上下文预算</div><div class="sub">越大记得越全，也越贵</div></div>
          <select class="input" id="budget" style="width:auto">
            ${BUDGETS.map((b) => `<option value="${b.value}" ${store.settings.tokenBudget === b.value ? 'selected' : ''}>${b.label}</option>`).join('')}
          </select>
        </div>
        <div class="setting-row">
          <div><div class="lbl">流式输出</div><div class="sub">关闭则整段返回+打字机效果</div></div>
          <label class="switch"><input type="checkbox" id="stream" ${store.settings.streamEnabled ? 'checked' : ''}><i></i></label>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h4>记忆</h4>
      <div class="card">
        <div class="setting-row">
          <div><div class="lbl">自动收集触发</div><div class="sub">离线超过此时长，回来时自动整理</div></div>
          <select class="input" id="threshold" style="width:auto">
            ${[1, 3, 6, 12, 24].map((h) => `<option value="${h}" ${store.settings.collectThresholdHours === h ? 'selected' : ''}>${h} 小时</option>`).join('')}
          </select>
        </div>
        <div class="setting-row">
          <div><div class="lbl">仅闲时收集</div><div class="sub">高峰时段推迟到 00:30–08:30</div></div>
          <label class="switch"><input type="checkbox" id="offpeak" ${store.settings.offPeakOnlyCollect ? 'checked' : ''}><i></i></label>
        </div>
        <div class="setting-row">
          <div id="mem-status"></div>
          <button class="btn small" id="collect-now">立即收集</button>
        </div>
        <div class="setting-row">
          <div><div class="lbl">查看面向 AI 的记忆</div><div class="sub">需要双重确认 · 可能破坏沉浸感</div></div>
          <button class="btn small" id="view-memory">选择人物</button>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h4>数据（全部本地）</h4>
      <div class="card">
        <div class="row">
          <button class="btn small grow" id="export">导出备份</button>
          <button class="btn small grow" id="import">导入备份</button>
        </div>
        <input type="file" id="import-file" accept=".zip" style="display:none" />
        <p class="tiny mt">卸载 App 会删除所有本地数据，换机前请先导出。备份默认不含 API key。</p>
      </div>
    </div>

    <div class="settings-section">
      <h4>关于</h4>
      <div class="card">
        <p class="muted">Forforever v0.1.0 · 长线陪伴，不再失忆</p>
        <p class="tiny mt">数据仅存本机 · 直连 DeepSeek 官方 API · 内容审核遵循平台规则</p>
        <details class="mt">
          <summary class="tiny" style="cursor:pointer">调试工具</summary>
          <div class="row mt">
            <button class="btn small" id="dbg-away">模拟离线 4 小时并收集</button>
          </div>
        </details>
      </div>
    </div>`;

  box.querySelector('#mem-status')!.appendChild(statusDot(ctx));
  box.querySelector('#def-think')!.appendChild(
    thinkingSelect(store.settings.defaultThinking, (t) => store.saveSettings({ defaultThinking: t })),
  );

  box.querySelector('#key-edit')!.addEventListener('click', async () => {
    const k = await promptModal('修改 API key', store.secrets.apiKey, 'sk-...');
    if (k) {
      await store.setApiKey(k);
      toast('已保存，建议测试连接', 'ok');
    }
  });
  box.querySelector('#key-test')!.addEventListener('click', async () => {
    if (!store.secrets.apiKey) return toast('请先设置 key', 'err');
    toast('测试中…');
    const r = await ctx.deepseek.testKey(store.secrets.apiKey);
    toast(r.ok ? '连接成功' : r.error ?? '连接失败', r.ok ? 'ok' : 'err', 4000);
  });
  box.querySelector('#open-platform')!.addEventListener('click', () => openPlatform());
  box.querySelector('#tutorial')!.addEventListener('click', () => (location.hash = '#/welcome'));

  box.querySelector('#theme-dark')!.addEventListener('change', async (e) => {
    await store.saveSettings({ theme: (e.target as HTMLInputElement).checked ? 'dark' : 'light' });
    applyAppearance(ctx);
  });
  const bgFile = box.querySelector<HTMLInputElement>('#bg-file')!;
  box.querySelector('#bg-pick')!.addEventListener('click', () => bgFile.click());
  bgFile.addEventListener('change', async () => {
    const f = bgFile.files?.[0];
    if (!f) return;
    const blob = await imageToJpeg(f, 1600, 0.88);
    const path = await store.saveBackground(blob);
    await store.saveSettings({ backgroundPath: path });
    await applyAppearance(ctx);
    toast('背景已更换', 'ok');
  });
  box.querySelector('#bg-clear')?.addEventListener('click', async () => {
    await store.saveSettings({ backgroundPath: null });
    await applyAppearance(ctx);
  });
  box.querySelector('#bg-dim')!.addEventListener('input', async (e) => {
    await store.saveSettings({ bgDim: Number((e.target as HTMLInputElement).value) });
    applyAppearance(ctx);
  });

  box.querySelector('#def-model')!.addEventListener('change', async (e) => {
    await store.saveSettings({ defaultModel: (e.target as HTMLSelectElement).value as ModelId });
  });
  box.querySelector('#budget')!.addEventListener('change', async (e) => {
    await store.saveSettings({ tokenBudget: Number((e.target as HTMLSelectElement).value) });
  });
  box.querySelector('#stream')!.addEventListener('change', async (e) => {
    await store.saveSettings({ streamEnabled: (e.target as HTMLInputElement).checked });
  });
  box.querySelector('#threshold')!.addEventListener('change', async (e) => {
    await store.saveSettings({ collectThresholdHours: Number((e.target as HTMLSelectElement).value) });
  });
  box.querySelector('#offpeak')!.addEventListener('change', async (e) => {
    await store.saveSettings({ offPeakOnlyCollect: (e.target as HTMLInputElement).checked });
  });
  box.querySelector('#collect-now')!.addEventListener('click', async () => {
    if (!store.secrets.apiKey) return toast('请先设置 API key', 'err');
    toast('开始整理记忆…');
    await ctx.memory.collectAll();
    toast(ctx.memory.status.lastError ?? '记忆整理完成', ctx.memory.status.lastError ? 'err' : 'ok', 4000);
  });
  box.querySelector('#view-memory')!.addEventListener('click', async () => {
    const chars = [...store.characters.values()];
    if (!chars.length) return toast('还没有人物', 'err');
    let picked = chars[0].id;
    const ok = await modal({
      title: '选择要查看记忆的人物',
      html: `<div class="field"><select class="input" id="mem-char">${chars.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div>`,
      okText: '继续（需双重确认）',
      collect: (el) => {
        picked = el.querySelector<HTMLSelectElement>('#mem-char')!.value;
      },
    });
    if (ok) location.hash = `#/memory/${picked}`;
  });

  box.querySelector('#export')!.addEventListener('click', async () => {
    const native = Capacitor.isNativePlatform();
    let includeKey = false;
    if (native) {
      await modal({
        title: '导出备份',
        body: 'API key 存放在安卓系统 Keystore 中，无法随备份导出。换机或重装后需要重新填写 key。\n其余数据（人物/对话/记忆/日记/设置）都会包含。',
        hideCancel: true,
        okText: '知道了，导出',
      });
    } else {
      includeKey = await confirm('导出备份', '是否把 API key 也包含在备份里？\n选「包含」请妥善保管备份文件。', '包含 key');
    }
    const files = await ctx.ffs.allFiles();
    const entries: Record<string, Uint8Array> = {};
    for (const f of files) {
      if (!includeKey && f.path === 'secrets.json') continue;
      entries[f.path] = new Uint8Array(await f.blob.arrayBuffer());
    }
    const zip = zipSync(entries);
    const fname = `forforever-backup-${new Date().toISOString().slice(0, 10)}.zip`;
    if (Capacitor.isNativePlatform()) {
      let bin = '';
      for (let i = 0; i < zip.length; i += 0x8000) {
        bin += String.fromCharCode(...zip.subarray(i, i + 0x8000));
      }
      const b64 = btoa(bin);
      await Filesystem.writeFile({ path: fname, directory: Directory.Cache, data: b64 });
      const { uri } = await Filesystem.getUri({ path: fname, directory: Directory.Cache });
      await Share.share({ title: 'Forforever 备份', files: [uri] });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([zip as BlobPart], { type: 'application/zip' }));
      a.download = fname;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    toast('备份已导出', 'ok');
  });

  const importFile = box.querySelector<HTMLInputElement>('#import-file')!;
  box.querySelector('#import')!.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', async () => {
    const f = importFile.files?.[0];
    if (!f) return;
    if (!(await confirm('导入备份', '导入会覆盖当前同名数据。确定继续？', '导入', true))) return;
    try {
      const unzipped = unzipSync(new Uint8Array(await f.arrayBuffer()));
      for (const [path, data] of Object.entries(unzipped)) {
        if (path.endsWith('/')) continue;
        if (path === 'secrets.json') {
          const sec = JSON.parse(strFromU8(data)) as { apiKey?: string };
          if (sec.apiKey) await store.setApiKey(sec.apiKey);
          continue;
        }
        if (path.endsWith('.json') || path.endsWith('.jsonl') || path.endsWith('.md')) {
          await ctx.ffs.writeText(path, strFromU8(data));
        } else {
          await ctx.ffs.writeBlob(path, new Blob([data as BlobPart]));
        }
      }
      toast('导入完成，正在重启…', 'ok');
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      toast('备份文件无效：' + (e instanceof Error ? e.message : String(e)), 'err', 4000);
    }
  });

  box.querySelector('#dbg-away')!.addEventListener('click', async () => {
    await store.saveSettings({ lastActiveAt: now() - 4 * 3600e3 });
    toast('已模拟离线 4 小时，开始收集');
    await ctx.memory.maybeAutoCollect();
    toast(ctx.memory.status.lastError ?? '收集完成，去日记本看看', ctx.memory.status.lastError ? 'err' : 'ok', 4000);
  });
}