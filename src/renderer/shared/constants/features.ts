/**
 * Known feature flags that can be enabled via licenses.
 * This file should be kept in sync with the main process feature flags.
 *
 * Add new features here as they are implemented.
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
 * Human-readable feature names for UI display.
 */
export const FeatureNames: Record<FeatureKey, string> = {
  [KnownFeatures.AI_SUMMARY]: 'AI Summary',
  [KnownFeatures.ADVANCED_SEARCH]: 'Advanced Search',
  [KnownFeatures.TEAM_SHARING]: 'Team Sharing',
  [KnownFeatures.CUSTOM_TEMPLATES]: 'Custom Templates',
  [KnownFeatures.PRIORITY_SUPPORT]: 'Priority Support',
  [KnownFeatures.CALENDAR_INTEGRATION]: 'Calendar Integration',
  [KnownFeatures.OFFLINE_MODE]: 'Offline Mode',
  [KnownFeatures.EXPORT_FORMATS]: 'Export Formats',
};

/**
 * Feature descriptions for upgrade prompts and tooltips.
 */
export const FeatureDescriptions: Record<FeatureKey, string> = {
  [KnownFeatures.AI_SUMMARY]:
    'Automatically generate intelligent summaries of your transcriptions and notes.',
  [KnownFeatures.ADVANCED_SEARCH]:
    'Search across all your notes with advanced filters and boolean operators.',
  [KnownFeatures.TEAM_SHARING]: 'Share notes and binders with your team members.',
  [KnownFeatures.CUSTOM_TEMPLATES]: 'Create and use custom templates for consistent note-taking.',
  [KnownFeatures.PRIORITY_SUPPORT]:
    'Get priority support with faster response times and dedicated assistance.',
  [KnownFeatures.CALENDAR_INTEGRATION]:
    'Integrate with your calendar to automatically create meeting notes.',
  [KnownFeatures.OFFLINE_MODE]: 'Work offline with full access to all your notes and features.',
  [KnownFeatures.EXPORT_FORMATS]: 'Export your notes to PDF, Word, Markdown, and more.',
};
