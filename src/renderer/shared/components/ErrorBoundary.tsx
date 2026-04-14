/**
 * Global Error Boundary Component
 *
 * Catches unhandled React errors and prevents the entire app from crashing.
 * Logs errors with correlation IDs and displays a user-friendly fallback UI.
 */

import * as React from 'react';

import { ERROR_CODES } from '@common/errors';
import { reportError } from '@shared/error';

interface ErrorBoundaryState {
  hasError: boolean;
  errorCode: string | null;
}

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, errorCode: null };
  }

  static getDerivedStateFromError(_error: Error): ErrorBoundaryState {
    return { hasError: true, errorCode: 'E8001' };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log error with full context
    reportError(error, 'E8001', {
      componentStack: errorInfo.componentStack,
      errorBoundary: true,
    });
  }

  handleReload = (): void => {
    window.location.reload();
  };

  handleReset = (): void => {
    this.setState({ hasError: false, errorCode: null });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100vh',
            padding: '24px',
            textAlign: 'center',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            backgroundColor: 'var(--colorNeutralBackground1, #fafafa)',
            color: 'var(--colorNeutralForeground1, #242424)',
          }}
        >
          <div
            style={{
              maxWidth: '400px',
              padding: '32px',
              borderRadius: '8px',
              backgroundColor: 'var(--colorNeutralBackground2, #fff)',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
            }}
          >
            <h1
              style={{
                fontSize: '20px',
                fontWeight: 600,
                marginBottom: '12px',
              }}
            >
              Something went wrong
            </h1>
            <p
              style={{
                fontSize: '14px',
                color: 'var(--colorNeutralForeground2, #616161)',
                marginBottom: '8px',
              }}
            >
              {ERROR_CODES.E8001.message}
            </p>
            <p
              style={{
                fontSize: '12px',
                color: 'var(--colorNeutralForeground3, #8a8a8a)',
                marginBottom: '24px',
              }}
            >
              Error code: {this.state.errorCode}
            </p>
            <div
              style={{
                display: 'flex',
                gap: '12px',
                justifyContent: 'center',
              }}
            >
              <button
                onClick={this.handleReset}
                style={{
                  padding: '8px 16px',
                  fontSize: '14px',
                  borderRadius: '4px',
                  border: '1px solid var(--colorNeutralStroke1, #d1d1d1)',
                  backgroundColor: 'transparent',
                  cursor: 'pointer',
                }}
              >
                Try Again
              </button>
              <button
                onClick={this.handleReload}
                style={{
                  padding: '8px 16px',
                  fontSize: '14px',
                  borderRadius: '4px',
                  border: 'none',
                  backgroundColor: 'var(--colorBrandBackground, #0078d4)',
                  color: 'white',
                  cursor: 'pointer',
                }}
              >
                Reload App
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
