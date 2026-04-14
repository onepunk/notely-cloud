type Level = 'error' | 'warn' | 'info' | 'debug';

function forward(level: Level, message: string, meta?: Record<string, unknown>) {
  try {
    if (level === 'error') window.api.log.error(message, meta);
    else if (level === 'warn') window.api.log.warn(message, meta);
    else if (level === 'info') window.api.log.info(message, meta);
    else window.api.log.debug(message, meta);
  } catch (err) {
    // swallow logging bridge errors in renderer
  }
}

export const log = {
  setLevel(level: 'error'|'warn'|'info'|'http'|'verbose'|'debug'|'silly') {
    try { window.api.log.setLevel(level); } catch (error) { console.warn('Failed to set log level:', error); }
  },
  info(message: string, meta?: Record<string, unknown>) {
    forward('info', message, meta);
    console.info(message, meta ?? '');
  },
  warn(message: string, meta?: Record<string, unknown>) {
    forward('warn', message, meta);
    console.warn(message, meta ?? '');
  },
  error(message: string, meta?: Record<string, unknown>) {
    forward('error', message, meta);
    console.error(message, meta ?? '');
  },
  debug(message: string, meta?: Record<string, unknown>) {
    forward('debug', message, meta);
    console.debug(message, meta ?? '');
  }
};


