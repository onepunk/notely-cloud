/**
 * AppWithSetup - Wrapper component that handles component download setup
 *
 * Checks if required components (audio-engine, model) are downloaded.
 * Shows SetupScreen if components need to be downloaded before rendering the main app.
 */

import * as React from 'react';

import { SetupScreen } from '../features/setup';

interface AppWithSetupProps {
  children: React.ReactNode;
}

/**
 * AppWithSetup ensures required components are downloaded before showing the main app
 */
export function AppWithSetup({ children }: AppWithSetupProps): JSX.Element {
  const [componentsReady, setComponentsReady] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    const checkComponents = async () => {
      // Check if components API is available
      if (!window.api?.components) {
        // If no components API, assume components are bundled (development mode or legacy build)
        setComponentsReady(true);
        return;
      }

      try {
        // Check if all components are ready
        const ready = await window.api.components.areAllReady();
        setComponentsReady(ready);

        // If not ready, the SetupScreen will handle downloads
        // The onAllReady event will trigger once downloads complete
        if (!ready) {
          const unsubscribe = window.api.components.onAllReady(() => {
            setComponentsReady(true);
            unsubscribe();
          });
        }
      } catch (error) {
        window.api?.log?.error?.('Failed to check component status', {
          error: error instanceof Error ? error.message : error,
        });
        // On error, show the setup screen - it will handle the error state
        setComponentsReady(false);
      }
    };

    void checkComponents();
  }, []);

  // Still checking - show loading
  if (componentsReady === null) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div
            style={{
              width: 32,
              height: 32,
              border: '3px solid #e0e0e0',
              borderTopColor: '#0078d4',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
              margin: '0 auto 1rem',
            }}
          />
          <p style={{ margin: 0, color: '#616161' }}>Loading...</p>
        </div>
        <style>{`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  // Components not ready - show setup screen
  if (!componentsReady) {
    return <SetupScreen onReady={() => setComponentsReady(true)} />;
  }

  // Components ready - render main app
  return <>{children}</>;
}

export default AppWithSetup;
