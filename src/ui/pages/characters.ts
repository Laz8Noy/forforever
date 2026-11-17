import type { Context } from '@deepseek-ai/cordis';
import { esc } from '../dom.ts';
import { avatarEl, topbar, iconBtn } from '../shared.ts';

export async function charactersPage(ctx: Context, _p: Record<string, string>, root: HTMLElement): Promise<void> {
  const store = ctx.store;
  const page = document.createElement('div');
  page.className = 'page';
  root.appendChild(page);
  page.appendChild(topbar('人物', { back: () => (location.hash = '#/'), right: [iconBtn('＋', () => (location.hash = '#/character/new'), '新建人物')] }));

  const scroll = document.createElement('div');
  scroll.className = 'scroll';
  page.appendChild(scroll);
  const box = document.createElement('div');
  box.className = 'container';
  scroll.appendChild(box);

  const chars = [...store.characters.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!chars.length) {
    box.innerHTML = `<div class="empty"><div class="big">👤</div><p>还没有人物<br>创建一个 ta，开始你们的故事</p><button class="btn primary mt" id="cta">创建人物</button></div>`;
    box.querySelector('#cta')!.addEventListener('click', () => (location.hash = '#/character/new'));
    return;
  }

  for (const c of chars) {
    const sessionCount = [...store.sessions.values()].filter((s) => s.charId === c.id).length;
    const entries = await store.memoryEntries(c.id);
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cursor = 'pointer';
    card.innerHTML = `
      <div class="row">
        <div class="grow" style="min-width:0">
          <div style="font-weight:600;font-size:16px">${esc(c.name)}</div>
          <div class="muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.persona.slice(0, 50))}</div>
          <div class="tiny mt">${sessionCount} 个对话 · ${entries.length} 条记忆</div>
        </div>
        <span class="badge gray">编辑 ›</span>
      </div>`;
    card.prepend(await avatarEl(ctx, c));
    card.addEventListener('click', () => (location.hash = `#/character/${c.id}`));
    box.appendChild(card);
  }
}