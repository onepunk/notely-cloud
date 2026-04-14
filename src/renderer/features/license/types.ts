export type LicenseState = 'active' | 'expiring' | 'expired' | 'invalid' | 'unlicensed';

export type LicenseTier = 'public' | 'custom' | 'unknown'; // Legacy type based on license_type

export type LicenseTierKey = 'free' | 'starter' | 'professional' | 'enterprise' | 'unknown'; // Actual pricing tier

export type LicenseValidationMode = 'online' | 'offline' | 'unknown';

export type LicenseGrantType = 'purchase' | 'beta' | 'trial' | 'promotional' | 'admin_grant'; // How license was acquired

export interface LicenseSummary {
  status: LicenseState;
  type: LicenseTier; // Legacy: 'public' or 'custom'
  tierKey: LicenseTierKey; // Actual tier: 'free', 'starter', 'professional', 'enterprise'
  tierName: string; // Display name: 'Free', 'Starter', 'Professional', 'Enterprise'
  grantType?: LicenseGrantType; // How the license was acquired
  isBeta?: boolean; // Convenience flag for beta licenses
  validationMode: LicenseValidationMode;
  expiresAt: string | null;
  lastValidatedAt: string | null;
  nextValidationAt: string | null;
  daysRemaining: number | null;
  features: string[];
  issuedTo: string | null;
  statusMessage: string | null;
}
