"""
Improved FastAPI transcription server (V3)

Key improvements over V2:
1. Full audio transcription - no complex window merging
2. Simple delta encoding - send changes based on text comparison
3. Cleaner state management - simpler tracking
4. Better VAD integration - let VAD handle segmentation
5. Timestamp-based audio tracking - not position heuristics

This provides MS Teams-like streaming transcription quality.
"""

import asyncio
import json
import sys
import uuid
import base64
import re
from typing import Dict, List
from dataclasses import dataclass, field

from fastapi import FastAPI, WebSocket
from starlette.websockets import WebSocketDisconnect, WebSocketState
from faster_whisper import WhisperModel

from utils import pcm_to_float32, compute_rms


app = FastAPI()


def normalize_text(text: str) -> str:
    """Normalize text - collapse whitespace and strip"""
    return ' '.join(text.split()).strip()


def find_common_prefix_length(a: str, b: str) -> int:
    """Find the length of common prefix between two strings"""
    min_len = min(len(a), len(b))
    for i in range(min_len):
        if a[i] != b[i]:
            return i
    return min_len


def detect_word_repetition(text: str, threshold: int = 4) -> tuple[bool, str]:
    """
    Detect and remove repeated consecutive words within text.
    E.g., "American American American" -> "American"

    Args:
        text: Input text
        threshold: Minimum number of consecutive repetitions to detect

    Returns:
        (has_repetition, cleaned_text)
    """
    words = text.split()
    if len(words) < threshold:
        return False, text

    cleaned_words = []
    i = 0
    has_repetition = False

    while i < len(words):
        current_word = words[i].lower().strip('.,!?;:')
        repeat_count = 1

        # Count consecutive repetitions of the same word
        j = i + 1
        while j < len(words):
            next_word = words[j].lower().strip('.,!?;:')
            if next_word == current_word:
                repeat_count += 1
                j += 1
            else:
                break

        if repeat_count >= threshold:
            # Found repetition - keep only one instance
            has_repetition = True
            cleaned_words.append(words[i])
            i = j  # Skip to after the repetitions
            print(f"[HALLUCINATION] Detected word repetition: '{current_word}' x{repeat_count}", file=sys.stderr)
        else:
            # No significant repetition, keep all words
            for k in range(i, j):
                cleaned_words.append(words[k])
            i = j

    cleaned_text = ' '.join(cleaned_words)
    return has_repetition, cleaned_text


def is_hallucination(text: str) -> bool:
    """
    Detect common Whisper hallucinations.
    Returns True if the text appears to be a hallucination.

    NOTE: Be careful not to filter out real conversational speech!
    Words like "like", "you know", "I mean" are common and valid.
    """
    text_lower = text.lower().strip()

    # Common hallucination patterns - SPECIFIC to YouTube/podcast prompts
    hallucination_patterns = [
        # Subscription/channel prompts - require full phrases, not just words
        r'subscribe (to|and|now)',
        r'(hit|click|smash).{0,20}(like|subscribe|bell|notification)',
        r'(like|subscribe).{0,15}(button|channel)',
        r'leave a (like|comment)',
        r'don\'?t forget to (like|subscribe)',
        # Thanks messages (only standalone, not mid-sentence)
        r'^(thank you|thanks)( for watching| for listening)?\.?$',
        # Music indicators (when VAD triggers on noise)
        r'^\[?music\]?$',
        # Empty-ish responses
        r'^(\.+|\s*|you|i|the|a)$',
        # Repetitive single words at start/end (4+ consecutive same words)
        r'^(\w+)(\s+\1){3,}$',
        # Repetitive words anywhere (4+ consecutive same words - increased from 3)
        r'\b(\w+)(\s+\1){3,}\b',
    ]

    for pattern in hallucination_patterns:
        if re.search(pattern, text_lower):
            return True

    # Very short text with low information content
    words = text_lower.split()
    if len(words) <= 2 and len(text_lower) < 10:
        return True

    # Check for excessive word repetition (more than 60% of words are the same)
    # Increased threshold from 50% to 60% to avoid filtering real speech
    if len(words) > 6:  # Increased minimum words to avoid filtering short phrases
        word_counts = {}
        for w in words:
            w_clean = w.strip('.,!?;:').lower()
            if len(w_clean) > 2:  # Skip short words (increased from 1 to 2)
                word_counts[w_clean] = word_counts.get(w_clean, 0) + 1
        if word_counts:
            max_count = max(word_counts.values())
            if max_count > len(words) * 0.6:
                return True

    return False


def detect_phrase_repetition(text: str, min_ngram: int = 5) -> tuple[bool, str]:
    """
    Detect when a phrase from earlier in the text is repeated at the end.
    This catches hallucinations like "...catch a giant marlin. The film is made
    possible by the American author Ernest Hemingway" where the last part
    repeats an earlier phrase.

    Args:
        text: Input text
        min_ngram: Minimum number of words for phrase match

    Returns:
        (has_repetition, cleaned_text)
    """
    words = text.split()
    if len(words) < min_ngram * 2:
        return False, text

    # Look at the last portion of the text (last 30% or so)
    check_start = max(min_ngram, int(len(words) * 0.7))

    # Search for repeated phrases at the end
    best_match_pos = -1
    best_match_len = 0

    for i in range(check_start, len(words) - min_ngram + 1):
        # Get the phrase from position i to the end
        end_phrase = ' '.join(w.lower().strip('.,!?;:') for w in words[i:])

        # Look for this phrase in the first 70% of the text
        for j in range(0, check_start - min_ngram):
            # Check if there's a match starting at position j
            match_len = 0
            for k in range(min(len(words) - i, check_start - j)):
                word1 = words[j + k].lower().strip('.,!?;:')
                word2 = words[i + k].lower().strip('.,!?;:')
                if word1 == word2:
                    match_len += 1
                else:
                    break

            if match_len >= min_ngram and match_len > best_match_len:
                best_match_pos = i
                best_match_len = match_len

    if best_match_pos > 0 and best_match_len >= min_ngram:
        # Found a repeated phrase at the end - truncate
        # Go back a few words to find a sentence boundary
        cut_pos = best_match_pos
        for look_back in range(min(10, cut_pos)):
            idx = cut_pos - look_back - 1
            if idx >= 0 and words[idx].rstrip().endswith(('.', '!', '?')):
                cut_pos = idx + 1
                break

        cleaned_words = words[:cut_pos]
        cleaned_text = ' '.join(cleaned_words)
        print(f"[HALLUCINATION] Detected phrase repetition at word {best_match_pos}, " +
              f"match len={best_match_len}, truncating to {cut_pos} words", file=sys.stderr)
        return True, cleaned_text

    return False, text


def detect_repetition(text: str) -> tuple[bool, str]:
    """
    Detect and remove repetitive phrases in transcription.
    Returns (has_repetition, cleaned_text)
    """
    sentences = re.split(r'(?<=[.!?])\s+', text)
    if len(sentences) < 2:
        return False, text

    # Count sentence occurrences
    sentence_counts = {}
    for sent in sentences:
        sent_lower = sent.lower().strip()
        if len(sent_lower) > 10:  # Only count substantial sentences
            sentence_counts[sent_lower] = sentence_counts.get(sent_lower, 0) + 1

    # Check for repeated sentences
    has_repetition = any(count > 1 for count in sentence_counts.values())

    if not has_repetition:
        return False, text

    # Remove duplicate sentences, keeping first occurrence
    seen = set()
    unique_sentences = []
    for sent in sentences:
        sent_lower = sent.lower().strip()
        if sent_lower not in seen or len(sent_lower) <= 10:
            unique_sentences.append(sent)
            seen.add(sent_lower)

    cleaned = ' '.join(unique_sentences)
    return True, cleaned


def count_unique_words(text: str) -> int:
    """Count unique content words in text"""
    words = re.findall(r'\b[a-z]{3,}\b', text.lower())
    return len(set(words))


def clean_text(text: str) -> str:
    """
    Clean transcribed text - fix common issues and remove artifacts.
    """
    text = normalize_text(text)

    # Remove leading/trailing punctuation artifacts
    text = re.sub(r'^[.,!?;:\s]+', '', text)
    text = re.sub(r'[.,!?;:\s]+$', '', text)

    # Fix double punctuation
    text = re.sub(r'([.!?])\1+', r'\1', text)

    # Fix spacing around punctuation
    text = re.sub(r'\s+([.,!?;:])', r'\1', text)
    text = re.sub(r'([.,!?;:])([A-Za-z])', r'\1 \2', text)

    return normalize_text(text)


@dataclass
class TranscriptionSegment:
    """A single transcription segment with timestamps"""
    text: str
    start_time: float  # Start time in seconds
    end_time: float    # End time in seconds
    segment_id: str = field(default_factory=lambda: str(uuid.uuid4()))


@dataclass
class TranscriptionSession:
    """
    Manages a single transcription session with simplified state tracking.

    Key design: Transcribe ALL accumulated audio each time, then compute
    delta from previous transcription. This is simpler and more accurate
    than trying to merge overlapping windows.
    """
    session_id: str
    websocket: WebSocket
    config: dict
    model: WhisperModel

    # Audio accumulation - simple append-only buffer
    audio_chunks: List[bytes] = field(default_factory=list)
    total_audio_duration_ms: float = 0.0

    # Transcription state - simple previous/current comparison
    last_transcription: str = ""
    best_transcription: str = ""  # Best (longest valid) transcription seen
    last_sent_text: str = ""  # What was actually sent to client (for delta encoding)
    sequence: int = 0

    # Segment timestamps from Whisper
    last_segments: List[TranscriptionSegment] = field(default_factory=list)

    # Control flags
    is_transcribing: bool = False
    silence_count: int = 0  # Consecutive silence periods
    last_transcribe_audio_len: int = 0  # Audio length at last transcription

    # Minimum audio for transcription (in bytes)
    min_audio_bytes: int = 16000 * 2 * 2  # 2 seconds at 16kHz PCM16

    def add_chunk(self, chunk: bytes):
        """Add audio chunk to buffer"""
        self.audio_chunks.append(chunk)
        # PCM16 at 16kHz: 2 bytes per sample, 16000 samples per second
        self.total_audio_duration_ms += (len(chunk) / 2) / 16.0

    def get_total_audio_bytes(self) -> int:
        """Get total audio bytes accumulated"""
        return sum(len(c) for c in self.audio_chunks)

    def has_new_audio(self, min_new_bytes: int = 3200) -> bool:
        """Check if there's enough new audio since last transcription"""
        current_len = self.get_total_audio_bytes()
        return (current_len - self.last_transcribe_audio_len) >= min_new_bytes

    def mark_transcribed(self):
        """Mark current audio position as transcribed"""
        self.last_transcribe_audio_len = self.get_total_audio_bytes()

    async def send_message(self, message: dict):
        """Send message to client via WebSocket"""
        try:
            if self.websocket.client_state == WebSocketState.CONNECTED:
                await self.websocket.send_json(message)
        except Exception as e:
            print(f"ERROR sending message: {e}", file=sys.stderr)


# Global state
sessions: Dict[str, TranscriptionSession] = {}
models: Dict[str, WhisperModel] = {}


def get_or_load_model(model_name: str, use_gpu: bool) -> WhisperModel:
    """Get cached model or load new one"""
    cache_key = f"{model_name}_{use_gpu}"

    if cache_key not in models:
        device = "cuda" if use_gpu else "cpu"
        compute_type = "float16" if use_gpu else "int8"

        print(f"LOADING MODEL: {model_name}", file=sys.stderr)
        print(f"  Device: {device}, Compute type: {compute_type}", file=sys.stderr)

        models[cache_key] = WhisperModel(
            model_name,
            device=device,
            compute_type=compute_type,
        )

        print(f"MODEL LOADED: {model_name}", file=sys.stderr)

    return models[cache_key]


async def transcribe_session(session: TranscriptionSession, is_final: bool = False):
    """
    Transcribe session audio using full-audio approach.

    Key strategy:
    1. Transcribe ALL accumulated audio
    2. Compare to previous transcription
    3. Send delta (what changed)
    4. Track "best" transcription (longest valid)

    This avoids complex window merging and produces cleaner results.
    """
    total_bytes = session.get_total_audio_bytes()

    # Skip if not enough audio yet (unless final)
    if not is_final and total_bytes < session.min_audio_bytes:
        return

    # Skip if no new audio (unless final)
    if not is_final and not session.has_new_audio():
        return

    # Check audio level
    rms = compute_rms(session.audio_chunks)
    min_rms = session.config.get('minWindowRms', 0.0002)

    if rms < min_rms:
        session.silence_count += 1
        if not is_final and session.silence_count < 5:
            return
    else:
        session.silence_count = 0

    # Convert to float32
    audio = pcm_to_float32(session.audio_chunks)
    duration_ms = session.total_audio_duration_ms

    print(f"TRANSCRIBE: Processing {duration_ms:.0f}ms of audio (final={is_final})", file=sys.stderr)

    # Get config
    language = session.config.get('language', 'en')
    beam_size = session.config.get('beamSize', 2)
    temperature = session.config.get('temperature', 0.1)

    # Higher beam size for final for better accuracy
    if is_final:
        beam_size = max(beam_size, session.config.get('refinementBeamSize', 5))
        temperature = session.config.get('refinementTemperature', 0.0)

    # VAD parameters - let VAD handle segmentation
    vad_enabled = session.config.get('vadEnabled', True)
    vad_params = None
    if vad_enabled:
        vad_params = {
            'threshold': session.config.get('vadThreshold', 0.25),
            'min_speech_duration_ms': session.config.get('vadMinSpeechDurationMs', 150),
            'min_silence_duration_ms': session.config.get('vadMinSilenceDurationMs', 400),
            'speech_pad_ms': session.config.get('vadSpeechPadMs', 350),
        }

    try:
        # Transcribe FULL audio
        segments_gen, info = await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: session.model.transcribe(
                audio,
                language=language,
                temperature=temperature,
                beam_size=beam_size,
                vad_filter=vad_enabled,
                vad_parameters=vad_params,
            )
        )

        # Collect all segments with timestamps
        whisper_segments = list(segments_gen)

        # Store segments with timestamps
        session.last_segments = [
            TranscriptionSegment(
                text=seg.text.strip(),
                start_time=seg.start,
                end_time=seg.end,
            )
            for seg in whisper_segments if seg.text.strip()
        ]

        # Build full transcription
        raw_text = ' '.join(seg.text for seg in session.last_segments)
        new_text = clean_text(raw_text)

        print(f"  Raw segments: {len(whisper_segments)}", file=sys.stderr)
        print(f"  New text ({len(new_text)} chars): {new_text[:100]}{'...' if len(new_text) > 100 else ''}", file=sys.stderr)

        # Skip hallucinations
        if is_hallucination(new_text):
            print(f"  Skipping hallucination: '{new_text}'", file=sys.stderr)
            session.mark_transcribed()
            return

        # Check for and clean up sentence-level repetitions
        has_repetition, cleaned_text = detect_repetition(new_text)
        if has_repetition:
            print(f"  Detected sentence repetition! Cleaning {len(new_text)} -> {len(cleaned_text)} chars", file=sys.stderr)
            new_text = cleaned_text

        # Check for and clean up word-level repetitions (e.g., "American American American")
        has_word_rep, word_cleaned = detect_word_repetition(new_text, threshold=4)
        if has_word_rep:
            print(f"  Detected word repetition! Cleaning {len(new_text)} -> {len(word_cleaned)} chars", file=sys.stderr)
            new_text = word_cleaned

        # Check for phrase repetition at end (hallucinated repetition of earlier content)
        has_phrase_rep, phrase_cleaned = detect_phrase_repetition(new_text, min_ngram=5)
        if has_phrase_rep:
            print(f"  Detected phrase repetition! Cleaning {len(new_text)} -> {len(phrase_cleaned)} chars", file=sys.stderr)
            new_text = phrase_cleaned

        # Update best transcription based on QUALITY not LENGTH
        # Quality = unique word count (avoids repetitive hallucinations)
        prev_text = session.best_transcription
        new_unique = count_unique_words(new_text)
        prev_unique = count_unique_words(prev_text) if prev_text else 0

        if not prev_text:
            # First transcription
            session.best_transcription = new_text
            session.last_transcription = new_text
            print(f"  First transcription: {len(new_text)} chars, {new_unique} unique words", file=sys.stderr)
        elif new_unique >= prev_unique:
            # New has more unique content - likely better
            session.best_transcription = new_text
            session.last_transcription = new_text
            print(f"  Better transcription: {new_unique} vs {prev_unique} unique words", file=sys.stderr)
        else:
            # Previous was better (more unique content)
            session.last_transcription = new_text
            print(f"  Keeping previous: {prev_unique} vs {new_unique} unique words", file=sys.stderr)

        session.mark_transcribed()

        # Determine what to send
        current_text = session.best_transcription
        prev_sent = session.last_sent_text  # Use what was actually sent, not last_transcription

        # Skip if no meaningful change from what we last sent
        if current_text == prev_sent and not is_final:
            print(f"  No change, skipping update", file=sys.stderr)
            return

        # Calculate delta from what was previously sent
        prefix_len = find_common_prefix_length(prev_sent, current_text)
        tail = current_text[prefix_len:]

        session.sequence += 1

        if is_final:
            # Send full final text with segment timestamps
            print(f"FINAL: Sending complete text ({len(current_text)} chars) with {len(session.last_segments)} segments", file=sys.stderr)
            print(f"  Text: {current_text}", file=sys.stderr)

            # Build segments with timestamps for the client
            segments_with_timestamps = []
            for seg in session.last_segments:
                segments_with_timestamps.append({
                    'text': seg.text,
                    'segmentId': seg.segment_id,
                    'startTime': seg.start_time,
                    'endTime': seg.end_time,
                })

            await session.send_message({
                'type': 'final_batch',
                'segments': segments_with_timestamps,
                'totalSegments': len(segments_with_timestamps),
                'fullText': current_text,  # Also send the cleaned full text
                'sequence': session.sequence,
            })
        else:
            # Send partial with delta encoding
            print(f"PARTIAL: seq={session.sequence}, prefix={prefix_len}, tail_len={len(tail)}", file=sys.stderr)

            await session.send_message({
                'type': 'partial',
                'text': tail,
                'prefixLength': prefix_len,
                'sequence': session.sequence,
                'segmentId': str(uuid.uuid4()),
            })

        # Track what we actually sent
        session.last_sent_text = current_text

    except Exception as e:
        print(f"TRANSCRIBE ERROR: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket endpoint for real-time transcription"""
    await websocket.accept()

    session_id = str(uuid.uuid4())
    session = None

    print(f"WebSocket connected: {session_id}", file=sys.stderr)

    try:
        # Wait for config message
        data = await websocket.receive_json()

        if data.get('type') != 'config':
            print(f"ERROR: Expected config message, got {data.get('type')}", file=sys.stderr)
            await websocket.close()
            return

        config = data.get('config', {})
        print(f"Received config: {json.dumps(config, indent=2)}", file=sys.stderr)

        # Load model
        model_name = config.get('modelName', 'base.en')
        use_gpu = config.get('useGpu', False)
        model = get_or_load_model(model_name, use_gpu)

        # Create session
        session = TranscriptionSession(
            session_id=session_id,
            websocket=websocket,
            config=config,
            model=model,
        )
        sessions[session_id] = session

        # Send hello
        await session.send_message({
            'type': 'hello',
            'sessionId': session_id,
            'protocol': 'v3',
        })

        # Background transcription task
        transcription_task = None
        transcription_interval = config.get('heartbeatIntervalMs', 2000) / 1000.0

        async def periodic_transcribe():
            """Periodically transcribe accumulated audio"""
            while True:
                await asyncio.sleep(transcription_interval)
                if session.audio_chunks:
                    await transcribe_session(session, is_final=False)

        transcription_task = asyncio.create_task(periodic_transcribe())

        # Main message loop
        while True:
            data = await websocket.receive_json()
            msg_type = data.get('type')

            if msg_type == 'audio':
                # Decode and add audio
                audio_b64 = data.get('bytes', '')
                audio_bytes = base64.b64decode(audio_b64)
                session.add_chunk(audio_bytes)

            elif msg_type == 'stop':
                print(f"Stop signal received: {session_id}", file=sys.stderr)

                # Cancel periodic task
                if transcription_task:
                    transcription_task.cancel()
                    try:
                        await transcription_task
                    except asyncio.CancelledError:
                        pass

                # Send current best transcription IMMEDIATELY as final
                # This ensures the client receives it before timeout
                current_text = session.best_transcription
                if current_text:
                    print(f"FINAL (immediate): Sending best transcription ({len(current_text)} chars) with {len(session.last_segments)} segments", file=sys.stderr)
                    print(f"  Text: {current_text}", file=sys.stderr)

                    # Build segments with timestamps
                    segments_with_timestamps = []
                    for seg in session.last_segments:
                        segments_with_timestamps.append({
                            'text': seg.text,
                            'segmentId': seg.segment_id,
                            'startTime': seg.start_time,
                            'endTime': seg.end_time,
                        })

                    session.sequence += 1
                    await session.send_message({
                        'type': 'final_batch',
                        'segments': segments_with_timestamps,
                        'totalSegments': len(segments_with_timestamps),
                        'fullText': current_text,
                        'sequence': session.sequence,
                    })
                else:
                    # No transcription yet - do a quick final transcription
                    print(f"No best transcription yet, doing final transcription", file=sys.stderr)
                    await transcribe_session(session, is_final=True)

                break

            else:
                print(f"Unknown message type: {msg_type}", file=sys.stderr)

    except WebSocketDisconnect:
        print(f"WebSocket disconnected: {session_id}", file=sys.stderr)
    except Exception as e:
        print(f"WebSocket error: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
    finally:
        if session_id in sessions:
            del sessions[session_id]
        print(f"Session cleaned up: {session_id}", file=sys.stderr)


@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {
        "status": "healthy",
        "version": "v3",
        "sessions": len(sessions),
        "models_loaded": len(models),
    }


@app.post("/refine")
async def refine_transcription(request: dict):
    """
    Refine transcription using second pass with higher beam size.

    Expects:
        - wav_path: Path to WAV file
        - model_name: Model to use (default: small.en)
        - beam_size: Beam size for refinement (default: 5)
        - hints: Optional user corrections to guide transcription (passed as initial_prompt)

    Returns:
        - text: Refined transcription
        - duration_ms: Audio duration in milliseconds
        - used_hints: Whether hints were applied
    """
    import soundfile as sf

    wav_path = request.get('wav_path')
    model_name = request.get('model_name', 'small.en')
    beam_size = request.get('beam_size', 5)
    use_gpu = request.get('use_gpu', False)
    hints = request.get('hints')  # User corrections to bias transcription

    if not wav_path:
        return {"error": "wav_path is required", "success": False}

    print(f"REFINE: Starting refinement of {wav_path}", file=sys.stderr)
    print(f"  Model: {model_name}, Beam size: {beam_size}", file=sys.stderr)
    if hints:
        print(f"  Hints provided: {hints[:100]}{'...' if len(hints) > 100 else ''}", file=sys.stderr)
        print(f"  Using hints as initial_prompt to guide transcription", file=sys.stderr)

    try:
        import numpy as np

        # Load audio file
        audio, sample_rate = sf.read(wav_path, dtype='float32')

        # Ensure float32 (Whisper requirement)
        audio = np.asarray(audio, dtype=np.float32)

        # Ensure mono
        if len(audio.shape) > 1:
            audio = audio.mean(axis=1).astype(np.float32)

        # Resample if needed (Whisper expects 16kHz)
        if sample_rate != 16000:
            # Simple resampling - for production use scipy.signal.resample
            ratio = 16000 / sample_rate
            new_length = int(len(audio) * ratio)
            audio = np.interp(
                np.linspace(0, len(audio) - 1, new_length),
                np.arange(len(audio)),
                audio
            ).astype(np.float32)
            sample_rate = 16000

        duration_ms = len(audio) / sample_rate * 1000
        print(f"  Audio loaded: {duration_ms:.0f}ms at {sample_rate}Hz", file=sys.stderr)

        # Get/load model
        model = get_or_load_model(model_name, use_gpu)

        # Build transcribe parameters
        transcribe_params = {
            'language': 'en',
            'temperature': 0.0,  # Greedy for refinement
            'beam_size': beam_size,
            'vad_filter': True,
            'vad_parameters': {
                'threshold': 0.25,
                'min_speech_duration_ms': 150,
                'min_silence_duration_ms': 400,
                'speech_pad_ms': 350,
            },
        }

        # Add user corrections as initial_prompt to bias transcription
        # This helps Whisper prefer words/phrases the user has confirmed as correct
        if hints:
            transcribe_params['initial_prompt'] = hints
            print(f"  Applying initial_prompt from user hints", file=sys.stderr)

        # Transcribe with higher beam size for accuracy
        segments_gen, info = await asyncio.get_running_loop().run_in_executor(
            None,
            lambda: model.transcribe(audio, **transcribe_params)
        )

        # Collect segments
        segments = list(segments_gen)

        # Build full transcription
        raw_text = ' '.join(seg.text.strip() for seg in segments if seg.text.strip())
        refined_text = clean_text(raw_text)

        print(f"  Raw segments: {len(segments)}", file=sys.stderr)

        # For refinement with beam_size=5, only apply light filtering
        # Skip aggressive word/phrase repetition filters as beam search handles quality
        has_rep, refined_text = detect_repetition(refined_text)  # Only remove exact duplicate sentences
        # Skip word-level filter: has_word_rep, refined_text = detect_word_repetition(refined_text, threshold=4)
        # Skip phrase-level filter: has_phrase_rep, refined_text = detect_phrase_repetition(refined_text, min_ngram=5)

        print(f"REFINE COMPLETE: {len(refined_text)} chars", file=sys.stderr)
        print(f"  Text: {refined_text[:100]}{'...' if len(refined_text) > 100 else ''}", file=sys.stderr)
        if hints:
            print(f"  Hints were applied via initial_prompt", file=sys.stderr)

        return {
            "text": refined_text,
            "duration_ms": duration_ms,
            "success": True,
            "used_hints": bool(hints),
        }

    except Exception as e:
        print(f"REFINE ERROR: {e}", file=sys.stderr)
        import traceback
        traceback.print_exc(file=sys.stderr)
        return {"error": str(e), "success": False}


if __name__ == "__main__":
    import uvicorn
    import os

    port = int(os.environ.get("PORT", "8181"))
    print("=" * 70, file=sys.stderr)
    print(f"STARTING TRANSCRIPTION SERVER V3", file=sys.stderr)
    print(f"Port: {port}", file=sys.stderr)
    print(f"Host: 127.0.0.1", file=sys.stderr)
    print("=" * 70, file=sys.stderr)

    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
