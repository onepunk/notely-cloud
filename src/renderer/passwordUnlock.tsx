import * as React from 'react';
import { createRoot } from 'react-dom/client';

import { PasswordUnlockPopup } from './features/passwordUnlock/PasswordUnlockPopup';
import './shared/styles/app.css';

function bootstrap(): void {
  const mountNode =
    document.querySelector('#password-unlock-root') ||
    (() => {
      const el = document.createElement('div');
      el.id = 'password-unlock-root';
      document.body.appendChild(el);
      return el;
    })();

  const root = createRoot(mountNode);
  root.render(
    <React.StrictMode>
      <PasswordUnlockPopup />
    </React.StrictMode>
  );

  if (
    import.meta &&
    (import.meta as { hot?: { accept: () => void; dispose: (cb: () => void) => void } }).hot
  ) {
    (
      import.meta as unknown as { hot: { accept: () => void; dispose: (cb: () => void) => void } }
    ).hot.accept();
    (
      import.meta as unknown as { hot: { accept: () => void; dispose: (cb: () => void) => void } }
    ).hot.dispose(() => {
      try {
        root.unmount();
      } catch {
        /* ignore errors during HMR */
      }
    });
  }
}

bootstrap();
