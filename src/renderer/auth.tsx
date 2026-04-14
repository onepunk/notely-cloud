import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';

import type { PreloadApi } from '../preload';

declare global {
  interface Window {
    api: PreloadApi;
  }
}

type Message = { type: 'info' | 'error' | 'success'; text: string };

const containerStyle: React.CSSProperties = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background:
    'radial-gradient(circle at top left, rgba(67, 190, 180, 0.12), transparent 50%), radial-gradient(circle at bottom right, rgba(20, 68, 115, 0.1), transparent 55%)',
  fontFamily:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Inter', 'Helvetica Neue', Helvetica, Arial, sans-serif",
  color: '#0b1f34',
  padding: '32px 16px',
  boxSizing: 'border-box',
};

const panelStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 420,
  backgroundColor: '#ffffff',
  boxShadow: '0 18px 50px rgba(16, 41, 53, 0.12)',
  borderRadius: 16,
  padding: '32px 36px',
  boxSizing: 'border-box',
};

const headerStyle: React.CSSProperties = {
  textAlign: 'center',
  marginBottom: 24,
};

const titleStyle: React.CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  marginBottom: 4,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 14,
  color: '#4a5b73',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  borderRadius: 10,
  border: '1px solid rgba(15, 53, 93, 0.18)',
  fontSize: 15,
  marginBottom: 14,
  outline: 'none',
  transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
};

const buttonStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 16px',
  borderRadius: 10,
  fontSize: 15,
  fontWeight: 600,
  border: 'none',
  cursor: 'pointer',
  transition: 'transform 0.12s ease, box-shadow 0.12s ease',
};

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: '#13445d',
  color: '#ffffff',
  marginBottom: 12,
  boxShadow: '0 12px 24px rgba(19, 68, 93, 0.18)',
};

const secondaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  backgroundColor: '#ffffff',
  color: '#13445d',
  border: '1px solid rgba(19, 68, 93, 0.18)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 10,
};

const dividerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  margin: '20px 0',
  color: '#6a7a90',
  fontSize: 13,
  textTransform: 'uppercase',
  letterSpacing: 1,
};

const messageStyle = (type: Message['type']): React.CSSProperties => {
  const palette: Record<Message['type'], { bg: string; border: string; color: string }> = {
    info: {
      bg: 'rgba(19, 68, 93, 0.08)',
      border: 'rgba(19, 68, 93, 0.24)',
      color: '#13445d',
    },
    success: {
      bg: 'rgba(46, 125, 50, 0.08)',
      border: 'rgba(46, 125, 50, 0.24)',
      color: '#2e7d32',
    },
    error: {
      bg: 'rgba(198, 40, 40, 0.1)',
      border: 'rgba(198, 40, 40, 0.3)',
      color: '#c62828',
    },
  };

  const paletteEntry = palette[type];

  return {
    padding: '12px 14px',
    borderRadius: 10,
    border: `1px solid ${paletteEntry.border}`,
    backgroundColor: paletteEntry.bg,
    color: paletteEntry.color,
    fontSize: 14,
    marginBottom: 16,
  };
};

const iconGridStyle: React.CSSProperties = {
  display: 'inline-grid',
  gridTemplateColumns: 'repeat(2, 8px)',
  gridTemplateRows: 'repeat(2, 8px)',
  gap: '3px',
};

const iconSquareStyle = (color: string): React.CSSProperties => ({
  width: 8,
  height: 8,
  backgroundColor: color,
  borderRadius: 2,
});

const fieldHintStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#6b7a8f',
  marginBottom: 18,
};

const footerStyle: React.CSSProperties = {
  marginTop: 24,
  fontSize: 12,
  color: '#6b7a8f',
  textAlign: 'center',
  lineHeight: 1.4,
};

function SignInPopup(): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<Message | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [microsoftPending, setMicrosoftPending] = useState(false);
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    // Phase 3: Read server URL from settings instead of sync config
    // This removes auth dependency on sync configuration
    window.api.settings
      .get('auth.serverUrl')
      .then((url) => {
        if (!mounted) return;
        setServerUrl(url || null);
      })
      .catch(() => {
        if (!mounted) return;
        setServerUrl(null);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const busy = useMemo(() => submitting || microsoftPending, [submitting, microsoftPending]);

  const handlePasswordSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;

    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setMessage({ type: 'error', text: 'Email address and password are required.' });
      return;
    }

    setSubmitting(true);
    setMessage({ type: 'info', text: 'Signing in with credentials…' });

    try {
      const result = await window.api.auth.passwordLogin(trimmedEmail, password);
      if (!result?.success) {
        setMessage({
          type: 'error',
          text: result?.error || 'Sign-in failed. Please verify your credentials and try again.',
        });
        setSubmitting(false);
      } else {
        setMessage({
          type: 'success',
          text: 'Signed in successfully. This window will close automatically.',
        });
      }
    } catch (error) {
      console.error('[AUTH WINDOW] Credential sign-in error', error);
      setMessage({
        type: 'error',
        text: 'Could not complete sign-in. Please check your connection and try again.',
      });
      setSubmitting(false);
    }
  };

  const handleMicrosoftSignIn = async () => {
    if (busy) return;

    setMicrosoftPending(true);
    setMessage({
      type: 'info',
      text: 'Opening Microsoft sign-in… complete the flow in the redirected window.',
    });

    try {
      const result = await window.api.auth.beginMicrosoftLogin();
      if (!result?.success) {
        setMicrosoftPending(false);
        setMessage({
          type: 'error',
          text: result?.error || 'Could not open Microsoft sign-in. Please try again.',
        });
      } else {
        setMessage({
          type: 'info',
          text: 'Continue in the Microsoft sign-in screen. This window will close once authentication completes.',
        });
      }
    } catch (error) {
      console.error('[AUTH WINDOW] Microsoft sign-in error', error);
      setMicrosoftPending(false);
      setMessage({
        type: 'error',
        text: 'Could not open Microsoft sign-in. Please try again.',
      });
    }
  };

  return (
    <div style={containerStyle}>
      <div style={panelStyle}>
        <header style={headerStyle}>
          <div
            style={{
              width: 60,
              height: 60,
              borderRadius: '50%',
              background: 'linear-gradient(135deg, rgba(19,68,93,0.9), rgba(49,130,142,0.9))',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontWeight: 700,
              fontSize: 22,
              margin: '0 auto 18px',
            }}
          >
            N
          </div>
          <div style={titleStyle}>Sign in to Notely</div>
          <div style={subtitleStyle}>
            {serverUrl ? `Server: ${serverUrl}` : 'Select your Notely account to continue'}
          </div>
        </header>

        {message && <div style={messageStyle(message.type)}>{message.text}</div>}

        <form onSubmit={handlePasswordSubmit} style={{ marginBottom: 4 }}>
          <input
            style={inputStyle}
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={busy}
          />
          <input
            style={{ ...inputStyle, marginBottom: 8 }}
            type="password"
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            disabled={busy}
          />
          <div style={fieldHintStyle}>
            Use this option if your organization manages credentials directly in Notely.
          </div>
          <button
            type="submit"
            style={{
              ...primaryButtonStyle,
              opacity: submitting ? 0.75 : 1,
              cursor: submitting ? 'wait' : 'pointer',
            }}
            disabled={busy}
          >
            {submitting ? 'Signing in…' : 'Sign in with password'}
          </button>
        </form>

        <div style={dividerStyle}>
          <span style={{ flex: 1, height: 1, backgroundColor: 'rgba(12, 39, 66, 0.15)' }} />
          <span style={{ padding: '0 10px' }}>or continue with</span>
          <span style={{ flex: 1, height: 1, backgroundColor: 'rgba(12, 39, 66, 0.15)' }} />
        </div>

        <button
          type="button"
          style={{
            ...secondaryButtonStyle,
            opacity: microsoftPending ? 0.8 : 1,
            cursor: microsoftPending ? 'wait' : 'pointer',
          }}
          onClick={handleMicrosoftSignIn}
          disabled={busy}
        >
          <span style={iconGridStyle}>
            <span style={iconSquareStyle('#F35325')} />
            <span style={iconSquareStyle('#81BC06')} />
            <span style={iconSquareStyle('#05A6F0')} />
            <span style={iconSquareStyle('#FFBA08')} />
          </span>
          {microsoftPending ? 'Redirecting to Microsoft…' : 'Sign in with Microsoft'}
        </button>

        <p style={footerStyle}>
          Close this window at any time to cancel sign-in. You can re-open it from the desktop app
          settings panel.
        </p>
      </div>
    </div>
  );
}

const rootElement = document.querySelector('#auth-root');

if (rootElement) {
  const root = createRoot(rootElement);
  root.render(
    <StrictMode>
      <SignInPopup />
    </StrictMode>
  );
}
