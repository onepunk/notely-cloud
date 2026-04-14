/**
 * Settings service interface - Settings key-value store
 */

import type { Setting } from '../types/entities';

export interface ISettingsService {
  /**
   * Get a setting value by key
   */
  get(key: string): Promise<string | null>;
  
  /**
   * Set a setting value
   */
  set(key: string, value: string): Promise<void>;
  
  /**
   * Get multiple settings by keys
   */
  getBatch(keys: string[]): Promise<Record<string, string | null>>;
  
  /**
   * Set multiple settings at once
   */
  setBatch(settings: Record<string, string>): Promise<void>;
  
  /**
   * List settings by key prefix
   */
  listByPrefix(prefix: string): Promise<Setting[]>;
  
  /**
   * Delete a setting
   */
  delete(key: string): Promise<void>;
  
  /**
   * Delete settings by prefix
   */
  deleteByPrefix(prefix: string): Promise<number>;
  
  /**
   * Check if setting exists
   */
  exists(key: string): Promise<boolean>;
  
  /**
   * Get all settings (use with caution)
   */
  getAll(): Promise<Setting[]>;
  
  /**
   * Get setting with default value
   */
  getWithDefault(key: string, defaultValue: string): Promise<string>;
  
  /**
   * Get parsed JSON setting with type safety
   */
  getJson<T>(key: string): Promise<T | null>;
  
  /**
   * Set JSON setting with type safety
   */
  setJson<T>(key: string, value: T): Promise<void>;
}