"""
Data types for transcription engine
"""

import os
from dataclasses import dataclass
from typing import List, Optional, Dict, Any


@dataclass
class TranscriptionConfig:
    """Configuration for transcription engine"""
    model_name: str = "base.en"
    device: str = "auto"  # "auto", "cuda", "cpu"
    compute_type: str = "default"  # "default", "int8", "int8_float16", "float16"
    language: str = "en"
    temperature: float = 0.1
    condition_on_previous_text: bool = True
    beam_size: int = 1  # Default: 1 (greedy), use 5 for refinement

    # VAD (Voice Activity Detection) configuration
    vad_enabled: bool = False
    vad_threshold: float = 0.5  # Speech probability threshold (0-1)
    vad_min_speech_duration_ms: int = 250  # Minimum speech duration to keep
    vad_min_silence_duration_ms: int = 500  # Minimum silence to split segments
    vad_speech_pad_ms: int = 400  # Padding around speech segments

    def get_device_and_compute_type(self) -> tuple[str, str]:
        """Determine actual device and compute_type based on configuration"""
        import torch
        import sys

        # Honor explicit override
        if self.device != "auto":
            device = self.device
        else:
            use_gpu_env = (os.environ.get("NOTELY_USE_GPU") or "auto").strip().lower()

            # Safely check GPU availability with fallback on errors
            gpu_healthy = False
            try:
                gpu_healthy = torch.cuda.is_available() and torch.backends.cudnn.is_available()
                print(f"🔍 GPU Health Check: CUDA available={torch.cuda.is_available()}, cuDNN available={torch.backends.cudnn.is_available()}", file=sys.stderr)
            except Exception as e:
                print(f"⚠️  GPU health check failed: {e}. Falling back to CPU.", file=sys.stderr)
                gpu_healthy = False

            if use_gpu_env == "false":
                device = "cpu"
                print("🖥️  Using CPU (forced by NOTELY_USE_GPU=false)", file=sys.stderr)
            elif use_gpu_env == "true":
                device = "cuda" if gpu_healthy else "cpu"
                if not gpu_healthy:
                    print("⚠️  GPU requested but not healthy, falling back to CPU", file=sys.stderr)
                else:
                    print("🚀 Using CUDA GPU", file=sys.stderr)
            else:
                # auto: use GPU only if healthy, otherwise CPU
                device = "cuda" if gpu_healthy else "cpu"
                print(f"🔄 Auto-detected device: {device}", file=sys.stderr)

        if self.compute_type == "default":
            if device == "cuda":
                compute_type = "float16"
            else:
                compute_type = "int8"
        else:
            compute_type = self.compute_type

        return device, compute_type

    def get_vad_parameters(self) -> Optional[Dict[str, Any]]:
        """Get VAD parameters for faster-whisper"""
        if not self.vad_enabled:
            return None

        return {
            "threshold": self.vad_threshold,
            "min_speech_duration_ms": self.vad_min_speech_duration_ms,
            "min_silence_duration_ms": self.vad_min_silence_duration_ms,
            "speech_pad_ms": self.vad_speech_pad_ms,
        }


@dataclass
class TranscriptionSegment:
    """Single transcription segment"""
    start: float
    end: float
    text: str

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary matching Whisper format"""
        return {
            "start": self.start,
            "end": self.end,
            "text": self.text,
        }


@dataclass
class TranscriptionResult:
    """Result from transcription engine"""
    text: str
    segments: List[TranscriptionSegment]
    language: str

    def to_dict(self) -> Dict[str, Any]:
        """Convert to dictionary matching Whisper format"""
        return {
            "text": self.text,
            "segments": [seg.to_dict() for seg in self.segments],
            "language": self.language,
        }
