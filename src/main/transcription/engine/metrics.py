"""
Performance metrics tracking for transcription engine
"""

import time
import functools
from typing import Callable, List
from collections import deque


class LatencyTracker:
    """Track latency metrics with P50/P95 calculation"""

    def __init__(self, name: str, window_size: int = 100):
        self.name = name
        self.window_size = window_size
        self.latencies: deque = deque(maxlen=window_size)

    def record(self, latency_ms: float):
        """Record a latency measurement"""
        self.latencies.append(latency_ms)

    def get_stats(self) -> dict:
        """Get current statistics"""
        if not self.latencies:
            return {
                "name": self.name,
                "count": 0,
                "p50": 0,
                "p95": 0,
                "mean": 0,
            }

        sorted_latencies = sorted(self.latencies)
        count = len(sorted_latencies)

        p50_idx = int(count * 0.50)
        p95_idx = int(count * 0.95)

        return {
            "name": self.name,
            "count": count,
            "p50": sorted_latencies[min(p50_idx, count - 1)],
            "p95": sorted_latencies[min(p95_idx, count - 1)],
            "mean": sum(sorted_latencies) / count,
        }

    def log_stats(self):
        """Print current statistics"""
        stats = self.get_stats()
        if stats["count"] > 0:
            print(
                f"[{stats['name']}] "
                f"Count: {stats['count']}, "
                f"P50: {stats['p50']:.1f}ms, "
                f"P95: {stats['p95']:.1f}ms, "
                f"Mean: {stats['mean']:.1f}ms"
            )


def track_latency(tracker: LatencyTracker) -> Callable:
    """Decorator to track function execution latency"""

    def decorator(func: Callable) -> Callable:
        @functools.wraps(func)
        def sync_wrapper(*args, **kwargs):
            start = time.time()
            result = func(*args, **kwargs)
            latency = (time.time() - start) * 1000
            tracker.record(latency)
            return result

        @functools.wraps(func)
        async def async_wrapper(*args, **kwargs):
            start = time.time()
            result = await func(*args, **kwargs)
            latency = (time.time() - start) * 1000
            tracker.record(latency)
            return result

        # Return appropriate wrapper based on function type
        import asyncio

        if asyncio.iscoroutinefunction(func):
            return async_wrapper
        else:
            return sync_wrapper

    return decorator
