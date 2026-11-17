import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function md(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }) as string);
}

export function toast(msg: string, type: 'info' | 'ok' | 'err' = 'info', ms = 2600): void {
  const root = document.getElementById('toast-root')!;
  const t = document.createElement('div');
  t.className = `toast ${type === 'info' ? '' : type}`;
  t.textContent = msg;
  root.appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transition = 'opacity 0.3s';
    setTimeout(() => t.remove(), 320);
  }, ms);
}

export interface ModalOpts {
  title: string;
  body?: string;
  html?: string;
  okText?: string;
  cancelText?: string;
  danger?: boolean;
  hideCancel?: boolean;
  collect?: (modalEl: HTMLElement) => void;
}

export function modal(opts: ModalOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal">
        <h3>${esc(opts.title)}</h3>
        ${opts.html ?? `<div class="modal-body">${esc(opts.body ?? '')}</div>`}
        <div class="modal-actions">
          ${opts.hideCancel ? '' : `<button class="btn" data-act="cancel">${esc(opts.cancelText ?? '取消')}</button>`}
          <button class="btn ${opts.danger ? 'danger' : 'primary'}" data-act="ok">${esc(opts.okText ?? '确定')}</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const close = (v: boolean) => {
      mask.remove();
      resolve(v);
    };
    mask.querySelector('[data-act=ok]')!.addEventListener('click', () => {
      opts.collect?.(mask.querySelector('.modal') as HTMLElement);
      close(true);
    });
    mask.querySelector('[data-act=cancel]')?.addEventListener('click', () => close(false));
    mask.addEventListener('click', (e) => {
      if (e.target === mask) close(false);
    });
  });
}

export const confirm = (title: string, body: string, okText = '确定', danger = false): Promise<boolean> =>
  modal({ title, body, okText, danger });

// 输入确认门：必须手动输入指定短语（偷看日记 / 查看AI记忆第二重）
export function phraseGate(title: string, desc: string, phrase: string): Promise<boolean> {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal">
        <h3>${esc(title)}</h3>
        <div class="modal-body">${esc(desc)}</div>
        <div class="field">
          <label>请手动输入「${esc(phrase)}」</label>
          <input class="input" id="gate-input" autocomplete="off" placeholder="${esc(phrase)}" />
        </div>
        <div class="modal-actions">
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn primary" data-act="ok" disabled>确认</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const input = mask.querySelector<HTMLInputElement>('#gate-input')!;
    const ok = mask.querySelector<HTMLButtonElement>('[data-act=ok]')!;
    input.addEventListener('input', () => {
      ok.disabled = input.value.trim() !== phrase;
    });
    const close = (v: boolean) => {
      mask.remove();
      resolve(v);
    };
    ok.addEventListener('click', () => close(true));
    mask.querySelector('[data-act=cancel]')!.addEventListener('click', () => close(false));
    setTimeout(() => input.focus(), 80);
  });
}

// 文本输入弹窗（重命名等）
export function promptModal(title: string, initial: string, placeholder = ''): Promise<string | null> {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal">
        <h3>${esc(title)}</h3>
        <div class="field"><input class="input" id="prompt-input" /></div>
        <div class="modal-actions">
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn primary" data-act="ok">保存</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const input = mask.querySelector<HTMLInputElement>('#prompt-input')!;
    input.value = initial;
    input.placeholder = placeholder;
    const close = (v: string | null) => {
      mask.remove();
      resolve(v);
    };
    mask.querySelector('[data-act=ok]')!.addEventListener('click', () => close(input.value.trim() || null));
    mask.querySelector('[data-act=cancel]')!.addEventListener('click', () => close(null));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') close(input.value.trim() || null);
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 80);
  });
}

// 选择弹窗（删除菜单等）
export function actionSheet(title: string, actions: { label: string; danger?: boolean; value: string }[]): Promise<string | null> {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal">
        <h3>${esc(title)}</h3>
        <div style="display:flex;flex-direction:column;gap:8px">
          ${actions.map((a) => `<button class="btn block ${a.danger ? 'danger' : ''}" data-v="${esc(a.value)}">${esc(a.label)}</button>`).join('')}
          <button class="btn block" data-v="">取消</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    const close = (v: string | null) => {
      mask.remove();
      resolve(v);
    };
    mask.querySelectorAll<HTMLButtonElement>('[data-v]').forEach((b) => {
      b.addEventListener('click', () => close(b.dataset.v || null));
    });
    mask.addEventListener('click', (e) => {
      if (e.target === mask) close(null);
    });
  });
}

export function fileToBlob(input: HTMLInputElement): Blob | null {
  return input.files?.[0] ?? null;
}

// 图片压缩到合理尺寸再存（头像/背景）
export async function imageToJpeg(file: Blob, maxSide: number, quality = 0.85): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), 'image/jpeg', quality));
}