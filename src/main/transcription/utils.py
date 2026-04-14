"""
Audio utility functions for transcription
"""

import array
import math
import numpy as np
from typing import List


def pcm_to_float32(chunks: List[bytes]) -> np.ndarray:
    """
    Convert PCM16 chunks to float32 numpy array normalized to [-1, 1]

    Args:
        chunks: List of PCM16 byte chunks

    Returns:
        Float32 numpy array normalized to [-1, 1] for faster-whisper
    """
    if not chunks:
        return np.array([], dtype=np.float32)

    # Concatenate all chunks
    pcm_data = b''.join(chunks)

    # Convert to int16 array
    samples = array.array('h')
    samples.frombytes(pcm_data)

    # Convert to numpy float32 and normalize to [-1, 1]
    audio = np.array(samples, dtype=np.float32) / 32768.0

    return audio


def compute_rms(chunks: List[bytes]) -> float:
    """
    Compute normalized RMS (0-1) for PCM16 chunks

    Args:
        chunks: List of PCM16 byte chunks

    Returns:
        RMS value normalized to 0-1
    """
    if not chunks:
        return 0.0

    samples = array.array('h')
    for chunk in chunks:
        if chunk:
            samples.frombytes(chunk)

    if not samples:
        return 0.0

    mean_square = sum(s * s for s in samples) / len(samples)
    return math.sqrt(mean_square) / 32768.0


def get_audio_duration_ms(chunks: List[bytes], sample_rate: int = 16000) -> float:
    """
    Calculate total duration of audio chunks in milliseconds

    Args:
        chunks: List of PCM16 byte chunks
        sample_rate: Sample rate in Hz (default: 16000)

    Returns:
        Duration in milliseconds
    """
    if not chunks:
        return 0.0

    total_bytes = sum(len(chunk) for chunk in chunks)
    bytes_per_sample = 2  # PCM16 = 2 bytes per sample
    total_samples = total_bytes / bytes_per_sample
    duration_ms = (total_samples / sample_rate) * 1000

    return duration_ms
