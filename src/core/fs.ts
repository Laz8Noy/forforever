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
  flush(): Promise<void>;
}

const ROOT = 'ffdata';
const TMP = '.tmp';
const CORRUPT = '.corrupt-';

// 同一路径的写操作串行，避免并发 append/覆盖互相丢数据
class PathQueue {
  private chains = new Map<string, Promise<unknown>>();

  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    const tail = next.catch(() => {});
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return next;
  }

  async drain(prefix: string): Promise<void> {
    const ps = [...this.chains].filter(([k]) => k === prefix || k.startsWith(prefix + '/')).map(([, p]) => p);
    await Promise.all(ps);
  }

  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}

// ---------- Web: IndexedDB ----------
class WebFF implements FF {
  private db!: IDBDatabase;
  private urlCache = new Map<string, string>();
  private q = new PathQueue();

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
    await this.q.drain(path);
    const rec = await this.get(path);
    if (!rec) return null;
    return typeof rec.data === 'string' ? rec.data : await rec.data.text();
  }

  writeText(path: string, text: string): Promise<void> {
    return this.q.enqueue(path, () => this.put(path, text));
  }

  appendText(path: string, text: string): Promise<void> {
    return this.q.enqueue(path, async () => {
      const rec = await this.get(path);
      const old = rec ? (typeof rec.data === 'string' ? rec.data : await rec.data.text()) : '';
      await this.put(path, old + text);
    });
  }

  async readJSON<T>(path: string): Promise<T | null> {
    const text = await this.readText(path);
    if (text == null) return null;
    try {
      return JSON.parse(text) as T;
    } catch {
      await this.writeText(`${path}${CORRUPT}${Date.now()}`, text).catch(() => {});
      return null;
    }
  }

  writeJSON(path: string, value: unknown): Promise<void> {
    return this.writeText(path, JSON.stringify(value, null, 2));
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
      const seg = k.slice(prefix.length).split('/')[0];
      if (seg && !seg.endsWith(TMP) && !seg.includes(CORRUPT)) names.add(seg);
    }
    return [...names];
  }

  async exists(path: string): Promise<boolean> {
    await this.q.drain(path);
    return (await this.get(path)) !== undefined;
  }

  async remove(path: string): Promise<void> {
    await this.q.drain(path);
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

  writeBlob(path: string, blob: Blob): Promise<void> {
    return this.q.enqueue(path, async () => {
      await this.put(path, blob);
      const old = this.urlCache.get(path);
      if (old) {
        URL.revokeObjectURL(old);
        this.urlCache.delete(path);
      }
    });
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
      if (k.endsWith(TMP) || k.includes(CORRUPT)) continue;
      const blob = await this.readBlob(k);
      if (blob) out.push({ path: k, blob });
    }
    return out;
  }

  flush(): Promise<void> {
    return this.q.flush();
  }
}

// ---------- Native: Capacitor Filesystem（真实文件 + 原子写 + 崩溃恢复） ----------
const isNotFound = (e: unknown): boolean =>
  /does not exist|no such file|not found|ENOENT|doesn't exist/i.test(String((e as { message?: string })?.message ?? e));

class NativeFF implements FF {
  private urlCache = new Map<string, string>();
  private q = new PathQueue();

  async init(): Promise<void> {
    await Filesystem.mkdir({ path: ROOT, directory: Directory.Data, recursive: true }).catch(() => {});
    await this.recoverAll().catch(() => {});
  }

  private full(path: string): string {
    return `${ROOT}/${path}`;
  }

  private async rawRead(path: string): Promise<string | null> {
    try {
      const r = await Filesystem.readFile({ path: this.full(path), directory: Directory.Data, encoding: Encoding.UTF8 });
      return r.data as string;
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e; // 真实 I/O 错误绝不当作空文件
    }
  }

  private async rawExists(path: string): Promise<boolean> {
    try {
      await Filesystem.stat({ path: this.full(path), directory: Directory.Data });
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  private async rawDelete(path: string): Promise<void> {
    await Filesystem.deleteFile({ path: this.full(path), directory: Directory.Data }).catch((e) => {
      if (!isNotFound(e)) throw e;
    });
  }

  private async rawWrite(path: string, data: string): Promise<void> {
    const tmp = path + TMP;
    await Filesystem.writeFile({ path: this.full(tmp), directory: Directory.Data, data, encoding: Encoding.UTF8, recursive: true });
    await this.rawDelete(path);
    await Filesystem.rename({ from: this.full(tmp), to: this.full(path), directory: Directory.Data });
  }

  // target 缺失而 .tmp 存在时提升 .tmp；半截 JSON 不提升
  private async rawRecover(path: string): Promise<boolean> {
    const tmp = path + TMP;
    const data = await this.rawRead(tmp).catch(() => null);
    if (data == null) return false;
    if (path.endsWith('.json')) {
      try {
        JSON.parse(data);
      } catch {
        await this.rawDelete(tmp).catch(() => {});
        return false;
      }
    }
    await Filesystem.rename({ from: this.full(tmp), to: this.full(path), directory: Directory.Data });
    return true;
  }

  async readText(path: string): Promise<string | null> {
    await this.q.drain(path);
    const d = await this.rawRead(path);
    if (d != null) return d;
    if (await this.rawRecover(path)) return this.rawRead(path);
    return null;
  }

  writeText(path: string, text: string): Promise<void> {
    return this.q.enqueue(path, () => this.rawWrite(path, text));
  }

  appendText(path: string, text: string): Promise<void> {
    return this.q.enqueue(path, async () => {
      // jsonl 前置换行：上次崩溃若留下半行，新记录仍独立成行（加载器跳过空行）
      const chunk = path.endsWith('.jsonl') ? '\n' + text : text;
      if (!(await this.rawExists(path))) {
        if (!(await this.rawRecover(path))) {
          await this.rawWrite(path, text);
          return;
        }
      }
      await Filesystem.appendFile({ path: this.full(path), directory: Directory.Data, data: chunk, encoding: Encoding.UTF8 });
    });
  }

  async readJSON<T>(path: string): Promise<T | null> {
    const t = await this.readText(path);
    if (t == null) return null;
    try {
      return JSON.parse(t) as T;
    } catch {
      await this.writeText(`${path}${CORRUPT}${Date.now()}`, t).catch(() => {});
      return null;
    }
  }

  writeJSON(path: string, value: unknown): Promise<void> {
    return this.writeText(path, JSON.stringify(value, null, 2));
  }

  async list(dir: string): Promise<string[]> {
    try {
      const r = await Filesystem.readdir({ path: this.full(dir), directory: Directory.Data });
      return r.files.map((f) => f.name).filter((n) => !n.endsWith(TMP) && !n.includes(CORRUPT));
    } catch (e) {
      if (isNotFound(e)) return [];
      throw e;
    }
  }

  async exists(path: string): Promise<boolean> {
    await this.q.drain(path);
    try {
      return (await this.rawExists(path)) || (await this.rawRecover(path));
    } catch {
      return false;
    }
  }

  async remove(path: string): Promise<void> {
    await this.q.drain(path);
    const p = this.full(path);
    try {
      const st = await Filesystem.stat({ path: p, directory: Directory.Data });
      if (st.type === 'directory') {
        await Filesystem.rmdir({ path: p, directory: Directory.Data, recursive: true });
      } else {
        await Filesystem.deleteFile({ path: p, directory: Directory.Data });
      }
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    await this.rawDelete(path + TMP).catch(() => {});
    this.urlCache.delete(path);
  }

  async readBlob(path: string): Promise<Blob | null> {
    try {
      const r = await Filesystem.readFile({ path: this.full(path), directory: Directory.Data });
      const bin = atob(r.data as string);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes]);
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async writeBlob(path: string, blob: Blob): Promise<void> {
    const b64 = await new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve((fr.result as string).split(',')[1]);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(blob);
    });
    await this.q.enqueue(path, () =>
      Filesystem.writeFile({ path: this.full(path), directory: Directory.Data, data: b64, recursive: true }).then(() => {}),
    );
    this.urlCache.delete(path);
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
    for (const name of await this.list(dir)) {
      const p = dir ? `${dir}/${name}` : name;
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

  flush(): Promise<void> {
    return this.q.flush();
  }

  // 启动时扫描 .tmp 孤儿：target 缺失→提升；target 存在→上次写入未完成，丢弃 .tmp
  private async recoverAll(): Promise<void> {
    const walkRaw = async (dir: string): Promise<string[]> => {
      let files: { name: string; type?: string }[] = [];
      try {
        files = (await Filesystem.readdir({ path: this.full(dir), directory: Directory.Data })).files;
      } catch {
        return [];
      }
      const out: string[] = [];
      for (const f of files) {
        const p = dir ? `${dir}/${f.name}` : f.name;
        if (f.type === 'directory') out.push(...(await walkRaw(p)));
        else if (f.name.endsWith(TMP)) out.push(p);
      }
      return out;
    };
    for (const tmp of await walkRaw('')) {
      const target = tmp.slice(0, -TMP.length);
      if (await this.rawExists(target).catch(() => true)) await this.rawDelete(tmp).catch(() => {});
      else await this.rawRecover(target).catch(() => {});
    }
  }
}

export async function createFF(): Promise<FF> {
  const impl = Capacitor.isNativePlatform() ? new NativeFF() : new WebFF();
  await impl.init();
  return impl;
}