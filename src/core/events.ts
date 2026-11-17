import type { Settings, Character, Session } from './types.ts';
import type { MemoryStatus } from '../memory/collector.ts';

declare module '@deepseek-ai/cordis' {
  interface Events {
    'store/settings'(settings: Settings): void;
    'store/character'(character: Character | null): void;
    'store/session'(session: Session | null): void;
    'store/memory'(charId: string): void;
    'store/diary'(charId: string): void;
    'memory/status'(status: MemoryStatus): void;
    'memory/deferred'(message: string): void;
  }
}