import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical';
import * as React from 'react';

import type { Speaker } from '../model/transcription.store';
import { useTranscriptionStore } from '../model/transcription.store';
import { groupSegments } from '../services/groupSegments';

type Props = {
  searchQuery?: string;
  currentMatchIndex?: number;
  isEditMode?: boolean;
};

// Type for tracking edited word ranges
type EditedRange = {
  start: number;
  end: number;
};

/**
 * Find word-level differences between original and edited text
 * Returns ranges of characters in the edited text that were changed
 */
function findEditedWordRanges(original: string, edited: string): EditedRange[] {
  if (!original || !edited) return [];

  const originalWords = original.split(/(\s+)/); // Keep whitespace as separate elements
  const editedWords = edited.split(/(\s+)/);

  const ranges: EditedRange[] = [];
  let editedPos = 0;

  // Compare words at each position
  for (let i = 0; i < editedWords.length; i++) {
    const editedWord = editedWords[i];
    const originalWord = i < originalWords.length ? originalWords[i] : '';

    // Skip whitespace-only segments
    if (editedWord.trim().length > 0) {
      // If words differ, mark this range as edited
      if (editedWord !== originalWord) {
        ranges.push({
          start: editedPos,
          end: editedPos + editedWord.length,
        });
      }
    }

    editedPos += editedWord.length;
  }

  return ranges;
}

/**
 * Check if a position falls within any edited range
 */
function isPositionEdited(pos: number, editedRanges: EditedRange[]): boolean {
  return editedRanges.some((range) => pos >= range.start && pos < range.end);
}

/**
 * Get display label for a speaker type
 */
function getSpeakerLabel(speaker: Speaker | undefined): string {
  switch (speaker) {
    case 'user':
      return 'You';
    case 'participant':
      return 'Participant';
    case 'both':
      return 'Both';
    default:
      return '';
  }
}

/**
 * Format seconds to [MM:SS] timestamp marker
 */
function formatTimestamp(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `[${mins}:${secs.toString().padStart(2, '0')}]`;
}

export const TranscriptionViewerPlugin: React.FC<Props> = ({
  searchQuery = '',
  currentMatchIndex = 0,
  isEditMode = false,
}) => {
  const [editor] = useLexicalComposerContext();
  const partial = useTranscriptionStore((s) => s.partialText);
  const displayText = useTranscriptionStore((s) => s.displayText);
  // Protocol v2 fields
  const stableText = useTranscriptionStore((s) => s.stableText);
  const unstableText = useTranscriptionStore((s) => s.unstableText);
  const protocolVersion = useTranscriptionStore((s) => s.protocolVersion);
  const isRecording = useTranscriptionStore((s) => s.isRecording);
  const hasUserEdits = useTranscriptionStore((s) => s.hasUserEdits);
  const originalDisplayText = useTranscriptionStore((s) => s.originalDisplayText);
  // Segments with speaker attribution
  const segments = useTranscriptionStore((s) => s.segments);

  // Compute edited ranges when we have user edits
  const editedRanges = React.useMemo(() => {
    if (!hasUserEdits || !originalDisplayText || !displayText) return [];
    return findEditedWordRanges(originalDisplayText, displayText);
  }, [hasUserEdits, originalDisplayText, displayText]);

  // Check if we have segments with speaker attribution
  const hasSpeakerData = React.useMemo(() => {
    return segments.length > 0 && segments.some((s) => s.speaker && s.speaker !== 'unknown');
  }, [segments]);

  // Track if we've entered edit mode to populate content once
  const wasEditModeRef = React.useRef(false);

  // Toggle editor editable state when isEditMode changes
  React.useEffect(() => {
    editor.setEditable(isEditMode);

    // When entering edit mode, populate the editor with current displayText for editing
    if (isEditMode && !wasEditModeRef.current) {
      console.log('[TranscriptionViewerPlugin] Entering edit mode, populating with displayText');
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        const p = $createParagraphNode();

        // Add the current displayText as editable plain text
        const textToEdit = displayText || '';
        if (textToEdit.trim().length > 0) {
          const textNode = $createTextNode(textToEdit);
          // Use theme-aware text color for editing
          textNode.setStyle('color: var(--text-primary);');
          p.append(textNode);
        }

        root.append(p);
      });
      wasEditModeRef.current = true;
    } else if (!isEditMode) {
      wasEditModeRef.current = false;
    }
  }, [isEditMode, editor, displayText]);

  React.useEffect(() => {
    // In edit mode, don't override user's edits with store updates
    if (isEditMode) {
      return;
    }

    editor.update(() => {
      const root = $getRoot();
      root.clear();
      const p = $createParagraphNode();

      // Helper function to create highlighted text segments with word-level edit highlighting
      const createHighlightedText = (text: string, textType: 'final' | 'stable' | 'unstable') => {
        // Define styles for each text type using CSS variables for theme support
        const normalStyle = (() => {
          switch (textType) {
            case 'final':
              return 'color: var(--text-primary); font-style: normal; opacity: 1.0;';
            case 'stable':
              return 'color: var(--text-tertiary); font-style: normal; opacity: 1.0;';
            case 'unstable':
              return 'color: var(--text-secondary); font-style: italic; opacity: 0.85;';
          }
        })();

        const editedStyle =
          'color: var(--brand-primary); font-style: normal; font-weight: bold; opacity: 1.0;';

        // If no user edits or no search query, render with word-level edit highlighting
        if (!searchQuery || searchQuery.trim().length === 0) {
          // Check if we have edited ranges to highlight
          if (hasUserEdits && editedRanges.length > 0 && textType === 'final') {
            // Split text into segments based on edit ranges
            const nodes = [];
            let lastEnd = 0;

            // Sort ranges by start position
            const sortedRanges = [...editedRanges].sort((a, b) => a.start - b.start);

            for (const range of sortedRanges) {
              // Add unedited text before this range
              if (range.start > lastEnd) {
                const unedited = text.substring(lastEnd, range.start);
                const node = $createTextNode(unedited);
                node.setStyle(normalStyle);
                nodes.push(node);
              }

              // Add edited text (highlighted in green)
              const edited = text.substring(range.start, range.end);
              const editedNode = $createTextNode(edited);
              editedNode.setStyle(editedStyle);
              nodes.push(editedNode);

              lastEnd = range.end;
            }

            // Add any remaining unedited text
            if (lastEnd < text.length) {
              const remaining = text.substring(lastEnd);
              const node = $createTextNode(remaining);
              node.setStyle(normalStyle);
              nodes.push(node);
            }

            return nodes.length > 0 ? nodes : [$createTextNode(text)];
          }

          // No edits or not final text - render with normal style
          const textNode = $createTextNode(text);
          textNode.setStyle(normalStyle);
          return [textNode];
        }

        // Handle search query highlighting (existing logic)
        const nodes = [];
        const query = searchQuery.toLowerCase();
        const lowerText = text.toLowerCase();
        let lastIndex = 0;
        let matchIndex = 0;
        let index = lowerText.indexOf(query);

        // Helper to get style for a position (checks if position is in edited range)
        const getStyleForPosition = (pos: number) => {
          if (hasUserEdits && editedRanges.length > 0 && textType === 'final') {
            if (isPositionEdited(pos, editedRanges)) {
              return editedStyle;
            }
          }
          return normalStyle;
        };

        while (index !== -1) {
          // Add text before match
          if (index > lastIndex) {
            const beforeText = text.substring(lastIndex, index);
            const beforeNode = $createTextNode(beforeText);
            beforeNode.setStyle(getStyleForPosition(lastIndex));
            nodes.push(beforeNode);
          }

          // Add highlighted match (search takes priority over edit styling)
          const matchNode = $createTextNode(text.substring(index, index + query.length));
          const isCurrentMatch = matchIndex === currentMatchIndex;
          matchNode.setStyle(
            isCurrentMatch
              ? 'background: rgba(255, 193, 7, 0.6); color: #111827; padding: 1px 0; border-radius: 2px; box-shadow: 0 0 0 2px rgba(255, 193, 7, 0.3);'
              : 'background: rgba(255, 235, 59, 0.4); color: #111827; padding: 1px 0; border-radius: 2px;'
          );
          nodes.push(matchNode);

          lastIndex = index + query.length;
          matchIndex++;
          index = lowerText.indexOf(query, lastIndex);
        }

        // Add remaining text
        if (lastIndex < text.length) {
          const afterNode = $createTextNode(text.substring(lastIndex));
          afterNode.setStyle(getStyleForPosition(lastIndex));
          nodes.push(afterNode);
        }

        return nodes;
      };

      // Speaker label styling - cyan/teal color to distinguish from transcription text
      const speakerLabelStyle = 'color: #22d3ee; font-weight: 600; font-style: normal;';
      // Timestamp styling - accent color, clickable appearance
      const timestampStyle =
        'color: var(--accent-primary, #3b82f6); font-size: 0.85em; cursor: pointer; opacity: 0.8;';

      // Track the last paragraph node so we can append live text to it
      let lastParagraph: ReturnType<typeof $createParagraphNode> | null = null;

      // Render segments grouped into paragraphs
      if (segments.length > 0) {
        const paragraphs = groupSegments(segments);

        paragraphs.forEach((group) => {
          const p = $createParagraphNode();

          // Timestamp header [MM:SS]
          if (group.startTime !== undefined && group.startTime !== null) {
            const timestampText = formatTimestamp(group.startTime);
            const timestampNode = $createTextNode(timestampText + ' ');
            timestampNode.setStyle(timestampStyle);
            p.append(timestampNode);
          }

          // Speaker label on the same line as timestamp
          if (hasSpeakerData && group.speaker && group.speaker !== 'unknown') {
            const label = getSpeakerLabel(group.speaker);
            if (label) {
              const labelNode = $createTextNode(label);
              labelNode.setStyle(speakerLabelStyle);
              p.append(labelNode);
            }
          }

          // Newline after header, then grouped text
          if (group.text && group.text.trim().length > 0) {
            const nlNode = $createTextNode('\n');
            p.append(nlNode);
            const textNodes = createHighlightedText(group.text, 'final');
            textNodes.forEach((node) => p.append(node));
          }

          root.append(p);
          lastParagraph = p;
        });
      } else if (displayText && displayText.trim().length > 0) {
        // Fallback: Add final text without speaker labels (white, normal styling)
        const p = $createParagraphNode();
        const finalNodes = createHighlightedText(displayText, 'final');
        finalNodes.forEach((node) => p.append(node));
        root.append(p);
        lastParagraph = p;
      }

      // Append live transcription text to the last paragraph
      // If no paragraph exists yet, create one for the live text
      const ensureParagraph = () => {
        if (!lastParagraph) {
          lastParagraph = $createParagraphNode();
          root.append(lastParagraph);
        }
        return lastParagraph;
      };

      // Protocol v2: Use stable/unstable when available, fallback to v1 partial
      const useProtocolV2 =
        protocolVersion === 2 && (stableText !== undefined || unstableText !== undefined);

      if (useProtocolV2) {
        // Protocol v2: Render stable text (medium gray, normal styling)
        const hasDisplay = !!(displayText && displayText.trim().length > 0) || segments.length > 0;

        if (stableText && stableText.trim().length > 0) {
          const p = ensureParagraph();
          if (hasDisplay) {
            const spaceNode = $createTextNode(' ');
            p.append(spaceNode);
          }
          const stableNodes = createHighlightedText(stableText, 'stable');
          stableNodes.forEach((node) => p.append(node));
        }

        // Protocol v2: Render unstable text (dark gray, italic styling)
        if (unstableText && unstableText.trim().length > 0) {
          const p = ensureParagraph();
          if (hasDisplay || (stableText && stableText.trim().length > 0)) {
            const spaceNode = $createTextNode(' ');
            p.append(spaceNode);
          }
          const unstableNodes = createHighlightedText(unstableText, 'unstable');
          unstableNodes.forEach((node) => p.append(node));
        }
      } else {
        // Protocol v1: Use partial text (dark gray, italic styling) with space separator if needed
        if (partial && partial.trim().length > 0) {
          const p = ensureParagraph();
          if ((displayText && displayText.trim().length > 0) || segments.length > 0) {
            const spaceNode = $createTextNode(' ');
            p.append(spaceNode);
          }
          const partialNodes = createHighlightedText(partial, 'unstable');
          partialNodes.forEach((node) => p.append(node));
        }
      }
    });
  }, [
    editor,
    displayText,
    partial,
    stableText,
    unstableText,
    protocolVersion,
    searchQuery,
    currentMatchIndex,
    isEditMode,
    isRecording,
    hasUserEdits,
    editedRanges,
    segments,
    hasSpeakerData,
  ]);

  return null;
};
