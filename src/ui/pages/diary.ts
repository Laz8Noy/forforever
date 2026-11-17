import type { Context } from '@deepseek-ai/cordis';
import { esc, phraseGate } from '../dom.ts';
import { topbar } from '../shared.ts';
import { md } from '../dom.ts';

function diaryLabel(name: string): string {
  // 2026-11-17T21-30.md → 2026-11-17 21:30
  const m = name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
  return m ? `${m[1]} ${m[2]}:${m[3]}` : name.replace(/\.md$/, '');
}

function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n*/, '');
}

export async function diaryPage(ctx: Context, params: Record<string, string>, root: HTMLElement): Promise<void> {
  const store = ctx.store;
  const char = store.characters.get(params.charId)!;
  if (!char) {
    location.hash = '#/';
    return;
  }

  const ok = await phraseGate(
    `偷看 ${char.name} 的日记`,
    '这是 ta 按自己的人设写下的私密文字，ta 并不知道你会看。\n偷看可能会让你看到 ta 没对你说出口的话。',
    '确认偷看ta的日记',
  );
  if (!ok) {
    history.back();
    return;
  }

  const page = document.createElement('div');
  page.className = 'page';
  root.appendChild(page);

  async function showList(): Promise<void> {
    page.innerHTML = '';
    page.appendChild(topbar(`${char.name} 的日记本`, { back: () => history.back() }));
    const scroll = document.createElement('div');
    scroll.className = 'scroll';
    page.appendChild(scroll);
    const box = document.createElement('div');
    box.className = 'container';
    scroll.appendChild(box);

    const names = await store.diaryNames(char.id);
    if (!names.length) {
      box.innerHTML = `<div class="empty"><div class="big">📔</div><p>日记本还是空的。<br>和 ta 聊聊天，离线 3 小时再回来，<br>ta 会写下这段时间的心情。</p></div>`;
      return;
    }
    const card = document.createElement('div');
    card.className = 'card';
    card.style.padding = '0';
    for (const name of names) {
      const text = (await store.readDiary(char.id, name)) ?? '';
      const body = stripFrontmatter(text);
      const item = document.createElement('div');
      item.className = 'diary-item';
      item.innerHTML = `
        <div style="font-weight:600;font-size:14px">${esc(diaryLabel(name))}</div>
        <div class="muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(body.slice(0, 44))}</div>`;
      item.addEventListener('click', () => showRead(name, body));
      card.appendChild(item);
    }
    box.appendChild(card);
    box.insertAdjacentHTML('beforeend', '<p class="tiny" style="text-align:center">日记完全按 ta 的人设口吻写成 · 只有你能看到</p>');
  }

  function showRead(name: string, body: string): void {
    page.innerHTML = '';
    page.appendChild(topbar(diaryLabel(name), { back: () => showList() }));
    const scroll = document.createElement('div');
    scroll.className = 'scroll';
    page.appendChild(scroll);
    const card = document.createElement('div');
    card.className = 'card';
    card.style.margin = '14px';
    const read = document.createElement('div');
    read.className = 'diary-read';
    read.innerHTML = md(body);
    card.appendChild(read);
    scroll.appendChild(card);
  }

  await showList();
}