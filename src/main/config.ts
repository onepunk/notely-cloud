// Development server configuration (for renderer dev server)
export const DEV_SERVER_HOST = process.env.VITE_DEV_SERVER_HOST || '127.0.0.1';
export const DEV_SERVER_PORT = Number(process.env.VITE_DEV_SERVER_PORT || 5173);
export const DEV_SERVER_URL = `http://${DEV_SERVER_HOST}:${DEV_SERVER_PORT}`;

// Re-export shared configuration utilities
export {
  SERVICE_URLS,
  getServiceUrl,
  getServiceType,
  isNotelyService,
  findServiceMatch,
  DEFAULT_CALENDAR_URL,
} from '../common/config';
export type { ServiceConfig } from '../common/config';

// Override CURRENT_ENV for main process with actual NODE_ENV detection
import { SERVICE_URLS } from '../common/config';

export const CURRENT_ENV = (
  process.env.NODE_ENV === 'production' ? 'production' : 'development'
) as keyof typeof SERVICE_URLS;
export const DEFAULT_API_URL = SERVICE_URLS[CURRENT_ENV].api;
export const DEFAULT_ADMIN_URL = SERVICE_URLS[CURRENT_ENV].admin;
