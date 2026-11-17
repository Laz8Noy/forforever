import type { Context } from '@deepseek-ai/cordis';
import type { MemoryEntry, MemoryLevel, MemoryType } from '../../core/types.ts';
import { MEMORY_TYPE_LABEL, MEMORY_LEVEL_LABEL } from '../../core/types.ts';
import { esc, toast, confirm, modal, phraseGate } from '../dom.ts';
import { topbar } from '../shared.ts';
import { fmtDate } from '../../core/time.ts';

// 面向 AI 的记忆直接展示会破坏沉浸体验 → 两道确认
export async function memoryGate(): Promise<boolean> {
  const first = await confirm(
    '查看面向 AI 的记忆',
    '这些记忆是写给模型看的结构化档案，直接阅读可能会破坏你和 ta 相处的沉浸感。\n\n确定要查看吗？',
    '继续',
  );
  if (!first) return false;
  return phraseGate('第二重确认', '请输入确认短语，证明你清楚自己在做什么。', '确认查看');
}

export async function memoryManagePage(ctx: Context, params: Record<string, string>, root: HTMLElement): Promise<void> {
  const store = ctx.store;
  const char = store.characters.get(params.charId)!;
  if (!char) {
    location.hash = '#/';
    return;
  }
  if (!(await memoryGate())) {
    history.back();
    return;
  }

  const page = document.createElement('div');
  page.className = 'page';
  root.appendChild(page);
  page.appendChild(topbar(`${char.name} · 记忆档案`, { back: () => history.back() }));

  const scroll = document.createElement('div');
  scroll.className = 'scroll';
  page.appendChild(scroll);
  const box = document.createElement('div');
  box.className = 'container';
  scroll.appendChild(box);

  async function render(): Promise<void> {
    const entries = await store.memoryEntries(char.id);
    box.innerHTML = `
      <div class="card">
        <div class="row between">
          <span class="muted">${entries.length} 条记忆 · 启用的会注入对话</span>
          <button class="btn small primary" id="add">＋ 手动添加</button>
        </div>
      </div>
      <div class="card" id="list"></div>`;
    const list = box.querySelector('#list')!;
    if (!entries.length) {
      list.innerHTML = '<p class="muted">还没有记忆。聊天后离线 3 小时回来，会自动沉淀；也可以手动添加。</p>';
    }
    const sorted = [...entries].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.importance - a.importance);
    for (const e of sorted) {
      const item = document.createElement('div');
      item.className = 'mem-item' + (e.enabled ? '' : ' off');
      item.innerHTML = `
        <div class="row between">
          <span><span class="badge">${MEMORY_LEVEL_LABEL[e.level]}</span> <span class="badge gray">${MEMORY_TYPE_LABEL[e.type]}</span> <span class="tiny">重要度 ${e.importance} · ${fmtDate(e.updatedAt)}</span></span>
          ${e.pinned ? '<span class="badge gray">📌 置顶</span>' : ''}
        </div>
        <div class="mem-content">${esc(e.content)}</div>
        <div class="mem-tools">
          <button data-act="edit">编辑</button>
          <button data-act="imp">重要度 ${e.importance}→${(e.importance % 5) + 1}</button>
          <button data-act="pin" class="${e.pinned ? 'on' : ''}">${e.pinned ? '取消置顶' : '置顶'}</button>
          <button data-act="toggle" class="${e.enabled ? 'on' : ''}">${e.enabled ? '已启用' : '已停用'}</button>
          <button data-act="del">删除</button>
        </div>`;
      item.querySelector('[data-act=edit]')!.addEventListener('click', () => editEntry(e));
      item.querySelector('[data-act=imp]')!.addEventListener('click', async () => {
        await ctx.memory.updateEntry(char.id, e.id, { importance: (e.importance % 5) + 1 });
        render();
      });
      item.querySelector('[data-act=pin]')!.addEventListener('click', async () => {
        await ctx.memory.updateEntry(char.id, e.id, { pinned: !e.pinned });
        render();
      });
      item.querySelector('[data-act=toggle]')!.addEventListener('click', async () => {
        await ctx.memory.updateEntry(char.id, e.id, { enabled: !e.enabled });
        render();
      });
      item.querySelector('[data-act=del]')!.addEventListener('click', async () => {
        if (await confirm('删除记忆', `确定删除这条记忆？\n「${e.content}」`, '删除', true)) {
          await ctx.memory.deleteEntry(char.id, e.id);
          render();
        }
      });
      list.appendChild(item);
    }
    box.querySelector('#add')!.addEventListener('click', () => editEntry(null));
  }

  async function editEntry(e: MemoryEntry | null): Promise<void> {
    const types: MemoryType[] = ['fact', 'event', 'preference', 'relationship', 'emotion'];
    let level: MemoryLevel = e?.level ?? 'user';
    let type: MemoryType = e?.type ?? 'fact';
    let content = '';
    const ok = await modal({
      title: e ? '编辑记忆' : '手动添加记忆',
      html: `
        <div class="field"><label>级别</label>
          <select class="input" id="m-level">
            <option value="user" ${level === 'user' ? 'selected' : ''}>一级 · 用户记忆（关于用户的事实）</option>
            <option value="character" ${level === 'character' ? 'selected' : ''}>二级 · 角色记忆（ta 的感受与关系记忆）</option>
          </select>
        </div>
        <div class="field"><label>类型</label>
          <select class="input" id="m-type">${types.map((t) => `<option value="${t}" ${e?.type === t ? 'selected' : ''}>${MEMORY_TYPE_LABEL[t]}</option>`).join('')}</select>
        </div>
        <div class="field"><label>内容（一句简洁陈述）</label>
          <textarea class="input" id="m-content" rows="3">${esc(e?.content ?? '')}</textarea>
        </div>`,
      okText: '保存',
      collect: (el) => {
        level = el.querySelector<HTMLSelectElement>('#m-level')!.value as MemoryLevel;
        type = el.querySelector<HTMLSelectElement>('#m-type')!.value as MemoryType;
        content = el.querySelector<HTMLTextAreaElement>('#m-content')!.value.trim();
      },
    });
    if (!ok) return;
    if (!content) return toast('内容不能为空', 'err');
    if (e) {
      await ctx.memory.updateEntry(char.id, e.id, { level, type, content });
    } else {
      await ctx.memory.addEntry(char.id, { level, type, content });
    }
    toast('已保存', 'ok');
    render();
  }

  await render();
}