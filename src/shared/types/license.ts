/**
 * Shared TypeScript types for license-related functionality
 * Used by both main and renderer processes
 */

/**
 * License status
 */
export type LicenseStatus = 'unlicensed' | 'active' | 'expiring' | 'expired' | 'invalid';

/**
 * License tier
 */
export type LicenseTier = 'public' | 'custom' | 'unknown';

/**
 * License validation mode
 */
export type LicenseValidationMode = 'online' | 'offline';

/**
 * License payload returned to renderer
 */
export interface LicensePayload {
  status: LicenseStatus;
  type: LicenseTier;
  validationMode: LicenseValidationMode;
  expiresAt: string | null;
  lastValidatedAt: string | null;
  nextValidationAt: string | null;
  features: string[];
  issuedTo: string | null;
  statusMessage: string | null;
}

/**
 * Warning types that can be emitted
 */
export type LicenseWarningType =
  | 'cache-age-warning'
  | 'expiry-warning'
  | 'validation-overdue'
  | 'offline-mode';

/**
 * License warning event payload
 */
export interface LicenseWarning {
  type: LicenseWarningType;
  message: string;
  severity: 'info' | 'warning' | 'error';
  timestamp: string;
}

/**
 * License validation event payload
 */
export interface LicenseValidatedEvent {
  success: boolean;
  mode: LicenseValidationMode;
  timestamp: string;
  error?: string;
}

/**
 * License expiry event payload
 */
export interface LicenseExpiredEvent {
  expiresAt: string;
  timestamp: string;
  gracePeriodDays?: number;
}

/**
 * Heartbeat status information
 */
export interface HeartbeatStatus {
  isRunning: boolean;
  isPaused: boolean;
  sessionToken: string; // Masked for security
}

/**
 * Heartbeat limit exceeded event payload
 */
export interface HeartbeatLimitExceeded {
  activeSessions: number;
  sessionLimit: number;
  warnings: string[];
  timestamp: string;
}

/**
 * Feature flags changed event payload
 */
export interface FeatureFlagsChangedEvent {
  features: string[];
  timestamp: string;
}

/**
 * Known feature flags
 */
export const KnownFeatures = {
  AI_SUMMARY: 'ai-summary',
  ADVANCED_SEARCH: 'advanced-search',
  TEAM_SHARING: 'team-sharing',
  CUSTOM_TEMPLATES: 'custom-templates',
  PRIORITY_SUPPORT: 'priority-support',
  CALENDAR_INTEGRATION: 'calendar-integration',
  OFFLINE_MODE: 'offline-mode',
  EXPORT_FORMATS: 'export-formats',
} as const;

export type FeatureKey = (typeof KnownFeatures)[keyof typeof KnownFeatures];

/**
 * License snapshot included in heartbeat responses
 * Used for detecting license changes between heartbeats
 */
export interface LicenseSnapshot {
  hasLicense: boolean;
  licenseId: string | null;
  status: 'active' | 'expired' | 'revoked' | 'none';
  features: string[];
  expiresAt: string | null;
}

/**
 * Upgrade polling status for tracking fast polling during checkout flow
 */
export interface UpgradePollingStatus {
  isActive: boolean;
  startedAt: number | null;
  timeRemainingMs: number | null;
}
