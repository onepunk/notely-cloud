"""
faster-whisper transcription engine
"""

import os
import sys
import numpy as np
from typing import Optional, Dict, Any
from faster_whisper import WhisperModel

from .types import TranscriptionConfig, TranscriptionResult, TranscriptionSegment
from .metrics import LatencyTracker


class FasterWhisperEngine:
    """Transcription engine using faster-whisper and CTranslate2"""

    def __init__(self, config: Optional[TranscriptionConfig] = None):
        """Initialize faster-whisper engine"""
        self.config = config or TranscriptionConfig()
        self.model: Optional[WhisperModel] = None
        self.latency_tracker = LatencyTracker("transcription")

    def load_model(self, model_name: Optional[str] = None):
        """Load faster-whisper model"""
        if model_name:
            self.config.model_name = model_name

        device, compute_type = self.config.get_device_and_compute_type()

        def attempt_load(target_device: str, target_compute: str):
            print(f"LOADING FASTER-WHISPER MODEL: {self.config.model_name}", file=sys.stderr)
            print(f"Device: {target_device}, Compute type: {target_compute}", file=sys.stderr)
            sys.stderr.flush()
            return WhisperModel(
                self.config.model_name,
                device=target_device,
                compute_type=target_compute,
            )

        try:
            self.model = attempt_load(device, compute_type)
        except Exception as e:
            # If GPU/cudnn is missing or misconfigured, fall back to CPU automatically
            if device != "cpu":
                print(f"WARNING: GPU load failed ({e}); falling back to CPU (int8)", file=sys.stderr)
                sys.stderr.flush()
                self.model = attempt_load("cpu", "int8")
            else:
                print(f"ERROR: Failed to load model: {e}", file=sys.stderr)
                sys.stderr.flush()
                raise

        print(f"MODEL LOADED SUCCESSFULLY: {self.config.model_name}", file=sys.stderr)
        print(f"Model type: {type(self.model)}", file=sys.stderr)
        print("-" * 50, file=sys.stderr)
        sys.stderr.flush()

    def get_model(self, model_name: Optional[str] = None) -> "FasterWhisperEngine":
        """Get model (load if not already loaded)"""
        if self.model is None or (model_name and model_name != self.config.model_name):
            self.load_model(model_name)
        return self

    def transcribe(
        self,
        audio: np.ndarray,
        language: Optional[str] = None,
        temperature: Optional[float] = None,
        initial_prompt: Optional[str] = None,
        prompt: Optional[str] = None,
        beam_size: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Transcribe audio array to text

        Args:
            audio: Float32 numpy array normalized to [-1, 1]
            language: Language code (default: config.language)
            temperature: Sampling temperature (default: config.temperature)
            initial_prompt: Initial context prompt
            prompt: Rolling history prompt
            beam_size: Beam search size (default: config.beam_size)

        Returns:
            Dictionary matching whisper.transcribe() format:
            {
                "text": str,
                "segments": List[Dict],
                "language": str
            }
        """
        if self.model is None:
            self.load_model()

        # Build combined prompt from initial and rolling history
        combined_prompt = None
        if initial_prompt and prompt:
            combined_prompt = f"{initial_prompt} {prompt}"
        elif initial_prompt:
            combined_prompt = initial_prompt
        elif prompt:
            combined_prompt = prompt

        # Configure transcription parameters
        lang = language or self.config.language
        temp = temperature if temperature is not None else self.config.temperature
        beam = beam_size if beam_size is not None else self.config.beam_size

        # VAD debugging - log audio input details (only if audio level is significant)
        audio_duration = len(audio) / 16000.0  # Assuming 16kHz sample rate
        audio_rms = np.sqrt(np.mean(audio**2))
        audio_max = np.max(np.abs(audio))

        # Only log if there's significant audio (RMS > 0.01) to reduce log spam during silence
        should_log = audio_rms > 0.01

        if should_log:
            print(f"TRANSCRIBE INPUT (before VAD):", file=sys.stderr)
            print(f"   Audio duration: {audio_duration:.2f}s ({len(audio)} samples)", file=sys.stderr)
            print(f"   Audio RMS: {audio_rms:.4f}", file=sys.stderr)
            print(f"   Audio max amplitude: {audio_max:.4f}", file=sys.stderr)
            print(f"   VAD enabled: {self.config.vad_enabled}", file=sys.stderr)

        # Call faster-whisper transcribe with full VAD parameters
        # Returns tuple: (segments_generator, transcription_info)
        vad_params = self.config.get_vad_parameters()
        if should_log and self.config.vad_enabled and vad_params:
            print(f"   VAD parameters: {vad_params}", file=sys.stderr)
            sys.stderr.flush()

        segments_gen, info = self.model.transcribe(
            audio,
            language=lang,
            temperature=temp,
            initial_prompt=combined_prompt,
            condition_on_previous_text=self.config.condition_on_previous_text,
            vad_filter=self.config.vad_enabled,
            vad_parameters=vad_params if vad_params else None,
            beam_size=beam,
        )

        # Convert generator to list and build result
        segments_list = []
        full_text_parts = []

        for segment in segments_gen:
            segments_list.append(
                TranscriptionSegment(
                    start=segment.start,
                    end=segment.end,
                    text=segment.text.strip(),
                )
            )
            full_text_parts.append(segment.text.strip())

        # VAD debugging - log transcription output (only if there's text or significant audio)
        final_text = " ".join(full_text_parts)

        # Only log if: there's text OR we logged the input (significant audio)
        if final_text or should_log:
            print(f"TRANSCRIBE OUTPUT (after VAD):", file=sys.stderr)
            print(f"   Segments returned: {len(segments_list)}", file=sys.stderr)
            print(f"   Text length: {len(final_text)} chars", file=sys.stderr)
            print(f"   Text preview: {final_text[:100] if final_text else '(empty)'}{'...' if len(final_text) > 100 else ''}", file=sys.stderr)

            # Only warn about VAD filtering if there was significant audio but no text
            if should_log and self.config.vad_enabled and len(segments_list) == 0:
                print(f"WARNING: VAD filtered out audio (RMS: {audio_rms:.4f})", file=sys.stderr)

            sys.stderr.flush()

        # Build result matching Whisper format
        result = TranscriptionResult(
            text=final_text,
            segments=segments_list,
            language=info.language,
        )

        return result.to_dict()

    def transcribe_pcm_chunks(
        self,
        chunks: list,
        language: str = "en",
        temperature: float = 0.1,
        initial_prompt: Optional[str] = None,
        prompt: Optional[str] = None,
        beam_size: Optional[int] = None,
    ) -> Dict[str, Any]:
        """
        Transcribe PCM audio chunks (compatible with existing interface)

        Args:
            chunks: List of PCM16 int16 binary chunks
            language: Language code
            temperature: Sampling temperature
            initial_prompt: Initial context prompt
            prompt: Rolling history prompt
            beam_size: Beam search size (default: config.beam_size)

        Returns:
            Dictionary matching whisper.transcribe() format
        """
        # Convert int16 PCM bytes to float32 array normalized to [-1, 1]
        # (same as existing transcriber.py)
        audio_array = (
            np.frombuffer(b"".join(chunks), np.int16).flatten().astype(np.float32)
            / 32768.0
        )

        return self.transcribe(
            audio_array,
            language=language,
            temperature=temperature,
            initial_prompt=initial_prompt,
            prompt=prompt,
            beam_size=beam_size,
        )

    def get_latency_stats(self) -> dict:
        """Get current latency statistics"""
        return self.latency_tracker.get_stats()

    def log_latency_stats(self):
        """Print current latency statistics"""
        self.latency_tracker.log_stats()
