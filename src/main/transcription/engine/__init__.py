"""
Transcription engine module - faster-whisper implementation
"""

from .faster_whisper_engine import FasterWhisperEngine
from .types import TranscriptionConfig, TranscriptionResult
from .metrics import track_latency, LatencyTracker

__all__ = [
    "FasterWhisperEngine",
    "TranscriptionConfig",
    "TranscriptionResult",
    "track_latency",
    "LatencyTracker",
]
