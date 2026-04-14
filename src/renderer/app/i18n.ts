import { createInstance, TFunction } from 'i18next';
import { initReactI18next } from 'react-i18next';

import de from './locales/de/translation.json';
import en from './locales/en/translation.json';
import es from './locales/es/translation.json';
import fr from './locales/fr/translation.json';

// Type-safe translations: generate types from English translation file
type TranslationResource = typeof en;

// Helper type to flatten nested keys into dot notation
type FlattenKeys<T, Prefix extends string = ''> = T extends object
  ? {
      [K in keyof T]: K extends string
        ? T[K] extends object
          ? FlattenKeys<T[K], `${Prefix}${K}.`>
          : `${Prefix}${K}`
        : never;
    }[keyof T]
  : never;

// All valid translation keys
export type TranslationKey = FlattenKeys<TranslationResource>;

// Typed translation function
export type TypedTFunction = TFunction<'translation', undefined>;

// Available locales - only include locales with actual translations
export const AVAILABLE_LOCALES = ['en', 'de', 'es', 'fr'] as const;
export type AvailableLocale = (typeof AVAILABLE_LOCALES)[number];

// Resources object with all translations
const resources = {
  en: {
    translation: en,
  },
  de: {
    translation: de,
  },
  es: {
    translation: es,
  },
  fr: {
    translation: fr,
  },
} as const;

const i18next = createInstance();

/**
 * Initialize the i18n instance.
 * @param locale - Optional locale override. Defaults to stored preference or 'en'.
 */
export async function initI18n(locale?: string): Promise<void> {
  const hasBridge = typeof window !== 'undefined' && typeof window.api !== 'undefined';
  const storedLocale = hasBridge ? await window.api.settings.get('app.locale') : null;

  // Validate that the locale is actually available
  const requestedLocale = locale || storedLocale || 'en';
  const resolved = AVAILABLE_LOCALES.includes(requestedLocale as AvailableLocale)
    ? requestedLocale
    : 'en';

  await i18next.use(initReactI18next).init({
    resources,
    lng: resolved,
    fallbackLng: 'en',
    supportedLngs: AVAILABLE_LOCALES as unknown as string[],
    interpolation: {
      escapeValue: false, // React already escapes values
    },
    // Enable pluralization
    pluralSeparator: '_',
    // Return key if translation is missing (helps with debugging)
    returnNull: false,
    returnEmptyString: false,
  });
}

/**
 * Check if a locale has translations available
 */
export function isLocaleAvailable(locale: string): locale is AvailableLocale {
  return AVAILABLE_LOCALES.includes(locale as AvailableLocale);
}

export default i18next;
