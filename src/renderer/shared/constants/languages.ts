/**
 * Supported transcription languages configuration.
 * This is the single source of truth for language options across the application.
 */
export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English', enabled: true },
  { code: 'es', name: 'Español', enabled: false },
  { code: 'fr', name: 'Français', enabled: false },
  { code: 'de', name: 'Deutsch', enabled: false },
  { code: 'ja', name: '日本語', enabled: false },
] as const;

/**
 * Type-safe language code derived from SUPPORTED_LANGUAGES
 */
export type LanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

/**
 * Returns only languages that are currently enabled for use
 */
export const getEnabledLanguages = () => SUPPORTED_LANGUAGES.filter((lang) => lang.enabled);

/**
 * Get language name by code
 */
export const getLanguageName = (code: string): string => {
  const lang = SUPPORTED_LANGUAGES.find((l) => l.code === code);
  return lang?.name || code;
};
