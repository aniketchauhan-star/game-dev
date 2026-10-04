import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/**
 * Real save state for the top bar. Components wrap each save in `track()`, so
 * “Saved” only appears after the server confirmed the write.
 */
export type SaveState = { status: 'idle' | 'saving' | 'saved' | 'error'; at: string | null; message: string | null; retry: (() => void) | null };

interface Ctx {
  state: SaveState;
  track: <T>(fn: () => Promise<T>, retry?: () => void) => Promise<T>;
  markDirty: () => void;
}

const SaveContext = createContext<Ctx | null>(null);

export function SaveStatusProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SaveState>({ status: 'idle', at: null, message: null, retry: null });
  const pending = useRef(0);
  const track = useCallback(async <T,>(fn: () => Promise<T>, retry?: () => void): Promise<T> => {
    pending.current++;
    setState((s) => ({ ...s, status: 'saving', message: null, retry: null }));
    try {
      const out = await fn();
      pending.current--;
      if (pending.current === 0) setState({ status: 'saved', at: new Date().toISOString(), message: null, retry: null });
      return out;
    } catch (err) {
      pending.current--;
      setState({ status: 'error', at: null, message: err instanceof Error ? err.message : String(err), retry: retry ?? null });
      throw err;
    }
  }, []);
  const markDirty = useCallback(() => setState((s) => (s.status === 'saving' ? s : { ...s, status: 'saving' })), []);
  const value = useMemo(() => ({ state, track, markDirty }), [state, track, markDirty]);
  return <SaveContext.Provider value={value}>{children}</SaveContext.Provider>;
}

export function useSaveStatus(): Ctx {
  const ctx = useContext(SaveContext);
  if (!ctx) throw new Error('SaveStatusProvider missing');
  return ctx;
}
