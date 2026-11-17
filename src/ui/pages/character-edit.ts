import type { Context } from '@deepseek-ai/cordis';
import type { Character } from '../../core/types.ts';
import { esc, toast, confirm, imageToJpeg } from '../dom.ts';
import { topbar } from '../shared.ts';
import { uid } from '../../core/ids.ts';
import { now } from '../../core/time.ts';

export async function characterEditPage(ctx: Context, params: Record<string, string>, root: HTMLElement): Promise<void> {
  const store = ctx.store;
  const isNew = params.id === 'new';
  const existing = isNew ? undefined : store.characters.get(params.id);
  if (!isNew && !existing) {
    location.hash = '#/characters';
    return;
  }

  let name = existing?.name ?? '';
  let persona = existing?.persona ?? '';
  let greeting = existing?.greeting ?? '';
  let avatarPath = existing?.avatar ?? null;
  let avatarBlob: Blob | null = null;

  const page = document.createElement('div');
  page.className = 'page';
  root.appendChild(page);
  page.appendChild(topbar(isNew ? '创建人物' : `编辑 · ${name}`, { back: () => (location.hash = '#/characters') }));

  const scroll = document.createElement('div');
  scroll.className = 'scroll';
  page.appendChild(scroll);
  const box = document.createElement('div');
  box.className = 'container';
  scroll.appendChild(box);

  const previewUrl = avatarPath ? await store.imageUrl(avatarPath) : '';
  box.innerHTML = `
    <div class="card" style="text-align:center">
      <div class="avatar lg" id="av-preview" style="margin:0 auto 10px">${previewUrl ? `<img src="${previewUrl}" />` : esc(name.slice(0, 1) || '?')}</div>
      <input type="file" id="av-file" accept="image/*" style="display:none" />
      <button class="btn small" id="av-pick">选择头像照片</button>
    </div>
    <div class="card">
      <div class="field"><label>名字</label><input class="input" id="f-name" value="${esc(name)}" placeholder="ta 的名字" /></div>
      <div class="field">
        <label>人设</label>
        <textarea class="input" id="f-persona" rows="10" placeholder="性格、说话风格、背景故事、你们的关系……写得越具体，ta 越鲜活。日记也会按这个人设的口吻写。">${esc(persona)}</textarea>
      </div>
      <div class="field">
        <label>开场白（可选，新对话的第一句话）</label>
        <textarea class="input" id="f-greeting" rows="2" placeholder="例如：今天过得怎么样？我一直等你上线呢">${esc(greeting)}</textarea>
      </div>
    </div>
    <button class="btn primary block" id="save">保存</button>
    ${isNew ? '' : `
    <div class="card mt">
      <div class="row between">
        <div><div style="font-weight:600">记忆与日记</div><div class="tiny">查看需要确认，保护沉浸感</div></div>
      </div>
      <div class="row mt">
        <button class="btn small grow" id="go-memory">🗂 管理记忆</button>
        <button class="btn small grow" id="go-diary">📔 偷看日记</button>
      </div>
    </div>
    <button class="btn danger block mt" id="del">删除人物</button>`}`;

  const nameInput = box.querySelector<HTMLInputElement>('#f-name')!;
  const personaInput = box.querySelector<HTMLTextAreaElement>('#f-persona')!;
  const greetingInput = box.querySelector<HTMLTextAreaElement>('#f-greeting')!;
  nameInput.addEventListener('input', () => (name = nameInput.value));
  personaInput.addEventListener('input', () => (persona = personaInput.value));
  greetingInput.addEventListener('input', () => (greeting = greetingInput.value));

  const avFile = box.querySelector<HTMLInputElement>('#av-file')!;
  box.querySelector('#av-pick')!.addEventListener('click', () => avFile.click());
  avFile.addEventListener('change', async () => {
    const f = avFile.files?.[0];
    if (!f) return;
    avatarBlob = await imageToJpeg(f, 512);
    const url = URL.createObjectURL(avatarBlob);
    box.querySelector('#av-preview')!.innerHTML = `<img src="${url}" />`;
  });

  box.querySelector('#save')!.addEventListener('click', async () => {
    if (!name.trim()) return toast('名字不能为空', 'err');
    if (!persona.trim()) return toast('人设不能为空', 'err');
    const id = existing?.id ?? uid();
    if (avatarBlob) avatarPath = await store.saveAvatar(id, avatarBlob);
    const c: Character = {
      id,
      name: name.trim(),
      persona: persona.trim(),
      greeting: greeting.trim(),
      avatar: avatarPath,
      createdAt: existing?.createdAt ?? now(),
      updatedAt: now(),
    };
    await store.saveCharacter(c);
    toast('已保存', 'ok');
    location.hash = '#/characters';
  });

  if (!isNew && existing) {
    box.querySelector('#go-memory')!.addEventListener('click', () => (location.hash = `#/memory/${existing.id}`));
    box.querySelector('#go-diary')!.addEventListener('click', () => (location.hash = `#/diary/${existing.id}`));
    box.querySelector('#del')!.addEventListener('click', async () => {
      const n = [...store.sessions.values()].filter((s) => s.charId === existing.id).length;
      if (
        await confirm(
          '删除人物',
          `确定删除「${existing.name}」？ta 的 ${n} 个对话、全部记忆和日记都会一并删除，无法恢复。`,
          '删除',
          true,
        )
      ) {
        await store.deleteCharacter(existing.id);
        toast('已删除', 'ok');
        location.hash = '#/characters';
      }
    });
  }
}