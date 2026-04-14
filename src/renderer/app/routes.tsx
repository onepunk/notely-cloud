import * as React from 'react';
import { Suspense, lazy, useEffect, useRef } from 'react';
import { Routes, Route, Navigate, Outlet, useNavigate } from 'react-router-dom';

import { SettingsModal } from '../features/settings/modal/SettingsModal';
import { log } from '../shared/log';

import { AppLayout } from './layout/AppLayout';

const WorkspacePage = lazy(() => import('./pages/WorkspacePage'));
const CalendarPage = lazy(() => import('./pages/CalendarPage'));

/**
 * Stable layout wrapper for all workspace routes.
 *
 * By rendering WorkspacePage inside a single layout Route that wraps all
 * workspace path patterns, React Router keeps this component mounted when
 * the user navigates between e.g. `/binders/:id` and
 * `/binders/:id/notes/:noteId`. Without this, each path is a separate
 * Route element and React Router unmounts/remounts the entire tree on
 * navigation — destroying the Editor and losing focus.
 */
function WorkspaceLayout() {
  return (
    <Suspense fallback={null}>
      <WorkspacePage />
    </Suspense>
  );
}

export default function RoutesView() {
  const navigate = useNavigate();
  const bridgeAvailable =
    typeof window !== 'undefined' && (window as Window & { api?: unknown }).api;
  const initRef = useRef(false);
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    log.info('Renderer bootstrap start');
    if (bridgeAvailable) {
      window.api.rendererReady();
      window.api.onDeepLink((route) => {
        log.info('Deep link received', { route });
        navigate(route);
      });
    }
  }, [navigate, bridgeAvailable]);

  if (!bridgeAvailable) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, Segoe UI, Arial' }}>
        <h2>Notely (Renderer)</h2>
        <p>The Electron bridge is not available. For full functionality, run Electron:</p>
        <pre>npm run dev (dev server) and npm start (Electron)</pre>
      </div>
    );
  }

  return (
    <>
      <Routes>
        <Route element={<AppLayout />}>
          {/* All workspace paths share a single layout so WorkspacePage
              stays mounted across navigation (draft→saved, sidebar clicks, etc.) */}
          <Route element={<WorkspaceLayout />}>
            <Route index />
            <Route path="notes/:noteId" />
            <Route path="binders/:binderId" />
            <Route path="binders/:binderId/notes/:noteId" />
          </Route>
          <Route
            path="calendar"
            element={
              <Suspense fallback={null}>
                <CalendarPage />
              </Suspense>
            }
          />
          <Route path="settings/:section?" element={<SettingsModal />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </>
  );
}
