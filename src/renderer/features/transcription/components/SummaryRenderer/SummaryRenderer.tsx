/**
 * SummaryRenderer - Flexible, future-proof summary rendering component
 *
 * Architecture:
 * - Detects known schemas and renders with optimized components
 * - Falls back to generic JSON rendering for unknown schemas
 * - Designed for extensibility with custom user templates
 */

import * as React from 'react';

import { SummaryData, isStructuredSummaryV1, StructuredSummaryV1 } from '../../types/summary';

import { GenericJsonRenderer } from './GenericJsonRenderer';
import { StructuredSummaryV1Renderer } from './StructuredSummaryV1Renderer';
import styles from './SummaryRenderer.module.css';
import { SummaryTextRenderer } from './SummaryTextRenderer';

export interface SummaryRendererProps {
  /** The summary data to render (can be any schema) */
  data: SummaryData | string | null;
  /** Optional template ID for custom rendering configs */
  templateId?: string;
  /** Show section headers */
  showHeaders?: boolean;
  /** Compact mode for smaller displays */
  compact?: boolean;
  /** Callback when an action item is clicked */
  onActionItemClick?: (item: { text: string; owner?: string | null }) => void;
  /** Callback when an action item checkbox is toggled */
  onActionItemToggle?: (index: number, completed: boolean) => void;
  /** Callback when a participant is clicked */
  onParticipantClick?: (participant: string) => void;
  /** Custom class name */
  className?: string;
}

/**
 * Main entry point for rendering summaries
 * Automatically detects schema and uses appropriate renderer
 */
export const SummaryRenderer: React.FC<SummaryRendererProps> = ({
  data,
  // templateId - reserved for future custom template support
  showHeaders = true,
  compact = false,
  onActionItemClick,
  onActionItemToggle,
  onParticipantClick,
  className,
}) => {
  // Parse string data to object (useMemo must be called unconditionally)
  const parsedData = React.useMemo(() => {
    if (!data) return null;
    if (typeof data === 'string') {
      try {
        return JSON.parse(data);
      } catch {
        return { _rawText: data };
      }
    }
    return data;
  }, [data]);

  // Handle null/undefined
  if (!parsedData) {
    return <div className={`${styles.empty} ${className || ''}`}>No summary data available</div>;
  }

  // Check if this is raw text that couldn't be parsed — render with SummaryTextRenderer
  // instead of displaying raw markdown literally
  if (parsedData._rawText) {
    return <SummaryTextRenderer text={parsedData._rawText} className={className} />;
  }

  // Detect schema and render appropriately
  if (isStructuredSummaryV1(parsedData)) {
    return (
      <StructuredSummaryV1Renderer
        data={parsedData as StructuredSummaryV1}
        showHeaders={showHeaders}
        compact={compact}
        onActionItemClick={onActionItemClick}
        onActionItemToggle={onActionItemToggle}
        onParticipantClick={onParticipantClick}
        className={className}
      />
    );
  }

  // Future: Add more schema detectors here for custom templates

  // Fallback to generic JSON renderer for unknown schemas
  return (
    <GenericJsonRenderer
      data={parsedData}
      showHeaders={showHeaders}
      compact={compact}
      className={className}
    />
  );
};

export default SummaryRenderer;
