/**
 * Summary Data Types
 *
 * These types define the structure of AI-generated meeting summaries.
 * The architecture is designed to be flexible and future-proof:
 *
 * 1. Known schemas (like StructuredSummaryV1) have full type safety
 * 2. Unknown/custom templates fall back to generic JSON rendering
 * 3. Type guards help detect and handle different schema versions
 */

// ============================================================================
// Structured Summary V1 Schema
// ============================================================================

export interface NextStep {
  text: string;
  owner: string | null;
  due_date: string | null;
  completed?: boolean;
}

export interface TopicEntry {
  type: 'Fact' | 'Next steps' | 'Concern' | string;
  text: string;
  owner: string | null;
  due_date: string | null;
}

export interface TopicHighlight {
  title: string;
  entries: TopicEntry[];
}

/**
 * Decision can be either a simple string or an object with context
 * The LLM may return either format depending on the prompt template
 */
export interface DecisionObject {
  text: string;
  context: string | null;
}

export type Decision = string | DecisionObject;

export interface AIInsights {
  engagement: string | null;
  time_management: string | null;
  sentiment: string | null;
}

export interface SummaryMetadata {
  notes: string | null;
  [key: string]: unknown; // Allow extensibility
}

/**
 * Structured Summary V1 Schema
 * Matches the `structured_v1` prompt template output
 */
export interface StructuredSummaryV1 {
  summary: string;
  next_steps: NextStep[];
  ai_insights: AIInsights | null;
  topics_highlights: TopicHighlight[];
  decisions: Decision[];
  participants: string[];
  date: string | null;
  metadata: SummaryMetadata | null;
}

// ============================================================================
// Generic/Future Template Support
// ============================================================================

/**
 * Base interface for all summary schemas
 * Custom templates should extend or implement this pattern
 */
export interface BaseSummary {
  [key: string]: unknown;
}

/**
 * Wrapper type that can hold any summary format
 * Used by the renderer to handle both known and unknown schemas
 */
export type SummaryData = StructuredSummaryV1 | BaseSummary;

/**
 * Summary with metadata about its source template
 */
export interface SummaryWithMeta {
  data: SummaryData;
  templateId?: string;
  templateVersion?: string;
  generatedAt?: string;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Check if the data matches StructuredSummaryV1 schema
 * Made lenient to handle LLM variations - only requires summary field
 */
export function isStructuredSummaryV1(data: unknown): data is StructuredSummaryV1 {
  if (!data || typeof data !== 'object') return false;

  const obj = data as Record<string, unknown>;

  // Only require summary field to be present
  // Other fields can be arrays, null, or undefined
  const hasSummary = typeof obj.summary === 'string';

  // Check for at least one other V1-specific field to distinguish from generic objects
  const hasV1Fields =
    'next_steps' in obj ||
    'decisions' in obj ||
    'participants' in obj ||
    'topics_highlights' in obj;

  return hasSummary && hasV1Fields;
}

/**
 * Check if data has a summary field (common across templates)
 */
export function hasSummaryField(data: unknown): data is { summary: string } {
  if (!data || typeof data !== 'object') return false;
  return typeof (data as Record<string, unknown>).summary === 'string';
}

/**
 * Check if data has action items / next steps
 */
export function hasNextSteps(data: unknown): data is { next_steps: NextStep[] } {
  if (!data || typeof data !== 'object') return false;
  return Array.isArray((data as Record<string, unknown>).next_steps);
}

/**
 * Check if data has topics/highlights
 */
export function hasTopicsHighlights(
  data: unknown
): data is { topics_highlights: TopicHighlight[] } {
  if (!data || typeof data !== 'object') return false;
  return Array.isArray((data as Record<string, unknown>).topics_highlights);
}

// ============================================================================
// Renderer Configuration Types (for future custom templates)
// ============================================================================

/**
 * Configuration for how a field should be rendered
 */
export interface FieldRenderConfig {
  fieldPath: string;
  label?: string;
  icon?: string;
  renderAs: 'text' | 'list' | 'chips' | 'table' | 'timeline' | 'custom';
  emptyMessage?: string;
  hideIfEmpty?: boolean;
}

/**
 * Template render configuration
 * Future: Users can define these for custom templates
 */
export interface TemplateRenderConfig {
  templateId: string;
  templateName: string;
  sections: FieldRenderConfig[];
  customStyles?: Record<string, string>;
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Extract value at a nested path from an object
 * Used for dynamic field access in custom templates
 */
export function getNestedValue(obj: unknown, path: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;

  const keys = path.split('.');
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }

  return current;
}

/**
 * Check if a value is "empty" for display purposes
 */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string' && value.trim() === '') return true;
  if (Array.isArray(value) && value.length === 0) return true;
  if (typeof value === 'object' && Object.keys(value).length === 0) return true;
  return false;
}
