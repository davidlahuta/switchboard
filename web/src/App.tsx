import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import type { AuthStatus } from '@shared/types.ts';
import { request, UNAUTHORIZED_EVENT } from './lib/api.ts';
import { useRoute, type Route } from './lib/router.ts';
import { StoreProvider, useStore } from './lib/store.tsx';
import { Layout } from './components/Layout.tsx';
import { Toasts } from './components/Toasts.tsx';
import { Empty, Spinner } from './components/ui.tsx';
import { Overview } from './pages/Overview.tsx';
import { RepoDetailPage } from './pages/RepoDetail.tsx';
import { Sessions } from './pages/Sessions.tsx';
import { Subscriptions } from './pages/Subscriptions.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { PairPage } from './pages/Pair.tsx';

const TerminalPage = lazy(() => import('./pages/Terminal.tsx'));

type AuthState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; status: AuthStatus };

export function App() {
  const route = useRoute();
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' });

  const checkAuth = useCallback(async () => {
    try {
      const status = await request<AuthStatus>('GET', '/api/auth/status');
      setAuth({ kind: 'ok', status });
    } catch (e) {
      setAuth({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  useEffect(() => {
    void checkAuth();
    const onUnauthorized = () => void checkAuth();
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [checkAuth]);

  let body;
  if (auth.kind === 'loading') {
    body = (
      <div className="center-screen">
        <Spinner />
      </div>
    );
  } else if (auth.kind === 'error') {
    body = (
      <div className="center-screen">
        <div className="panel narrow">
          <h1 className="h1">Can't reach Switchboard</h1>
          <p className="muted">{auth.message}. Is the daemon running on this machine?</p>
          <button type="button" className="btn btn-primary" onClick={() => void checkAuth()}>
            Retry
          </button>
        </div>
      </div>
    );
  } else if (!auth.status.local && !auth.status.paired) {
    body = <PairPage initialCode={route.name === 'pair' ? route.code : null} onPaired={(s) => setAuth({ kind: 'ok', status: s })} />;
  } else {
    body = (
      <StoreProvider>
        <Routed route={route} auth={auth.status} />
      </StoreProvider>
    );
  }

  return (
    <>
      {body}
      <Toasts />
    </>
  );
}

function Routed({ route, auth }: { route: Route; auth: AuthStatus }) {
  const { state, loadError, refresh } = useStore();

  if (route.name === 'pair') {
    return (
      <Layout route={route}>
        <div className="panel narrow">
          <h1 className="h1">{auth.local ? 'This is the desk' : 'Device paired'}</h1>
          <p className="muted">
            {auth.local
              ? 'Pairing links are meant to be opened on another device (phone, laptop) through Tailscale.'
              : `This browser is paired${auth.deviceName ? ` as “${auth.deviceName}”` : ''}.`}
          </p>
          <a className="btn btn-primary" href="#/">
            Go to overview
          </a>
        </div>
      </Layout>
    );
  }

  if (!state) {
    return (
      <Layout route={route} bare={route.name === 'terminal'}>
        <div className="center-screen">
          {loadError ? (
            <div className="panel narrow">
              <h1 className="h1">Couldn't load state</h1>
              <p className="muted">{loadError}</p>
              <button type="button" className="btn btn-primary" onClick={() => void refresh()}>
                Retry
              </button>
            </div>
          ) : (
            <Spinner />
          )}
        </div>
      </Layout>
    );
  }

  switch (route.name) {
    case 'overview':
      return (
        <Layout route={route}>
          <Overview state={state} />
        </Layout>
      );
    case 'repo':
      return (
        <Layout route={route}>
          <RepoDetailPage key={route.id} repoId={route.id} state={state} />
        </Layout>
      );
    case 'sessions':
      return (
        <Layout route={route}>
          <Sessions state={state} />
        </Layout>
      );
    case 'terminal':
      return (
        <Layout route={route} bare>
          <Suspense
            fallback={
              <div className="center-screen">
                <Spinner />
              </div>
            }
          >
            <TerminalPage key={route.runId} runId={route.runId} state={state} />
          </Suspense>
        </Layout>
      );
    case 'subscriptions':
      return (
        <Layout route={route}>
          <Subscriptions state={state} />
        </Layout>
      );
    case 'settings':
      return (
        <Layout route={route}>
          <SettingsPage state={state} />
        </Layout>
      );
    case 'notfound':
      return (
        <Layout route={route}>
          <Empty icon="warn">
            Nothing at <span className="mono">{route.path}</span>. <a href="#/">Back to overview</a>
          </Empty>
        </Layout>
      );
  }
}
