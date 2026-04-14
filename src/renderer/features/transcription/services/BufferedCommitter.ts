export interface BufferConfig {
  maxBufferTime: number; // Default: 8000ms - Hard timeout
  maxWordCount: number; // Default: 40 words - Size limit
  sentenceBoundaryDelay: number; // Default: 600ms - Wait after punctuation
  flushCheckInterval: number; // Default: 300ms - Check frequency
  minFlushLength: number; // Default: 3 words - Minimum commit size
}

export class BufferedCommitter {
  private segments: string[] = [];
  private lastActivityTime: number = Date.now();
  private flushTimer?: NodeJS.Timeout;
  private checkTimer?: NodeJS.Timeout;
  private isDestroyed = false;

  private readonly config: BufferConfig = {
    maxBufferTime: 8000,
    maxWordCount: 40,
    sentenceBoundaryDelay: 600,
    flushCheckInterval: 300,
    minFlushLength: 3,
  };

  constructor(
    private onFlush: (text: string) => Promise<void>,
    options: Partial<BufferConfig> = {}
  ) {
    this.config = { ...this.config, ...options };
    this.startCheckTimer();
  }

  public addSegment(text: string): void {
    if (this.isDestroyed || !text?.trim()) return;

    console.log('BufferedCommitter: Adding segment, length:', text.length);
    this.segments.push(text.trim());
    this.lastActivityTime = Date.now();

    // Check flush conditions immediately
    this.checkFlushConditions();
  }

  public clearBuffer(): void {
    this.segments = [];
    this.lastActivityTime = Date.now();
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    console.log('BufferedCommitter: Buffer cleared (batch final)');
  }

  public async forceFlush(): Promise<void> {
    if (this.isDestroyed) return;
    console.log('BufferedCommitter: Force flushing buffer');
    await this.flush();
  }

  public destroy(): void {
    console.log('BufferedCommitter: Destroying instance');
    this.isDestroyed = true;

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }

    // Final flush of any remaining content
    if (this.segments.length > 0) {
      this.flush().catch(console.error);
    }
  }

  private startCheckTimer(): void {
    if (this.isDestroyed) return;

    this.checkTimer = setInterval(() => {
      this.checkFlushConditions();
    }, this.config.flushCheckInterval);
  }

  private checkFlushConditions(): void {
    if (this.isDestroyed || this.segments.length === 0) return;

    const shouldFlush = this.shouldFlush();
    console.log('BufferedCommitter: Check flush conditions -', {
      shouldFlush,
      segmentCount: this.segments.length,
      bufferAge: Date.now() - this.lastActivityTime,
      wordCount: this.getWordCount(),
    });

    if (shouldFlush) {
      this.scheduleFlush();
    }
  }

  private shouldFlush(): boolean {
    if (this.segments.length === 0) return false;

    const _text = this.segments.join(' ');
    const wordCount = this.getWordCount();
    const timeSinceLastActivity = Date.now() - this.lastActivityTime;

    // 1. Hard timeout - always flush after max time
    if (timeSinceLastActivity >= this.config.maxBufferTime) {
      console.log('BufferedCommitter: Hard timeout reached');
      return true;
    }

    // 2. Word count limit
    if (wordCount >= this.config.maxWordCount) {
      console.log('BufferedCommitter: Word count limit reached:', wordCount);
      return true;
    }

    // 3. Sentence boundary detection
    if (this.detectSentenceBoundary()) {
      console.log('BufferedCommitter: Sentence boundary detected');
      return true;
    }

    return false;
  }

  private detectSentenceBoundary(): boolean {
    if (this.segments.length === 0) return false;

    const text = this.segments.join(' ');
    const timeSinceLastActivity = Date.now() - this.lastActivityTime;

    // Check for sentence-ending punctuation + pause
    if (
      /[.!?]\s*$/.test(text.trim()) &&
      timeSinceLastActivity >= this.config.sentenceBoundaryDelay
    ) {
      return true;
    }

    // Check for natural pause (no new segments for specified delay)
    if (timeSinceLastActivity >= this.config.sentenceBoundaryDelay && text.trim().length > 0) {
      return true;
    }

    return false;
  }

  private getWordCount(): number {
    return this.segments
      .join(' ')
      .split(/\s+/)
      .filter((word) => word.length > 0).length;
  }

  private scheduleFlush(): void {
    if (this.isDestroyed || this.flushTimer) return; // Already scheduled

    // For sentence boundaries, add a small delay to allow for corrections
    const delay = this.detectSentenceBoundary() ? 100 : 0;

    this.flushTimer = setTimeout(() => {
      this.flush().catch(console.error);
    }, delay);
  }

  private async flush(): Promise<void> {
    if (this.isDestroyed || this.segments.length === 0) return;

    const text = this.segments.join(' ').trim();
    const wordCount = this.getWordCount();

    // Don't flush if below minimum length (unless forced by timeout)
    const timeSinceLastActivity = Date.now() - this.lastActivityTime;
    if (
      wordCount < this.config.minFlushLength &&
      timeSinceLastActivity < this.config.maxBufferTime
    ) {
      console.log('BufferedCommitter: Skipping flush - below minimum length:', wordCount);
      return;
    }

    console.log('BufferedCommitter: Flushing buffer -', {
      textLength: text.length,
      wordCount,
      segmentCount: this.segments.length,
    });

    // Clear the buffer before calling onFlush to prevent reentrant calls
    this.segments = [];

    // Clear the flush timer
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    try {
      await this.onFlush(text);
      console.log('BufferedCommitter: Flush completed successfully');
    } catch (error) {
      console.error('BufferedCommitter: Flush failed:', error);
      // Don't re-add segments on failure to avoid infinite loops
      throw error;
    }
  }

  // Debug methods
  public getBufferState(): { segments: string[]; wordCount: number; age: number } {
    return {
      segments: [...this.segments],
      wordCount: this.getWordCount(),
      age: Date.now() - this.lastActivityTime,
    };
  }
}
