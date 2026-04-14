import type { TranscriptionSegmentData } from '../client/transcriptionClient';

import type { Speaker } from './SpeakerAttributor';

export type SegmentParagraph = {
  startTime: number;
  speaker?: Speaker;
  text: string;
  segmentIds: string[];
};

const GAP_THRESHOLD_SECONDS = 15;
const MAX_PARAGRAPH_DURATION_SECONDS = 30;

/**
 * Group consecutive transcription segments into paragraphs.
 * A new paragraph starts when:
 * - Speaker changes (both current and previous have meaningful speaker data)
 * - Time gap exceeds 15 seconds between segments
 * - Paragraph duration exceeds 30 seconds of audio
 */
export function groupSegments(segments: TranscriptionSegmentData[]): SegmentParagraph[] {
  if (segments.length === 0) return [];

  const paragraphs: SegmentParagraph[] = [];
  let current: SegmentParagraph = {
    startTime: segments[0].startTime,
    speaker: segments[0].speaker,
    text: segments[0].text?.trim() || '',
    segmentIds: [segments[0].segmentId],
  };

  for (let i = 1; i < segments.length; i++) {
    const seg = segments[i];
    const prev = segments[i - 1];

    const speakerChanged =
      seg.speaker &&
      seg.speaker !== 'unknown' &&
      prev.speaker &&
      prev.speaker !== 'unknown' &&
      seg.speaker !== prev.speaker;

    const timeGap = seg.startTime - prev.endTime > GAP_THRESHOLD_SECONDS;

    const paragraphTooLong = seg.startTime - current.startTime >= MAX_PARAGRAPH_DURATION_SECONDS;

    if (speakerChanged || timeGap || paragraphTooLong) {
      paragraphs.push(current);
      current = {
        startTime: seg.startTime,
        speaker: seg.speaker,
        text: seg.text?.trim() || '',
        segmentIds: [seg.segmentId],
      };
    } else {
      const segText = seg.text?.trim() || '';
      if (segText) {
        current.text += (current.text ? ' ' : '') + segText;
      }
      current.segmentIds.push(seg.segmentId);
    }
  }

  paragraphs.push(current);
  return paragraphs;
}
