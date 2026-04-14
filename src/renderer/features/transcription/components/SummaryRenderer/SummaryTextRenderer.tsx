/**
 * SummaryTextRenderer - Parses and renders summary text with consistent formatting
 *
 * This component normalizes LLM-generated summary text into a consistent template,
 * regardless of the formatting variations in the source text.
 *
 * Supported input formats:
 * - Markdown with **bold** headers and * bullet points
 * - Plain text with newline-separated sections
 * - Mixed formatting
 *
 * Output template sections:
 * - Title (if present)
 * - Executive Summary
 * - Key Decisions (rendered separately in parent component)
 * - Action Items (rendered separately in parent component)
 * - Discussion Highlights
 * - Any remaining content
 */

import * as React from 'react';

import styles from './SummaryRenderer.module.css';

export interface ParsedSummarySection {
  type: 'title' | 'executive_summary' | 'paragraph' | 'bullet_list' | 'numbered_list';
  title?: string;
  content: string | string[];
}

export interface ParsedSummary {
  title?: string;
  sections: ParsedSummarySection[];
}

/**
 * Parse summary text into structured sections
 */
export function parseSummaryText(text: string): ParsedSummary {
  if (!text || typeof text !== 'string') {
    return { sections: [] };
  }

  const result: ParsedSummary = { sections: [] };

  // Normalize line endings and split into lines
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  let currentSection: ParsedSummarySection | null = null;
  let currentBullets: string[] = [];

  const flushBullets = () => {
    if (currentBullets.length > 0) {
      result.sections.push({
        type: 'bullet_list',
        content: [...currentBullets],
      });
      currentBullets = [];
    }
  };

  const flushSection = () => {
    if (currentSection) {
      result.sections.push(currentSection);
      currentSection = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines (but they mark section boundaries)
    if (!line) {
      flushBullets();
      flushSection();
      continue;
    }

    // Check for markdown headings: # Title, ## Subtitle, ### Section
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushBullets();
      flushSection();
      const headerText = headingMatch[2].trim();
      if (!result.title && result.sections.length === 0) {
        result.title = headerText;
      } else {
        currentSection = {
          type: 'executive_summary',
          title: headerText,
          content: '',
        };
      }
      continue;
    }

    // Check for inline bold headers: **Meeting Topic:** value
    const boldInlineMatch = line.match(/^\*\*([^*]+)\*\*[:\s]+(.+)$/);
    if (boldInlineMatch) {
      flushBullets();
      flushSection();
      currentSection = {
        type: 'executive_summary',
        title: boldInlineMatch[1].trim(),
        content: boldInlineMatch[2].trim(),
      };
      continue;
    }

    // Check for markdown bold headers: **Title** or **Executive Summary**
    const boldHeaderMatch = line.match(/^\*\*([^*]+)\*\*$/);
    if (boldHeaderMatch) {
      flushBullets();
      flushSection();

      const headerText = boldHeaderMatch[1].trim();

      // Check if this is the document title
      if (
        headerText.toLowerCase() === 'title' ||
        headerText.toLowerCase() === 'meeting title' ||
        (i === 0 && !result.title)
      ) {
        // Next non-empty line is the actual title
        continue;
      }

      // Start a new section with this header
      currentSection = {
        type: 'executive_summary',
        title: headerText,
        content: '',
      };
      continue;
    }

    // Check for bullet points: * item or - item
    const bulletMatch = line.match(/^[*\-•]\s+(.+)$/);
    if (bulletMatch) {
      flushSection();
      currentBullets.push(bulletMatch[1].trim());
      continue;
    }

    // Check for numbered list: 1. item or 1) item
    const numberedMatch = line.match(/^\d+[.)]\s+(.+)$/);
    if (numberedMatch) {
      flushSection();
      // Treat numbered items like bullets for simplicity
      currentBullets.push(numberedMatch[1].trim());
      continue;
    }

    // Check if this looks like a title (first meaningful line, relatively short)
    if (!result.title && result.sections.length === 0 && !currentSection && line.length < 100) {
      // Check if it starts with "Meeting Summary:" or similar
      const titlePrefixMatch = line.match(/^(?:Meeting Summary[:\s]*)?(.+)$/i);
      if (titlePrefixMatch) {
        result.title = titlePrefixMatch[1].trim() || line;
        continue;
      }
    }

    // Regular paragraph content
    flushBullets();

    if (currentSection && typeof currentSection.content === 'string') {
      // Append to existing section
      currentSection.content = currentSection.content ? `${currentSection.content} ${line}` : line;
    } else {
      // Start a new paragraph section
      flushSection();
      currentSection = {
        type: 'paragraph',
        content: line,
      };
    }
  }

  // Flush any remaining content
  flushBullets();
  flushSection();

  return result;
}

/**
 * Clean up inline markdown formatting from text
 */
function cleanInlineMarkdown(text: string): string {
  if (!text) return '';

  return (
    text
      // Remove bold markers
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      // Remove italic markers
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/_([^_]+)_/g, '$1')
      // Clean up multiple spaces
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export interface SummaryTextRendererProps {
  /** The summary text to render */
  text: string;
  /** Custom class name */
  className?: string;
}

/**
 * Renders summary text with consistent formatting
 */
export const SummaryTextRenderer: React.FC<SummaryTextRendererProps> = ({ text, className }) => {
  const parsed = React.useMemo(() => parseSummaryText(text), [text]);

  if (!parsed.sections.length && !parsed.title) {
    // Fallback: just render the text with line breaks preserved
    return (
      <div className={`${styles.summaryTextContainer} ${className || ''}`}>
        <p className={styles.summaryParagraph}>
          {text.split('\n').map((line, i) => (
            <React.Fragment key={i}>
              {cleanInlineMarkdown(line)}
              {i < text.split('\n').length - 1 && <br />}
            </React.Fragment>
          ))}
        </p>
      </div>
    );
  }

  return (
    <div className={`${styles.summaryTextContainer} ${className || ''}`}>
      {/* Title */}
      {parsed.title && <h4 className={styles.summaryTitle}>{cleanInlineMarkdown(parsed.title)}</h4>}

      {/* Sections */}
      {parsed.sections.map((section, index) => {
        switch (section.type) {
          case 'executive_summary':
          case 'paragraph':
            return (
              <div key={index} className={styles.summarySection}>
                {section.title && (
                  <h5 className={styles.summarySectionTitle}>
                    {cleanInlineMarkdown(section.title)}
                  </h5>
                )}
                <p className={styles.summaryParagraph}>
                  {cleanInlineMarkdown(section.content as string)}
                </p>
              </div>
            );

          case 'bullet_list':
            return (
              <ul key={index} className={styles.summaryBulletList}>
                {(section.content as string[]).map((item, itemIndex) => (
                  <li key={itemIndex} className={styles.summaryBulletItem}>
                    {cleanInlineMarkdown(item)}
                  </li>
                ))}
              </ul>
            );

          case 'numbered_list':
            return (
              <ol key={index} className={styles.summaryNumberedList}>
                {(section.content as string[]).map((item, itemIndex) => (
                  <li key={itemIndex} className={styles.summaryNumberedItem}>
                    {cleanInlineMarkdown(item)}
                  </li>
                ))}
              </ol>
            );

          default:
            return null;
        }
      })}
    </div>
  );
};

export default SummaryTextRenderer;
