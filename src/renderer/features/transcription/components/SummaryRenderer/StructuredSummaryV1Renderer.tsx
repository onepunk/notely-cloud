/**
 * StructuredSummaryV1Renderer - Optimized renderer for V1 schema
 *
 * Renders the standard meeting summary format with:
 * - Executive summary
 * - Next steps / action items
 * - Decisions
 * - Topic highlights
 * - Participants
 */

import * as React from 'react';

import {
  StructuredSummaryV1,
  NextStep,
  TopicHighlight,
  TopicEntry,
  Decision,
  isEmptyValue,
} from '../../types/summary';

import styles from './SummaryRenderer.module.css';
import { SummaryTextRenderer } from './SummaryTextRenderer';

// Icons (using simple SVG for portability)
const Icons = {
  Summary: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M2 2h12v2H2V2zm0 4h12v2H2V6zm0 4h8v2H2v-2z" />
    </svg>
  ),
  ActionItem: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm3.5 5.5l-4 4-2-2 1-1 1 1 3-3 1 1z" />
    </svg>
  ),
  Decision: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 1l7 14H1L8 1zm0 4v4m0 2v1" />
    </svg>
  ),
  Topic: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M1 3h14v2H1V3zm2 4h10v2H3V7zm2 4h6v2H5v-2z" />
    </svg>
  ),
  Participant: () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-4 0-6 2-6 3v1h12v-1c0-1-2-3-6-3z" />
    </svg>
  ),
  Calendar: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M4 0v2H2v12h12V2h-2V0h-2v2H6V0H4zm-1 5h10v8H3V5z" />
    </svg>
  ),
  User: () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
      <path d="M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 2c-4 0-6 2-6 3v1h12v-1c0-1-2-3-6-3z" />
    </svg>
  ),
};

/**
 * Extract plain narrative text from a summary field that may contain a JSON string.
 * The LLM sometimes returns JSON (or multiple concatenated JSON objects) in the
 * summary field instead of plain text. This handles existing bad data in the DB.
 */
function extractNarrative(summary: string): string {
  if (!summary || !summary.trimStart().startsWith('{')) {
    return summary;
  }
  // Try full JSON.parse first (single valid JSON object)
  try {
    const parsed = JSON.parse(summary);
    if (parsed && typeof parsed === 'object') {
      return parsed.executive_summary || parsed.summary || parsed.title || summary;
    }
  } catch {
    // Not valid JSON — may be multiple concatenated objects, use regex fallback
  }
  // Regex extraction for executive_summary from malformed/concatenated JSON
  const execMatch = summary.match(/"executive_summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (execMatch) {
    return execMatch[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
  return summary;
}

interface StructuredSummaryV1RendererProps {
  data: StructuredSummaryV1;
  showHeaders?: boolean;
  compact?: boolean;
  onActionItemClick?: (item: { text: string; owner?: string | null }) => void;
  onActionItemToggle?: (index: number, completed: boolean) => void;
  onParticipantClick?: (participant: string) => void;
  className?: string;
}

export const StructuredSummaryV1Renderer: React.FC<StructuredSummaryV1RendererProps> = ({
  data,
  showHeaders = true,
  compact = false,
  onActionItemClick,
  onActionItemToggle,
  onParticipantClick,
  className,
}) => {
  const containerClass = `${styles.container} ${compact ? styles.compact : ''} ${className || ''}`;

  // Safely access array fields (may be null/undefined)
  const nextSteps = Array.isArray(data.next_steps) ? data.next_steps : [];
  const decisions = Array.isArray(data.decisions) ? data.decisions : [];
  const topicsHighlights = Array.isArray(data.topics_highlights) ? data.topics_highlights : [];
  const participants = Array.isArray(data.participants) ? data.participants : [];

  // Check if we have any meaningful content to display
  const hasContent =
    !isEmptyValue(data.summary) ||
    nextSteps.length > 0 ||
    decisions.length > 0 ||
    topicsHighlights.length > 0;

  if (!hasContent) {
    return (
      <div className={`${containerClass} ${styles.empty}`}>
        <p>
          No summary content available. The transcript may be too short or lack substantive content
          to summarize.
        </p>
      </div>
    );
  }

  return (
    <div className={containerClass}>
      {/* Executive Summary */}
      {!isEmptyValue(data.summary) && (
        <Section icon={<Icons.Summary />} title="Summary" showHeader={showHeaders}>
          <SummaryTextRenderer text={extractNarrative(data.summary)} />
        </Section>
      )}

      {/* Next Steps / Action Items */}
      {nextSteps.length > 0 && (
        <Section
          icon={<Icons.ActionItem />}
          title="Action Items"
          showHeader={showHeaders}
          count={nextSteps.length}
        >
          <ActionItemsList
            items={nextSteps}
            onItemClick={onActionItemClick}
            onItemToggle={onActionItemToggle}
          />
        </Section>
      )}

      {/* Decisions */}
      {decisions.length > 0 && (
        <Section
          icon={<Icons.Decision />}
          title="Decisions"
          showHeader={showHeaders}
          count={decisions.length}
        >
          <DecisionsList decisions={decisions} />
        </Section>
      )}

      {/* Topic Highlights */}
      {topicsHighlights.length > 0 && (
        <Section icon={<Icons.Topic />} title="Discussion Topics" showHeader={showHeaders}>
          <TopicsList topics={topicsHighlights} />
        </Section>
      )}

      {/* Participants - only show if names are actually present */}
      {participants.length > 0 && (
        <Section
          icon={<Icons.Participant />}
          title="Participants"
          showHeader={showHeaders}
          count={participants.length}
        >
          <ParticipantChips participants={participants} onParticipantClick={onParticipantClick} />
        </Section>
      )}

      {/* Meeting Date - only show if present */}
      {data.date && !isEmptyValue(data.date) && (
        <div className={styles.meetingDate}>
          <Icons.Calendar />
          <span>{data.date}</span>
        </div>
      )}

      {/* Metadata Notes - only show if present */}
      {data.metadata?.notes && !isEmptyValue(data.metadata.notes) && (
        <div className={styles.metadataNotes}>
          <em>{data.metadata?.notes}</em>
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Section Wrapper Component
// ============================================================================

interface SectionProps {
  icon: React.ReactNode;
  title: string;
  showHeader?: boolean;
  count?: number;
  children: React.ReactNode;
}

const Section: React.FC<SectionProps> = ({ icon, title, showHeader = true, count, children }) => (
  <div className={styles.section}>
    {showHeader && (
      <div className={styles.sectionHeader}>
        <span className={styles.sectionIcon}>{icon}</span>
        <h3 className={styles.sectionTitle}>{title}</h3>
        {count !== undefined && count > 0 && <span className={styles.sectionCount}>{count}</span>}
      </div>
    )}
    <div className={styles.sectionContent}>{children}</div>
  </div>
);

// ============================================================================
// Action Items Component
// ============================================================================

interface ActionItemsListProps {
  items: NextStep[];
  onItemClick?: (item: { text: string; owner?: string | null }) => void;
  onItemToggle?: (index: number, completed: boolean) => void;
}

const ActionItemsList: React.FC<ActionItemsListProps> = ({ items, onItemClick, onItemToggle }) => (
  <ul className={styles.actionItemsList}>
    {items.map((item, index) => (
      <li
        key={index}
        className={`${styles.actionItem} ${onItemClick ? styles.clickable : ''} ${item.completed ? styles.actionItemCompleted : ''}`}
        onClick={() => onItemClick?.({ text: item.text, owner: item.owner })}
      >
        <div
          className={styles.actionItemCheckbox}
          role="checkbox"
          aria-checked={!!item.completed}
          tabIndex={0}
          onClick={(e) => {
            e.stopPropagation();
            onItemToggle?.(index, !item.completed);
          }}
          onKeyDown={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              onItemToggle?.(index, !item.completed);
            }
          }}
        >
          <div className={`${styles.checkbox} ${item.completed ? styles.checkboxChecked : ''}`}>
            {item.completed && (
              <svg width="10" height="10" viewBox="0 0 16 16" fill="white">
                <path d="M6.5 12.5l-4-4 1.5-1.5 2.5 2.5 5.5-5.5 1.5 1.5z" />
              </svg>
            )}
          </div>
        </div>
        <div className={styles.actionItemContent}>
          <span
            className={`${styles.actionItemText} ${item.completed ? styles.actionItemTextCompleted : ''}`}
          >
            {item.text}
          </span>
          {(item.owner || item.due_date) && (
            <div className={styles.actionItemMeta}>
              {item.owner && (
                <span className={styles.actionItemOwner}>
                  <Icons.User />
                  {item.owner}
                </span>
              )}
              {item.due_date && (
                <span className={styles.actionItemDueDate}>
                  <Icons.Calendar />
                  {item.due_date}
                </span>
              )}
            </div>
          )}
        </div>
      </li>
    ))}
  </ul>
);

// ============================================================================
// Decisions Component
// ============================================================================

interface DecisionsListProps {
  decisions: Decision[];
}

/**
 * Helper to extract text from a decision (handles both string and object formats)
 */
const getDecisionText = (decision: Decision): string => {
  if (typeof decision === 'string') {
    return decision;
  }
  return decision.text;
};

/**
 * Helper to extract context from a decision object
 */
const getDecisionContext = (decision: Decision): string | null => {
  if (typeof decision === 'string') {
    return null;
  }
  return decision.context;
};

const DecisionsList: React.FC<DecisionsListProps> = ({ decisions }) => (
  <ul className={styles.decisionsList}>
    {decisions.map((decision, index) => {
      const text = getDecisionText(decision);
      const context = getDecisionContext(decision);
      return (
        <li key={index} className={styles.decisionItem}>
          <span className={styles.decisionBullet}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 4l4 8H4l4-8z" />
            </svg>
          </span>
          <span className={styles.decisionContent}>
            <span className={styles.decisionText}>{text}</span>
            {context && <span className={styles.decisionContext}>{context}</span>}
          </span>
        </li>
      );
    })}
  </ul>
);

// ============================================================================
// Topics Component
// ============================================================================

interface TopicsListProps {
  topics: TopicHighlight[];
}

const TopicsList: React.FC<TopicsListProps> = ({ topics }) => (
  <div className={styles.topicsList}>
    {topics.map((topic, index) => (
      <div key={index} className={styles.topicCard}>
        <h4 className={styles.topicTitle}>{topic.title}</h4>
        {topic.entries.length > 0 && (
          <ul className={styles.topicEntries}>
            {topic.entries.map((entry, entryIndex) => (
              <TopicEntryItem key={entryIndex} entry={entry} />
            ))}
          </ul>
        )}
      </div>
    ))}
  </div>
);

interface TopicEntryItemProps {
  entry: TopicEntry;
}

const TopicEntryItem: React.FC<TopicEntryItemProps> = ({ entry }) => {
  const typeClass =
    entry.type === 'Fact'
      ? styles.entryFact
      : entry.type === 'Next steps'
        ? styles.entryNextStep
        : entry.type === 'Concern'
          ? styles.entryConcern
          : styles.entryDefault;

  return (
    <li className={`${styles.topicEntry} ${typeClass}`}>
      <span className={styles.entryType}>{entry.type}</span>
      <span className={styles.entryText}>{entry.text}</span>
      {(entry.owner || entry.due_date) && (
        <div className={styles.entryMeta}>
          {entry.owner && <span className={styles.entryOwner}>{entry.owner}</span>}
          {entry.due_date && <span className={styles.entryDueDate}>{entry.due_date}</span>}
        </div>
      )}
    </li>
  );
};

// ============================================================================
// Participants Component
// ============================================================================

interface ParticipantChipsProps {
  participants: string[];
  onParticipantClick?: (participant: string) => void;
}

const ParticipantChips: React.FC<ParticipantChipsProps> = ({
  participants,
  onParticipantClick,
}) => (
  <div className={styles.participantChips}>
    {participants.map((participant, index) => (
      <span
        key={index}
        className={`${styles.participantChip} ${onParticipantClick ? styles.clickable : ''}`}
        onClick={() => onParticipantClick?.(participant)}
      >
        {participant}
      </span>
    ))}
  </div>
);

export default StructuredSummaryV1Renderer;
