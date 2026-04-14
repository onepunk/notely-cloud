"""
Hallucination filter for transcription results
Filters out common hallucination patterns from speech recognition

Based on CPU_FRIENDLY_REFINEMENT_PLAN.md
"""

import re
import os
import sys
from typing import Optional, Tuple


class HallucinationFilter:
    """Filter for detecting and removing hallucination artifacts in transcriptions"""

    def __init__(self):
        # Allow bypassing the filter for debugging
        self.enabled = os.environ.get('NOTELY_HALLUCINATION_FILTER', 'true').lower() != 'false'

        # Thresholds
        self.repeated_char_threshold = 10  # Repeated char pattern like "e-e-e-e-..."
        self.unique_word_ratio_threshold = 0.3  # For >5 words
        self.low_confidence_threshold = 0.3  # Very low confidence
        self.long_text_threshold = 100  # chars

    def should_filter(self, text: str, confidence: Optional[float] = None) -> Tuple[bool, str]:
        """
        Check if text should be filtered as hallucination

        Returns:
            (should_filter: bool, reason: str)
        """
        if not self.enabled:
            return False, ""

        if not text or not text.strip():
            return True, "empty_text"

        # Check for repeated character patterns
        # Pattern: single char repeated with separators (e.g., "e-e-e-e-e...")
        repeated_char_pattern = r'(\w)(?:-\1|\s+\1){10,}'
        if re.search(repeated_char_pattern, text):
            return True, "repeated_chars"

        # Check for repeated word patterns (low unique/total ratio)
        words = text.split()
        if len(words) > 5:
            unique_words = len(set(words))
            unique_ratio = unique_words / len(words)
            if unique_ratio < self.unique_word_ratio_threshold:
                return True, f"repeated_words_ratio_{unique_ratio:.2f}"

        # Check for very low confidence AND long text
        if confidence is not None and confidence < self.low_confidence_threshold:
            if len(text) > self.long_text_threshold:
                return True, f"low_confidence_{confidence:.2f}_long_text"

        return False, ""

    def filter_text(
        self, text: str, confidence: Optional[float] = None, segment_id: str = ""
    ) -> Optional[str]:
        """
        Filter text if it's a hallucination, otherwise return original

        Returns:
            Original text if OK, None if filtered out
        """
        should_filter, reason = self.should_filter(text, confidence)

        if should_filter:
            print(
                f"HALLUCINATION FILTERED: segment={segment_id}, "
                f"reason={reason}, text='{text[:100]}...'",
                file=sys.stderr,
            )
            sys.stderr.flush()
            return None

        return text


# Global instance
_filter = HallucinationFilter()


def filter_text(
    text: str, confidence: Optional[float] = None, segment_id: str = ""
) -> Optional[str]:
    """Convenience function to filter text using global filter instance"""
    return _filter.filter_text(text, confidence, segment_id)


def should_filter(text: str, confidence: Optional[float] = None) -> Tuple[bool, str]:
    """Convenience function to check if text should be filtered"""
    return _filter.should_filter(text, confidence)
