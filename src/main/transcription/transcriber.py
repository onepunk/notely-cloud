"""
Whisper transcription logic - adapted from whisper-flow
Handles loading models and converting PCM chunks to text

Supports faster-whisper (CTranslate2) only.
"""

import os
import sys
import numpy as np
import asyncio

from engine import FasterWhisperEngine, TranscriptionConfig

models = {}
faster_whisper_engines = {}

def _resolve_ct2_model_path(model_name: str) -> str:
    """
    Resolve a local CTranslate2 model path if bundled. Falls back to the model name
    (which allows faster-whisper to download when a local bundle is missing).
    """
    # Explicit override wins
    explicit_path = os.environ.get('NOTELY_MODEL_PATH')
    if explicit_path and os.path.exists(explicit_path):
        return explicit_path

    # Bundled models live under models/ctranslate2/<model_name>
    base_dir = os.path.join(os.path.dirname(__file__), 'models', 'ctranslate2')
    candidate = os.path.join(base_dir, model_name)
    if os.path.exists(candidate):
        return candidate

    return model_name

def get_model(file_name: str | None = None) -> FasterWhisperEngine:
    """
    Load faster-whisper engine (CTranslate2). No fallback to legacy PyTorch models.
    """
    return _get_faster_whisper_engine(file_name)


def _get_faster_whisper_engine(model_name: str | None = None) -> FasterWhisperEngine:
    """Load faster-whisper engine with VAD configuration from environment"""
    # Default to the higher-quality base.en CT2 model
    if not model_name:
        model_name = os.environ.get('NOTELY_MODEL_NAME', 'base.en') or 'base.en'

    if model_name not in faster_whisper_engines:
        # Load VAD configuration from environment variables with production-ready defaults
        # VAD is now ENABLED by default with tuned parameters for hallucination reduction
        vad_enabled_env = os.environ.get('NOTELY_ENABLE_VAD', '').strip().lower()
        vad_enabled = vad_enabled_env != 'false'  # Default: True, can be disabled with 'false'
        vad_threshold = float(os.environ.get('NOTELY_VAD_THRESHOLD', '0.6'))
        vad_min_speech_ms = int(os.environ.get('NOTELY_VAD_MIN_SPEECH_MS', '300'))
        vad_min_silence_ms = int(os.environ.get('NOTELY_VAD_MIN_SILENCE_MS', '600'))
        vad_speech_pad_ms = int(os.environ.get('NOTELY_VAD_SPEECH_PAD_MS', '400'))

        # Create engine configuration
        config = TranscriptionConfig(
            model_name=_resolve_ct2_model_path(model_name),
            device=os.environ.get('NOTELY_DEVICE', 'auto'),
            compute_type="default",  # Auto-selects based on device
            language="en",
            temperature=0.1,
            vad_enabled=vad_enabled,
            vad_threshold=vad_threshold,
            vad_min_speech_duration_ms=vad_min_speech_ms,
            vad_min_silence_duration_ms=vad_min_silence_ms,
            vad_speech_pad_ms=vad_speech_pad_ms,
        )

        engine = FasterWhisperEngine(config)
        engine.load_model()

        # Log VAD configuration
        import sys
        if vad_enabled:
            print(f"VAD ENABLED:", file=sys.stderr)
            print(f"   Threshold: {vad_threshold}", file=sys.stderr)
            print(f"   Min speech: {vad_min_speech_ms}ms", file=sys.stderr)
            print(f"   Min silence: {vad_min_silence_ms}ms", file=sys.stderr)
            print(f"   Speech padding: {vad_speech_pad_ms}ms", file=sys.stderr)
            print("-" * 50, file=sys.stderr)
            sys.stderr.flush()
        else:
            print(f"VAD DISABLED", file=sys.stderr)
            sys.stderr.flush()

        faster_whisper_engines[model_name] = engine

    return faster_whisper_engines[model_name]

def transcribe_pcm_chunks(
    model: FasterWhisperEngine,
    chunks: list,
    lang: str = "en",
    temperature: float = 0.1,
    log_prob: float = -0.5,
    initial_prompt: str | None = None,
    prompt: str | None = None,
) -> dict:
    """Transcribe PCM audio chunks to text (faster-whisper only)"""
    return model.transcribe_pcm_chunks(
        chunks,
        language=lang,
        temperature=temperature,
        initial_prompt=initial_prompt,
        prompt=prompt,
    )

async def transcribe_pcm_chunks_async(
    model: FasterWhisperEngine,
    chunks: list,
    lang: str = "en",
    temperature: float = 0.1,
    log_prob: float = -0.5,
    initial_prompt: str | None = None,
    prompt: str | None = None,
) -> dict:
    """Async version of transcribe_pcm_chunks"""
    return await asyncio.get_running_loop().run_in_executor(
        None,
        transcribe_pcm_chunks,
        model,
        chunks,
        lang,
        temperature,
        log_prob,
        initial_prompt,
        prompt,
    )
