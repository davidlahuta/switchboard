import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RepoDetail, StateSnapshot, UiFrame } from '@shared/types.ts';
import { ApiError, request, wsUrl } from './api.ts';
import { emitToast } from './toast.ts';

export type ConnState = 'connecting' | 'open' | 'closed';

interface StoreValue {
  state: StateSnapshot | null;
  loadError: string | null;
  conn: ConnState;
  refresh: () => Promise<void>;
  /** Register interest in a repo; returns its detail (auto-refreshed on `repo:<id>` invalidations). */
  repoDetail: RepoDetail | null;
  repoDetailId: string | null;
  setOpenRepo: (id: string | null) => void;
  refreshRepo: () => Promise<void>;
}

const StoreContext = createContext<StoreValue | null>(null);

export function useStore(): StoreValue {
  const v = useContext(StoreContext);
  if (!v) throw new Error('useStore outside StoreProvider');
  return v;
}

/** Convenience for pages that require a loaded snapshot. */
export function useSnapshot(): StateSnapshot | null {
  return useStore().state;
}

const DEBOUNCE_MS = 150;

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<StateSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conn, setConn] = useState<ConnState>('connecting');
  const [openRepo, setOpenRepoState] = useState<string | null>(null);
  const [repoDetail, setRepoDetail] = useState<RepoDetail | null>(null);
  const [repoDetailId, setRepoDetailId] = useState<string | null>(null);

  const openRepoRef = useRef<string | null>(null);
  const timers = useRef<{ state?: number; repo?: number }>({});

  const refresh = useCallback(async () => {
    try {
      const s = await request<StateSnapshot>('GET', '/api/state');
      setState(s);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshRepo = useCallback(async () => {
    const id = openRepoRef.current;
    if (!id) return;
    try {
      const d = await request<RepoDetail>('GET', `/api/repos/${encodeURIComponent(id)}`);
      if (openRepoRef.current === id) {
        setRepoDetail(d);
        setRepoDetailId(id);
      }
    } catch (e) {
      if (openRepoRef.current !== id) return;
      if (e instanceof ApiError && e.status === 404) {
        setRepoDetail(null);
        setRepoDetailId(id);
      }
      emitToast('error', e instanceof Error ? e.message : String(e));
    }
  }, []);

  const setOpenRepo = useCallback(
    (id: string | null) => {
      openRepoRef.current = id;
      setOpenRepoState(id);
      if (!id) {
        setRepoDetail(null);
        setRepoDetailId(null);
      }
    },
    [],
  );

  useEffect(() => {
    if (openRepo) void refreshRepo();
  }, [openRepo, refreshRepo]);

  const scheduleState = useCallback(() => {
    window.clearTimeout(timers.current.state);
    timers.current.state = window.setTimeout(() => void refresh(), DEBOUNCE_MS);
  }, [refresh]);

  const scheduleRepo = useCallback(() => {
    window.clearTimeout(timers.current.repo);
    timers.current.repo = window.setTimeout(() => void refreshRepo(), DEBOUNCE_MS);
  }, [refreshRepo]);

  // Initial load
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // /ws/ui with auto-reconnect + backoff
  useEffect(() => {
    let ws: WebSocket | null = null;
    let disposed = false;
    let attempt = 0;
    let retryTimer = 0;

    const connect = () => {
      if (disposed) return;
      setConn('connecting');
      ws = new WebSocket(wsUrl('/ws/ui'));
      ws.onopen = () => {
        const wasReconnect = attempt > 0;
        attempt = 0;
        setConn('open');
        // Anything may have changed while disconnected.
        if (wasReconnect) {
          void refresh();
          if (openRepoRef.current) void refreshRepo();
        }
      };
      ws.onmessage = (ev) => {
        let frame: UiFrame;
        try {
          frame = JSON.parse(String(ev.data)) as UiFrame;
        } catch {
          return;
        }
        if (frame.type === 'invalidate') {
          for (const scope of frame.scopes) {
            if (scope === 'state') scheduleState();
            else if (scope.startsWith('repo:') && scope.slice(5) === openRepoRef.current) scheduleRepo();
          }
        } else if (frame.type === 'toast') {
          emitToast(frame.level, frame.text);
        }
      };
      ws.onclose = () => {
        ws = null;
        if (disposed) return;
        setConn('closed');
        attempt++;
        const delay = Math.min(15_000, 500 * 2 ** Math.min(attempt, 5)) + Math.random() * 300;
        retryTimer = window.setTimeout(connect, delay);
      };
      ws.onerror = () => {
        ws?.close();
      };
    };
    connect();

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !ws && !disposed) {
        window.clearTimeout(retryTimer);
        attempt = 0;
        connect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      disposed = true;
      window.clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisible);
      ws?.close();
    };
  }, [refresh, refreshRepo, scheduleRepo, scheduleState]);

  const value = useMemo<StoreValue>(
    () => ({
      state,
      loadError,
      conn,
      refresh,
      repoDetail: repoDetailId === openRepo ? repoDetail : null,
      repoDetailId,
      setOpenRepo,
      refreshRepo,
    }),
    [state, loadError, conn, refresh, repoDetail, repoDetailId, openRepo, setOpenRepo, refreshRepo],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}
