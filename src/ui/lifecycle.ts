const cleanups: (() => void)[] = [];

export function onPageCleanup(fn: () => void): void {
  cleanups.push(fn);
}

export function runPageCleanups(): void {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      /* 忽略清理错误 */
    }
  }
}