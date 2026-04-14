/**
 * Desktop Memory Management and Performance Budgets
 *
 * Manages memory usage and performance budgets for sync v2 operations
 * Implements memory monitoring, cache management, and performance tracking
 *
 * References:
 * - /notely/SYNC_RE_ARCHITECTURE.md - Performance Requirements
 * - /notely/SYNC_V2_PERFORMANCE_BUDGETS.md - Performance budgets and tracking
 * - /notely/SYNC_RE_ARCHITECTURE_TODO.md - Phase 6 requirements
 *
 * Date: 2025-09-09
 */

import { EventEmitter } from 'events';

import { app } from 'electron';

import { logger } from '../../logger';

/**
 * Performance budget configuration
 */
export interface PerformanceBudgets {
  // Memory budgets (MB)
  maxMemoryUsageMB: number;
  merkleTreeCacheMB: number;
  entityCacheMB: number;
  tempBuffersMB: number;

  // Time budgets (ms)
  maxSyncDurationMs: number;
  maxHashComputationMs: number;
  maxDiffComputationMs: number;
  maxMergeOperationMs: number;

  // Size budgets
  maxPayloadSizeMB: number;
  maxEntityCount: number;
  maxTreeDepth: number;

  // Performance thresholds
  warningMemoryThresholdPercent: number;
  criticalMemoryThresholdPercent: number;
  maxConsecutiveSlowOperations: number;
}

/**
 * Memory usage snapshot
 */
export interface MemoryUsage {
  totalUsedMB: number;
  mainProcessMB: number;
  rendererProcessesMB: number;
  merkleTreeCacheMB: number;
  entityCacheMB: number;
  tempBuffersMB: number;
  systemMemoryMB: number;
  percentageOfBudget: number;
  processCount: number;
  timestamp: number;
}

/**
 * Performance metrics
 */
export interface PerformanceMetrics {
  // Operation timings
  lastSyncDurationMs: number;
  averageSyncDurationMs: number;
  lastHashComputationMs: number;
  lastDiffComputationMs: number;
  lastMergeOperationMs: number;

  // Memory metrics
  currentMemoryUsage: MemoryUsage;
  peakMemoryUsageMB: number;
  averageMemoryUsageMB: number;

  // Performance counters
  totalOperations: number;
  slowOperations: number;
  memoryWarnings: number;
  budgetExceeded: number;

  // Cache metrics
  cacheHitRate: number;
  cacheEvictions: number;
  cacheSize: number;

  timestamp: number;
}

/**
 * Performance event types
 */
export interface PerformanceEvents {
  'memory-warning': (usage: MemoryUsage) => void;
  'memory-critical': (usage: MemoryUsage) => void;
  'budget-exceeded': (budget: keyof PerformanceBudgets, value: number, limit: number) => void;
  'slow-operation': (operation: string, durationMs: number, budgetMs: number) => void;
  'cache-eviction': (reason: string, itemsEvicted: number) => void;
}

/**
 * Cache entry with metadata
 */
interface CacheEntry<T> {
  key: string;
  value: T;
  size: number;
  lastAccessed: number;
  accessCount: number;
  createdAt: number;
}

/**
 * Desktop Memory Manager for Sync v2
 */
export class DesktopMemoryManager extends EventEmitter {
  private static readonly DEFAULT_BUDGETS: PerformanceBudgets = {
    // Memory budgets (from SYNC_V2_PERFORMANCE_BUDGETS.md)
    maxMemoryUsageMB: 50,
    merkleTreeCacheMB: 20,
    entityCacheMB: 15,
    tempBuffersMB: 10,

    // Time budgets
    maxSyncDurationMs: 2000, // <2s typical sync
    maxHashComputationMs: 100, // <100ms per hash
    maxDiffComputationMs: 200, // <200ms diff computation
    maxMergeOperationMs: 500, // <500ms merge operation

    // Size budgets
    maxPayloadSizeMB: 1, // <1MB per call
    maxEntityCount: 10000, // 10k entities
    maxTreeDepth: 10, // Maximum tree depth

    // Performance thresholds
    warningMemoryThresholdPercent: 75,
    criticalMemoryThresholdPercent: 90,
    maxConsecutiveSlowOperations: 3,
  };

  private budgets: PerformanceBudgets;
  private metrics: PerformanceMetrics;
  private caches = new Map<string, Map<string, CacheEntry<unknown>>>();
  private operationTimings: { [operation: string]: number[] } = {};
  private consecutiveSlowOps = 0;
  private monitoringInterval?: NodeJS.Timeout;
  private isInitialized = false;

  constructor(customBudgets?: Partial<PerformanceBudgets>) {
    super();
    this.budgets = {
      ...DesktopMemoryManager.DEFAULT_BUDGETS,
      ...customBudgets,
    };
    this.metrics = this.createEmptyMetrics();
  }

  /**
   * Initialize memory manager
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      this.startMemoryMonitoring();
      this.isInitialized = true;

      logger.info('[MemoryManager] Initialized with budgets', {
        maxMemoryMB: this.budgets.maxMemoryUsageMB,
        maxSyncMs: this.budgets.maxSyncDurationMs,
        maxPayloadMB: this.budgets.maxPayloadSizeMB,
      });
    } catch (error) {
      logger.error('[MemoryManager] Failed to initialize:', error);
      throw error;
    }
  }

  /**
   * Start monitoring memory usage
   */
  private startMemoryMonitoring(): void {
    // Monitor memory every 5 seconds
    this.monitoringInterval = setInterval(() => {
      this.updateMemoryMetrics();
      this.checkMemoryThresholds();
    }, 5000);
  }

  /**
   * Create cache with memory management
   */
  createCache<T>(
    name: string,
    maxSizeMB: number
  ): {
    get: (key: string) => T | undefined;
    set: (key: string, value: T) => void;
    delete: (key: string) => boolean;
    clear: () => void;
    size: () => number;
  } {
    const cache = new Map<string, CacheEntry<T>>();
    this.caches.set(name, cache as Map<string, CacheEntry<unknown>>);

    return {
      get: (key: string) => {
        const entry = cache.get(key);
        if (entry) {
          entry.lastAccessed = Date.now();
          entry.accessCount++;
          this.metrics.cacheHitRate = this.calculateCacheHitRate();
          return entry.value;
        }
        return undefined;
      },

      set: (key: string, value: T) => {
        const size = this.estimateObjectSize(value);
        const entry: CacheEntry<T> = {
          key,
          value,
          size,
          lastAccessed: Date.now(),
          accessCount: 1,
          createdAt: Date.now(),
        };

        // Check if adding this entry would exceed memory budget
        const currentSize = this.getCacheSize(cache as Map<string, CacheEntry<unknown>>);
        const maxSizeBytes = maxSizeMB * 1024 * 1024;

        if (currentSize + size > maxSizeBytes) {
          this.evictCacheEntries(cache as Map<string, CacheEntry<unknown>>, size);
        }

        cache.set(key, entry);
      },

      delete: (key: string) => {
        return cache.delete(key);
      },

      clear: () => {
        cache.clear();
      },

      size: () => {
        return cache.size;
      },
    };
  }

  /**
   * Time an operation and check against budget
   */
  async timeOperation<T>(
    operationName: string,
    operation: () => Promise<T>,
    budgetMs?: number
  ): Promise<T> {
    const startTime = Date.now();

    try {
      const result = await operation();
      const duration = Date.now() - startTime;

      this.recordOperationTiming(operationName, duration);

      // Check against budget if provided
      const budget = budgetMs || this.getBudgetForOperation(operationName);
      if (budget && duration > budget) {
        this.handleSlowOperation(operationName, duration, budget);
      } else {
        this.consecutiveSlowOps = 0; // Reset counter on successful operation
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      this.recordOperationTiming(operationName, duration);
      throw error;
    }
  }

  /**
   * Check payload size against budget
   */
  checkPayloadSize(sizeBytes: number, operationName: string): boolean {
    const sizeMB = sizeBytes / (1024 * 1024);
    const budget = this.budgets.maxPayloadSizeMB;

    if (sizeMB > budget) {
      logger.warn('[MemoryManager] Payload size exceeds budget', {
        operation: operationName,
        sizeMB: sizeMB.toFixed(2),
        budgetMB: budget,
      });

      this.emit('budget-exceeded', 'maxPayloadSizeMB', sizeMB, budget);
      this.metrics.budgetExceeded++;
      return false;
    }

    return true;
  }

  /**
   * Check entity count against budget
   */
  checkEntityCount(count: number, operationName: string): boolean {
    const budget = this.budgets.maxEntityCount;

    if (count > budget) {
      logger.warn('[MemoryManager] Entity count exceeds budget', {
        operation: operationName,
        count,
        budget,
      });

      this.emit('budget-exceeded', 'maxEntityCount', count, budget);
      this.metrics.budgetExceeded++;
      return false;
    }

    return true;
  }

  /**
   * Get current performance metrics
   */
  getMetrics(): PerformanceMetrics {
    this.updateMemoryMetrics();
    return { ...this.metrics };
  }

  /**
   * Get current budgets
   */
  getBudgets(): PerformanceBudgets {
    return { ...this.budgets };
  }

  /**
   * Update performance budgets
   */
  updateBudgets(updates: Partial<PerformanceBudgets>): void {
    this.budgets = { ...this.budgets, ...updates };
    logger.info('[MemoryManager] Budgets updated', updates);
  }

  /**
   * Force garbage collection (if available)
   */
  forceGarbageCollection(): void {
    if (global.gc) {
      logger.debug('[MemoryManager] Forcing garbage collection');
      global.gc();
      this.updateMemoryMetrics();
    }
  }

  /**
   * Clear all caches
   */
  clearAllCaches(): void {
    for (const [name, cache] of this.caches) {
      cache.clear();
      logger.debug('[MemoryManager] Cleared cache', { name });
    }
    this.metrics.cacheEvictions++;
    this.emit('cache-eviction', 'manual-clear-all', 0);
  }

  /**
   * Get detailed memory breakdown for monitoring/debugging
   */
  getDetailedMemoryBreakdown(): {
    budgetMB: number;
    usage: MemoryUsage;
    rendererDetails: Array<{ id: number; memoryMB: number; [key: string]: unknown }>;
    pressure: 'low' | 'medium' | 'high' | 'critical';
  } {
    const rendererData = this.getRendererProcessMemory();
    const usage = this.getCurrentMemoryUsage();

    return {
      budgetMB: this.budgets.maxMemoryUsageMB,
      usage,
      rendererDetails: rendererData.processDetails,
      pressure: this.getMemoryPressure(),
    };
  }

  /**
   * Get memory pressure level
   */
  getMemoryPressure(): 'low' | 'medium' | 'high' | 'critical' {
    const usage = this.getCurrentMemoryUsage();
    const percent = usage.percentageOfBudget;

    if (percent >= this.budgets.criticalMemoryThresholdPercent) {
      return 'critical';
    } else if (percent >= this.budgets.warningMemoryThresholdPercent) {
      return 'high';
    } else if (percent >= 50) {
      return 'medium';
    } else {
      return 'low';
    }
  }

  /**
   * Update memory metrics
   */
  private updateMemoryMetrics(): void {
    const usage = this.getCurrentMemoryUsage();

    this.metrics.currentMemoryUsage = usage;
    this.metrics.peakMemoryUsageMB = Math.max(this.metrics.peakMemoryUsageMB, usage.totalUsedMB);
    this.metrics.timestamp = Date.now();

    // Update average memory usage
    this.updateRunningAverage('memory', usage.totalUsedMB);
  }

  /**
   * Get current memory usage
   *
   * SECURITY FIX: Enhanced to include ALL Electron processes (main + renderers)
   * in memory budget calculation. Previous implementation only tracked main process
   * via process.memoryUsage() which could miss significant renderer memory usage,
   * allowing the application to exceed the 50MB budget without detection.
   */
  private getCurrentMemoryUsage(): MemoryUsage {
    const memUsage = process.memoryUsage();
    const mainProcessMB = memUsage.heapUsed / (1024 * 1024);

    // Get renderer process memory usage via IPC
    const rendererMemoryData = this.getRendererProcessMemory();
    const rendererProcessesMB = rendererMemoryData.totalRendererMB;
    const processCount = 1 + rendererMemoryData.rendererCount; // main + renderers

    // Estimate cache sizes
    let merkleTreeCacheMB = 0;
    let entityCacheMB = 0;
    let tempBuffersMB = 0;

    for (const [name, cache] of this.caches) {
      const sizeMB = this.getCacheSize(cache) / (1024 * 1024);

      if (name.includes('merkle') || name.includes('tree')) {
        merkleTreeCacheMB += sizeMB;
      } else if (name.includes('entity')) {
        entityCacheMB += sizeMB;
      } else {
        tempBuffersMB += sizeMB;
      }
    }

    // SECURITY FIX: Include ALL Electron processes in memory budget calculation
    const totalUsedMB = mainProcessMB + rendererProcessesMB;
    const percentageOfBudget = (totalUsedMB / this.budgets.maxMemoryUsageMB) * 100;

    return {
      totalUsedMB,
      mainProcessMB,
      rendererProcessesMB,
      merkleTreeCacheMB,
      entityCacheMB,
      tempBuffersMB,
      systemMemoryMB: memUsage.rss / (1024 * 1024),
      percentageOfBudget,
      processCount,
      timestamp: Date.now(),
    };
  }

  /**
   * Get memory usage from all renderer processes
   */
  private getRendererProcessMemory(): {
    totalRendererMB: number;
    rendererCount: number;
    processDetails: Array<{ id: number; memoryMB: number; [key: string]: unknown }>;
  } {
    let totalRendererMB = 0;
    let rendererCount = 0;
    const processDetails: Array<{ id: number; memoryMB: number; [key: string]: unknown }> = [];

    try {
      // Get all process metrics using app.getAppMetrics()
      const appMetrics = app.getAppMetrics();

      for (const metric of appMetrics) {
        if (metric.type === 'Tab' || metric.type === 'GPU') {
          const memoryMB = (metric.memory?.workingSetSize || 0) / 1024;
          totalRendererMB += memoryMB;
          rendererCount++;

          processDetails.push({
            id: metric.pid,
            type: metric.type,
            memoryMB: memoryMB,
            pid: metric.pid,
            creationTime: metric.creationTime,
          });
        }
      }

      logger.debug('[MemoryManager] Renderer process memory collected', {
        totalRendererMB: totalRendererMB.toFixed(2),
        rendererCount,
        processDetails: processDetails.length,
      });
    } catch (error) {
      logger.error('[MemoryManager] Failed to collect renderer process memory', {
        error: (error as Error).message,
      });
    }

    return {
      totalRendererMB,
      rendererCount,
      processDetails,
    };
  }

  /**
   * Check memory thresholds and emit events
   */
  private checkMemoryThresholds(): void {
    const usage = this.metrics.currentMemoryUsage;
    const percent = usage.percentageOfBudget;

    if (percent >= this.budgets.criticalMemoryThresholdPercent) {
      logger.error('[MemoryManager] Critical memory usage', {
        totalUsedMB: usage.totalUsedMB.toFixed(2),
        mainProcessMB: usage.mainProcessMB.toFixed(2),
        rendererProcessesMB: usage.rendererProcessesMB.toFixed(2),
        budgetMB: this.budgets.maxMemoryUsageMB,
        percentage: percent.toFixed(1),
        processCount: usage.processCount,
      });

      this.emit('memory-critical', usage);
      this.metrics.memoryWarnings++;

      // Force cache cleanup
      this.performEmergencyCleanup();
    } else if (percent >= this.budgets.warningMemoryThresholdPercent) {
      logger.warn('[MemoryManager] High memory usage', {
        totalUsedMB: usage.totalUsedMB.toFixed(2),
        mainProcessMB: usage.mainProcessMB.toFixed(2),
        rendererProcessesMB: usage.rendererProcessesMB.toFixed(2),
        budgetMB: this.budgets.maxMemoryUsageMB,
        percentage: percent.toFixed(1),
        processCount: usage.processCount,
      });

      this.emit('memory-warning', usage);
      this.metrics.memoryWarnings++;
    }
  }

  /**
   * Record operation timing
   */
  private recordOperationTiming(operationName: string, durationMs: number): void {
    if (!this.operationTimings[operationName]) {
      this.operationTimings[operationName] = [];
    }

    this.operationTimings[operationName].push(durationMs);

    // Keep only last 100 timings
    if (this.operationTimings[operationName].length > 100) {
      this.operationTimings[operationName] = this.operationTimings[operationName].slice(-100);
    }

    // Update metrics based on operation type
    switch (operationName) {
      case 'sync':
        this.metrics.lastSyncDurationMs = durationMs;
        this.updateRunningAverage('sync', durationMs);
        break;
      case 'hash':
        this.metrics.lastHashComputationMs = durationMs;
        break;
      case 'diff':
        this.metrics.lastDiffComputationMs = durationMs;
        break;
      case 'merge':
        this.metrics.lastMergeOperationMs = durationMs;
        break;
    }

    this.metrics.totalOperations++;
  }

  /**
   * Handle slow operation
   */
  private handleSlowOperation(operationName: string, durationMs: number, budgetMs: number): void {
    this.consecutiveSlowOps++;
    this.metrics.slowOperations++;

    logger.warn('[MemoryManager] Slow operation detected', {
      operation: operationName,
      durationMs,
      budgetMs,
      consecutiveSlowOps: this.consecutiveSlowOps,
    });

    this.emit('slow-operation', operationName, durationMs, budgetMs);

    // If too many consecutive slow operations, take corrective action
    if (this.consecutiveSlowOps >= this.budgets.maxConsecutiveSlowOperations) {
      logger.error('[MemoryManager] Too many consecutive slow operations, performing cleanup');
      this.performEmergencyCleanup();
      this.consecutiveSlowOps = 0;
    }
  }

  /**
   * Get budget for operation type
   */
  private getBudgetForOperation(operationName: string): number | undefined {
    const budgetMap: { [key: string]: number } = {
      sync: this.budgets.maxSyncDurationMs,
      hash: this.budgets.maxHashComputationMs,
      diff: this.budgets.maxDiffComputationMs,
      merge: this.budgets.maxMergeOperationMs,
    };

    return budgetMap[operationName];
  }

  /**
   * Perform emergency cleanup
   */
  private performEmergencyCleanup(): void {
    logger.info('[MemoryManager] Performing emergency cleanup');

    // Clear least recently used cache entries
    for (const [name, cache] of this.caches) {
      const entriesBeforeCleanup = cache.size;
      this.evictCacheEntries(cache, 0, 0.5); // Evict 50% of entries
      const entriesAfterCleanup = cache.size;

      if (entriesBeforeCleanup > entriesAfterCleanup) {
        logger.debug('[MemoryManager] Emergency cache cleanup', {
          cache: name,
          before: entriesBeforeCleanup,
          after: entriesAfterCleanup,
          evicted: entriesBeforeCleanup - entriesAfterCleanup,
        });
      }
    }

    // Force garbage collection if available
    this.forceGarbageCollection();

    this.emit('cache-eviction', 'emergency-cleanup', 0);
  }

  /**
   * Evict cache entries using intelligent cache policies
   */
  private evictCacheEntries(
    cache: Map<string, CacheEntry<unknown>>,
    targetSize: number,
    ratio = 0.2
  ): void {
    const entries = Array.from(cache.entries());

    // Determine cache policy based on configuration
    const policy = this.cachePolicy || 'hybrid';

    let sortedEntries: Array<[string, CacheEntry<unknown>]>;

    switch (policy) {
      case 'lru': // Least Recently Used
        sortedEntries = entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);
        break;

      case 'lfu': // Least Frequently Used
        sortedEntries = entries.sort((a, b) => a[1].accessCount - b[1].accessCount);
        break;

      case 'ttl': {
        // Time To Live
        const now = Date.now();
        sortedEntries = entries.sort((a, b) => {
          const ageA = now - a[1].createdAt;
          const ageB = now - b[1].createdAt;
          return ageB - ageA; // Oldest first
        });
        break;
      }

      case 'size': // Largest first
        sortedEntries = entries.sort((a, b) => b[1].size - a[1].size);
        break;

      case 'hybrid': // Combined approach
      default: {
        const nowHybrid = Date.now();
        sortedEntries = entries.sort((a, b) => {
          // Hybrid score combining recency, frequency, and age
          const scoreA = this.calculateHybridScore(a[1], nowHybrid);
          const scoreB = this.calculateHybridScore(b[1], nowHybrid);
          return scoreA - scoreB; // Lower scores evicted first
        });
        break;
      }
    }

    const entriesToRemove = Math.max(
      Math.ceil(entries.length * ratio), // Remove specified percentage
      1 // Remove at least 1 entry
    );

    let removedCount = 0;
    let freedBytes = 0;

    for (let i = 0; i < entriesToRemove && i < sortedEntries.length; i++) {
      const [key, entry] = sortedEntries[i];
      freedBytes += entry.size;
      cache.delete(key);
      removedCount++;

      // Stop if we've freed enough space
      if (targetSize > 0 && freedBytes >= targetSize) {
        break;
      }
    }

    if (removedCount > 0) {
      this.metrics.cacheEvictions++;
      logger.debug('[MemoryManager] Cache entries evicted', {
        policy,
        count: removedCount,
        freedMB: (freedBytes / 1024 / 1024).toFixed(2),
        totalBefore: entries.length,
        totalAfter: cache.size,
      });
    }
  }

  /**
   * Calculate hybrid eviction score combining multiple factors
   */
  private calculateHybridScore(entry: CacheEntry<unknown>, currentTime: number): number {
    const age = currentTime - entry.createdAt;
    const timeSinceAccess = currentTime - entry.lastAccessed;

    // Normalize factors (lower is better for eviction)
    const ageScore = age / (1000 * 60 * 60); // Hours since creation
    const accessScore = 1 / Math.max(entry.accessCount, 1); // Inverse of access count
    const recencyScore = timeSinceAccess / (1000 * 60); // Minutes since last access
    const sizeScore = entry.size / (1024 * 1024); // MB size

    // Weighted combination (adjust weights based on needs)
    return ageScore * 0.3 + accessScore * 0.3 + recencyScore * 0.3 + sizeScore * 0.1;
  }

  /**
   * Cache eviction policy configuration
   */
  private cachePolicy: 'lru' | 'lfu' | 'ttl' | 'size' | 'hybrid' = 'hybrid';

  /**
   * Set cache eviction policy
   */
  setCachePolicy(policy: 'lru' | 'lfu' | 'ttl' | 'size' | 'hybrid'): void {
    this.cachePolicy = policy;
    logger.info('[MemoryManager] Cache policy updated', { policy });
  }

  /**
   * Get cache size in bytes
   */
  private getCacheSize(cache: Map<string, CacheEntry<unknown>>): number {
    let totalSize = 0;
    for (const entry of cache.values()) {
      totalSize += entry.size;
    }
    return totalSize;
  }

  /**
   * Estimate object size in bytes (rough approximation)
   */
  private estimateObjectSize(obj: unknown): number {
    let size = 0;
    const stack = [obj];
    const seen = new WeakSet();

    while (stack.length > 0) {
      const current = stack.pop();

      if (current === null || current === undefined) {
        size += 8; // rough estimate
        continue;
      }

      // Only track objects in WeakSet (primitives can't be tracked)
      if (typeof current === 'object') {
        if (seen.has(current)) {
          continue;
        }
        seen.add(current);
      }

      switch (typeof current) {
        case 'string':
          size += current.length * 2; // UTF-16
          break;
        case 'number':
          size += 8;
          break;
        case 'boolean':
          size += 4;
          break;
        case 'object':
          if (Array.isArray(current)) {
            size += current.length * 8; // pointer size
            stack.push(...current);
          } else {
            const obj = current as Record<string, unknown>;
            const keys = Object.keys(obj);
            size += keys.length * 8; // rough estimate for object overhead
            for (const key of keys) {
              size += key.length * 2; // key string size
              stack.push(obj[key]);
            }
          }
          break;
      }
    }

    return size;
  }

  /**
   * Calculate cache hit rate
   */
  private calculateCacheHitRate(): number {
    // This would need proper hit/miss tracking
    // For now, return a placeholder
    return this.metrics.cacheHitRate || 0.8;
  }

  /**
   * Update running average
   */
  private updateRunningAverage(type: string, value: number): void {
    switch (type) {
      case 'memory':
        this.metrics.averageMemoryUsageMB = this.metrics.averageMemoryUsageMB * 0.9 + value * 0.1;
        break;
      case 'sync':
        this.metrics.averageSyncDurationMs = this.metrics.averageSyncDurationMs * 0.9 + value * 0.1;
        break;
    }
  }

  /**
   * Create empty metrics object
   */
  private createEmptyMetrics(): PerformanceMetrics {
    return {
      lastSyncDurationMs: 0,
      averageSyncDurationMs: 0,
      lastHashComputationMs: 0,
      lastDiffComputationMs: 0,
      lastMergeOperationMs: 0,
      currentMemoryUsage: {
        totalUsedMB: 0,
        mainProcessMB: 0,
        rendererProcessesMB: 0,
        merkleTreeCacheMB: 0,
        entityCacheMB: 0,
        tempBuffersMB: 0,
        systemMemoryMB: 0,
        percentageOfBudget: 0,
        processCount: 0,
        timestamp: Date.now(),
      },
      peakMemoryUsageMB: 0,
      averageMemoryUsageMB: 0,
      totalOperations: 0,
      slowOperations: 0,
      memoryWarnings: 0,
      budgetExceeded: 0,
      cacheHitRate: 0,
      cacheEvictions: 0,
      cacheSize: 0,
      timestamp: Date.now(),
    };
  }

  /**
   * Shutdown memory manager
   */
  async shutdown(): Promise<void> {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }

    this.clearAllCaches();
    this.isInitialized = false;

    logger.info('[MemoryManager] Shutdown complete');
  }
}

// Export factory function
export const createDesktopMemoryManager = (
  customBudgets?: Partial<PerformanceBudgets>
): DesktopMemoryManager => {
  return new DesktopMemoryManager(customBudgets);
};
