import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import * as winston from 'winston';
import DailyRotate from 'winston-daily-rotate-file';

export type LogLevel = 'error' | 'warn' | 'info' | 'http' | 'verbose' | 'debug' | 'silly';

/**
 * Patterns for sensitive data that should be redacted from logs
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // JWT tokens (access tokens, refresh tokens)
  {
    pattern: /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: '[REDACTED_JWT]',
  },
  // Access token previews
  { pattern: /"accessTokenPreview":\s*"[^"]+"/g, replacement: '"accessTokenPreview":"[REDACTED]"' },
  // User IDs (UUID format)
  { pattern: /"userId":\s*"[0-9a-f-]{36}"/gi, replacement: '"userId":"[REDACTED_USER_ID]"' },
  // Device IDs (UUID format)
  { pattern: /"deviceId":\s*"[0-9a-f-]{36}"/gi, replacement: '"deviceId":"[REDACTED_DEVICE_ID]"' },
  // Truncated device IDs in logs
  { pattern: /"deviceId":\s*"[0-9a-f-]+\.\.\."/gi, replacement: '"deviceId":"[REDACTED]"' },
  // Token lengths (can reveal token structure)
  { pattern: /"tokenLength":\s*\d+/g, replacement: '"tokenLength":[REDACTED]' },
  { pattern: /"accessTokenLength":\s*\d+/g, replacement: '"accessTokenLength":[REDACTED]' },
  // Account identifiers in keystore operations
  { pattern: /"account":\s*"auth-[^"]+"/g, replacement: '"account":"[REDACTED_ACCOUNT]"' },
];

/**
 * Sanitize log message and metadata to remove sensitive information
 */
function sanitizeLogData(data: string): string {
  let sanitized = data;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

/**
 * Winston format that sanitizes sensitive data
 */
const sanitizeFormat = winston.format((info) => {
  // Sanitize the message
  if (typeof info.message === 'string') {
    info.message = sanitizeLogData(info.message);
  }

  // Sanitize any metadata that might contain sensitive data
  for (const key of Object.keys(info)) {
    if (key !== 'level' && key !== 'message' && key !== 'timestamp') {
      const value = info[key];
      if (typeof value === 'string') {
        info[key] = sanitizeLogData(value);
      } else if (typeof value === 'object' && value !== null) {
        // Stringify, sanitize, and parse back for nested objects
        try {
          const jsonStr = JSON.stringify(value);
          const sanitizedStr = sanitizeLogData(jsonStr);
          info[key] = JSON.parse(sanitizedStr);
        } catch {
          // Keep original if JSON processing fails
        }
      }
    }
  }

  return info;
});

function ensureSecureDir(dir: string) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Ensure permissions even if directory already exists
    fs.chmodSync(dir, 0o700);
  } catch (e) {
    /* keep going */
  }
}

let fileTransportAdded = false;
let logDir = '';

const format = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  sanitizeFormat(), // Sanitize sensitive data before logging
  winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
    const base = `${timestamp} [${level}] ${message}`;
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return stack ? `${base}\n${stack}${metaStr}` : `${base}${metaStr}`;
  })
);

export const logger = winston.createLogger({
  level: process.env.NOTELY_LOG_LEVEL || (app?.isPackaged ? 'info' : 'debug'),
  format,
  transports: [
    new winston.transports.Console({
      level: process.env.NOTELY_CONSOLE_LEVEL || 'info',
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          // Include metadata for debugging (especially error details)
          const metaKeys = Object.keys(meta).filter(
            (k) => k !== 'level' && k !== 'message' && k !== 'timestamp'
          );
          const metaStr = metaKeys.length > 0 ? `\n  ${JSON.stringify(meta, null, 2)}` : '';
          return `${timestamp} [${level}] ${message}${metaStr}`;
        })
      ),
    }),
  ],
});

export function setLogLevel(level: LogLevel) {
  logger.level = level;
}

export function setupFileLogging() {
  if (fileTransportAdded) return;
  try {
    logDir = app ? path.join(app.getPath('userData'), 'logs') : path.join(process.cwd(), 'logs');
    ensureSecureDir(logDir);
    const rotate = new DailyRotate({
      dirname: logDir,
      filename: 'notely-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxFiles: '14d',
      maxSize: '10m',
      level: process.env.NOTELY_FILE_LEVEL || 'info',
      // Set restrictive file permissions for log files
      options: { mode: 0o600 },
    });
    logger.add(rotate);
    fileTransportAdded = true;
  } catch (e) {
    // keep console-only if file transport fails
  }
}

export function getLogFileDir() {
  return logDir;
}
