import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

// 统一文件接口：路径均相对 ffdata/ 根。Web 用 IndexedDB 模拟，安卓落真实文件。
export interface FF {
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  appendText(path: string, text: string): Promise<void>;
  readJSON<T>(path: string): Promise<T | null>;
  writeJSON(path: string, value: unknown): Promise<void>;
  list(dir: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  readBlob(path: string): Promise<Blob | null>;
  writeBlob(path: string, blob: Blob): Promise<void>;
  getUrl(path: string): Promise<string>;
  allFiles(): Promise<{ path: string; blob: Blob }[]>;
}

const ROOT = 'ffdata';

// ---------- Web: IndexedDB ----------
class WebFF implements FF {
  private db!: IDBDatabase;
  private urlCache = new Map<string, string>();

  async init(): Promise<void> {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('forforever', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('files')) {
          req.result.createObjectStore('files', { keyPath: 'path' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private tx(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction('files', mode).objectStore('files');
  }

  private get(path: string): Promise<{ path: string; data: string | Blob } | undefined> {
    return new Promise((resolve, reject) => {
      const req = this.tx('readonly').get(path);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private put(path: string, data: string | Blob): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = this.tx('readwrite').put({ path, data });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async readText(path: string): Promise<string | null> {
    const rec = await this.get(path);
    if (!rec) return null;
    return typeof rec.data === 'string' ? rec.data : await rec.data.text();
  }

  async writeText(path: string, text: string): Promise<void> {
    await this.put(path, text);
  }

  async appendText(path: string, text: string): Promise<void> {
    const old = (await this.readText(path)) ?? '';
    await this.put(path, old + text);
  }

  async readJSON<T>(path: string): Promise<T | null> {
    const text = await this.readText(path);
    if (text == null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async writeJSON(path: string, value: unknown): Promise<void> {
    await this.writeText(path, JSON.stringify(value, null, 2));
  }

  private allKeys(): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const req = this.tx('readonly').getAllKeys();
      req.onsuccess = () => resolve(req.result as string[]);
      req.onerror = () => reject(req.error);
    });
  }

  async list(dir: string): Promise<string[]> {
    const prefix = dir ? dir.replace(/\/$/, '') + '/' : '';
    const keys = await this.allKeys();
    const names = new Set<string>();
    for (const k of keys) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const seg = rest.split('/')[0];
      if (seg) names.add(seg);
    }
    return [...names];
  }

  async exists(path: string): Promise<boolean> {
    return (await this.get(path)) !== undefined;
  }

  async remove(path: string): Promise<void> {
    const keys = await this.allKeys();
    const store = this.tx('readwrite');
    for (const k of keys) {
      if (k === path || k.startsWith(path + '/')) store.delete(k);
    }
    const url = this.urlCache.get(path);
    if (url) {
      URL.revokeObjectURL(url);
      this.urlCache.delete(path);
    }
  }

  async readBlob(path: string): Promise<Blob | null> {
    const rec = await this.get(path);
    if (!rec) return null;
    return typeof rec.data === 'string' ? new Blob([rec.data]) : rec.data;
  }

  async writeBlob(path: string, blob: Blob): Promise<void> {
    await this.put(path, blob);
    const old = this.urlCache.get(path);
    if (old) {
      URL.revokeObjectURL(old);
      this.urlCache.delete(path);
    }
  }

  async getUrl(path: string): Promise<string> {
    const cached = this.urlCache.get(path);
    if (cached) return cached;
    const blob = await this.readBlob(path);
    if (!blob) return '';
    const url = URL.createObjectURL(blob);
    this.urlCache.set(path, url);
    return url;
  }

  async allFiles(): Promise<{ path: string; blob: Blob }[]> {
    const keys = await this.allKeys();
    const out: { path: string; blob: Blob }[] = [];
    for (const k of keys) {
      const blob = await this.readBlob(k);
      if (blob) out.push({ path: k, blob });
    }
    return out;
  }
}

// ---------- Native: Capacitor Filesystem（真实文件 + 原子写） ----------
class NativeFF implements FF {
  private urlCache = new Map<string, string>();

  async init(): Promise<void> {
    await Filesystem.mkdir({ path: ROOT, directory: Directory.Data, recursive: true }).catch(() => {});
  }

  private full(path: string): string {
    return `${ROOT}/${path}`;
  }

  async readText(path: string): Promise<string | null> {
    try {
      const r = await Filesystem.readFile({
        path: this.full(path),
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      return r.data as string;
    } catch {
      return null;
    }
  }

  // 原子写：tmp → 删旧 → rename（DSH atomic-write 同款模式）
  async writeText(path: string, text: string): Promise<void> {
    const target = this.full(path);
    const tmp = target + '.tmp';
    await Filesystem.writeFile({ path: tmp, directory: Directory.Data, data: text, encoding: Encoding.UTF8, recursive: true });
    await Filesystem.deleteFile({ path: target, directory: Directory.Data }).catch(() => {});
    await Filesystem.rename({ from: tmp, to: target, directory: Directory.Data });
  }

  async appendText(path: string, text: string): Promise<void> {
    const old = (await this.readText(path)) ?? '';
    await this.writeText(path, old + text);
  }

  async readJSON<T>(path: string): Promise<T | null> {
    const text = await this.readText(path);
    if (text == null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  async writeJSON(path: string, value: unknown): Promise<void> {
    await this.writeText(path, JSON.stringify(value, null, 2));
  }

  async list(dir: string): Promise<string[]> {
    try {
      const r = await Filesystem.readdir({ path: this.full(dir), directory: Directory.Data });
      return r.files.map((f) => f.name).filter((n) => !n.endsWith('.tmp'));
    } catch {
      return [];
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await Filesystem.stat({ path: this.full(path), directory: Directory.Data });
      return true;
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<void> {
    const full = this.full(path);
    try {
      const st = await Filesystem.stat({ path: full, directory: Directory.Data });
      if (st.type === 'directory') {
        await Filesystem.rmdir({ path: full, directory: Directory.Data, recursive: true });
      } else {
        await Filesystem.deleteFile({ path: full, directory: Directory.Data });
      }
    } catch {
      /* 不存在即视为已删 */
    }
  }

  async readBlob(path: string): Promise<Blob | null> {
    try {
      const r = await Filesystem.readFile({ path: this.full(path), directory: Directory.Data });
      const bin = atob(r.data as string);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes]);
    } catch {
      return null;
    }
  }

  async writeBlob(path: string, blob: Blob): Promise<void> {
    const b64 = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve((fr.result as string).split(',')[1]);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
    await Filesystem.writeFile({ path: this.full(path), directory: Directory.Data, data: b64, recursive: true });
  }

  async getUrl(path: string): Promise<string> {
    const cached = this.urlCache.get(path);
    if (cached) return cached;
    try {
      const { uri } = await Filesystem.getUri({ path: this.full(path), directory: Directory.Data });
      const url = Capacitor.convertFileSrc(uri);
      this.urlCache.set(path, url);
      return url;
    } catch {
      return '';
    }
  }

  private async walk(dir: string, out: string[]): Promise<void> {
    const names = await this.list(dir);
    for (const n of names) {
      const p = dir ? `${dir}/${n}` : n;
      const st = await Filesystem.stat({ path: this.full(p), directory: Directory.Data }).catch(() => null);
      if (st?.type === 'directory') await this.walk(p, out);
      else out.push(p);
    }
  }

  async allFiles(): Promise<{ path: string; blob: Blob }[]> {
    const paths: string[] = [];
    await this.walk('', paths);
    const out: { path: string; blob: Blob }[] = [];
    for (const p of paths) {
      const blob = await this.readBlob(p);
      if (blob) out.push({ path: p, blob });
    }
    return out;
  }
}

export async function createFF(): Promise<FF> {
  const impl = Capacitor.isNativePlatform() ? new NativeFF() : new WebFF();
  await impl.init();
  return impl;
}