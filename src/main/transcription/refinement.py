"""
Simple async refinement module

Re-transcribes finalized segments with higher-accuracy parameters (beam_size=5)
to improve quality without blocking real-time transcription.
"""

import asyncio
import sys
from typing import Optional, Callable
from faster_whisper import WhisperModel

from utils import pcm_to_float32


class SimpleRefinement:
    """
    Simple async refinement handler

    Re-transcribes segments with beam_size=5 for better accuracy.
    No queue complexity - just async tasks.
    """

    def __init__(self, model: WhisperModel, config: dict):
        """
        Initialize refinement handler

        Args:
            model: Shared WhisperModel instance
            config: Transcription configuration dict
        """
        self.model = model
        self.config = config
        self.active_tasks = {}

    async def refine_segment(
        self,
        segment_id: str,
        original_text: str,
        audio_chunks: list,
        on_complete: Callable[[str, str, str], None]
    ) -> None:
        """
        Refine a segment with better parameters

        Args:
            segment_id: Unique segment identifier
            original_text: Original transcribed text
            audio_chunks: Audio chunks for this segment
            on_complete: Callback(segment_id, original_text, refined_text)
        """
        try:
            # Wait before refining (let user continue speaking)
            delay_ms = self.config.get('refinementDelayMs', 2000)
            await asyncio.sleep(delay_ms / 1000.0)

            # Convert audio to float32
            audio = pcm_to_float32(audio_chunks)

            if len(audio) == 0:
                print(f"REFINEMENT: No audio for segment {segment_id}, skipping", file=sys.stderr)
                return

            # Re-transcribe with higher accuracy parameters
            beam_size = self.config.get('refinementBeamSize', 5)
            temperature = self.config.get('refinementTemperature', 0.0)
            language = self.config.get('language', 'en')

            print(f"REFINEMENT: Starting for segment {segment_id}", file=sys.stderr)
            print(f"  Audio duration: {len(audio) / 16000.0:.2f}s", file=sys.stderr)
            print(f"  Original text: '{original_text[:50]}...'", file=sys.stderr)
            print(f"  Params: beam_size={beam_size}, temperature={temperature}", file=sys.stderr)

            # Run in executor to avoid blocking event loop
            segments_gen, info = await asyncio.get_running_loop().run_in_executor(
                None,
                lambda: self.model.transcribe(
                    audio,
                    language=language,
                    temperature=temperature,
                    beam_size=beam_size,
                    vad_filter=False,  # Already segmented
                )
            )

            # Extract text from segments
            refined_segments = list(segments_gen)
            refined_text = ' '.join(seg.text.strip() for seg in refined_segments).strip()

            print(f"REFINEMENT: Complete for segment {segment_id}", file=sys.stderr)
            print(f"  Refined text: '{refined_text[:50]}...'", file=sys.stderr)
            print(f"  Changed: {refined_text != original_text}", file=sys.stderr)

            # Only send refinement if text actually changed
            if refined_text and refined_text != original_text:
                await on_complete(segment_id, original_text, refined_text)
            else:
                print(f"REFINEMENT: Text unchanged, not sending update", file=sys.stderr)

        except Exception as e:
            print(f"REFINEMENT ERROR for segment {segment_id}: {e}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
        finally:
            # Remove from active tasks
            self.active_tasks.pop(segment_id, None)

    def start_refinement(
        self,
        segment_id: str,
        original_text: str,
        audio_chunks: list,
        on_complete: Callable[[str, str, str], None]
    ) -> None:
        """
        Start async refinement task

        Args:
            segment_id: Unique segment identifier
            original_text: Original transcribed text
            audio_chunks: Audio chunks for this segment
            on_complete: Callback(segment_id, original_text, refined_text)
        """
        if not self.config.get('refinementEnabled', True):
            return

        # Cancel any existing refinement for this segment
        if segment_id in self.active_tasks:
            self.active_tasks[segment_id].cancel()

        # Start new refinement task
        task = asyncio.create_task(
            self.refine_segment(segment_id, original_text, audio_chunks, on_complete)
        )
        self.active_tasks[segment_id] = task

    async def cancel_all(self) -> None:
        """Cancel all active refinement tasks"""
        for task in self.active_tasks.values():
            task.cancel()

        # Wait for all tasks to complete
        if self.active_tasks:
            await asyncio.gather(*self.active_tasks.values(), return_exceptions=True)

        self.active_tasks.clear()
