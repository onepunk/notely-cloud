/**
 * TransactionManager - Provides higher-level transaction management
 * with retry logic, nested transaction support, and error handling
 */

import type { IDatabaseManager, TransactionCallback } from '../interfaces/IDatabaseManager';

export type TransactionOptions = {
  retryAttempts?: number;
  retryDelay?: number;
  timeout?: number;
};

export class TransactionManager {
  private transactionDepth = 0;

  constructor(private databaseManager: IDatabaseManager) {}

  /**
   * Execute a transaction with automatic retry on deadlock
  */
  async execute<T>(callback: TransactionCallback<T>, options: TransactionOptions = {}): Promise<T> {
    const { retryAttempts = 3, retryDelay = 100, timeout = 30000 } = options;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retryAttempts; attempt++) {
      try {
        if (timeout > 0) {
          return await this.executeWithTimeout(callback, timeout);
        } else {
          return this.databaseManager.transaction(callback);
        }
      } catch (error) {
        lastError = error as Error;

        // Check if this is a retryable error
        if (this.isRetryableError(error as Error) && attempt < retryAttempts) {
          await this.delay(retryDelay * Math.pow(2, attempt)); // Exponential backoff
          continue;
        }

        throw error;
      }
    }

    throw lastError || new Error('Transaction failed after all retries');
  }

  /**
   * Execute transaction with timeout
   */
  private async executeWithTimeout<T>(
    callback: TransactionCallback<T>,
    timeoutMs: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Transaction timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        const result = this.databaseManager.transaction(callback);
        clearTimeout(timeoutId);
        resolve(result);
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }


  /**
   * Execute multiple operations in a single transaction
   */
  async batch<T extends readonly unknown[]>(
    operations: readonly [...{ [K in keyof T]: () => T[K] }]
  ): Promise<T> {
    return this.execute(() => {
      return operations.map((op) => op()) as unknown as T;
    });
  }

  /**
   * Execute a read-only transaction (for optimization hints)
   */
  async readOnly<T>(callback: TransactionCallback<T>): Promise<T> {
    // SQLite doesn't have explicit read-only transactions,
    // but we can use this for semantic clarity and future optimization
    return this.execute(callback);
  }

  /**
   * Check if error is retryable (SQLite BUSY, LOCKED, etc.)
   */
  private isRetryableError(error: Error): boolean {
    const message = error.message.toLowerCase();
    return (
      message.includes('database is busy') ||
      message.includes('database is locked') ||
      message.includes('deadlock') ||
      message.includes('disk i/o error')
    );
  }

  /**
   * Delay helper for retry backoff
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Execute nested transactions (savepoints in SQLite)
   */
  async nested<T>(callback: TransactionCallback<T>): Promise<T> {
    this.transactionDepth++;
    const savepointName = `sp_${this.transactionDepth}`;

    try {
      this.databaseManager.exec(`SAVEPOINT ${savepointName}`);
      const result = callback();
      this.databaseManager.exec(`RELEASE SAVEPOINT ${savepointName}`);
      return result;
    } catch (error) {
      this.databaseManager.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }

  /**
   * Get current transaction depth (for debugging)
   */
  getTransactionDepth(): number {
    return this.transactionDepth;
  }

  /**
   * Check if currently inside a transaction
   */
  isInTransaction(): boolean {
    return this.transactionDepth > 0;
  }
}
