/**
 * User service interface - User profile and session management
 *
 * The user_profiles table is the single source of truth for user identity.
 * This interface defines how the application interacts with user data.
 */

import type { LoginUserInput, UpdateUserProfileInput } from '../services/UserService';

/**
 * User profile entity - represents a user in the local database
 */
export interface UserProfile {
  /** Local profile ID (UUID) - used in all entity tables */
  id: string;
  /** Server's auth user ID - used for sync authentication */
  serverUserId: string | null;
  /** User's email address */
  email: string | null;
  /** User's first name */
  firstName: string | null;
  /** User's last name */
  lastName: string | null;
  /** Path to user's avatar image */
  avatarPath: string | null;
  /** Whether this user is currently active */
  isActive: boolean;
  /** When the profile was created */
  createdAt: Date;
  /** When the profile was last updated */
  updatedAt: Date;
  /** When the user last logged in */
  lastLoginAt: Date | null;
}

export interface IUserService {
  /**
   * Get the current active user's profile ID.
   * This is the single source of truth for user identity.
   *
   * @throws Error if no active user is found (user must log in first)
   */
  getCurrentUserId(): Promise<string>;

  /**
   * Check if there is currently an active user.
   * Unlike getCurrentUserId, this does not throw.
   */
  hasActiveUser(): Promise<boolean>;

  /**
   * Ensure a local user profile exists for standalone/offline use.
   *
   * Creates an anonymous local profile if no user exists, allowing the app
   * to function without OAuth login. The profile has no server_user_id until
   * the user authenticates via OAuth.
   *
   * @returns The local profile ID (existing or newly created)
   */
  ensureLocalUser(): Promise<string>;

  /**
   * Get the full profile of the currently active user.
   */
  getActiveUserProfile(): Promise<UserProfile | null>;

  /**
   * Get user profile by local ID.
   */
  getUserProfile(userId?: string): Promise<UserProfile | null>;

  /**
   * Get user profile by server user ID.
   */
  getUserProfileByServerUserId(serverUserId: string): Promise<UserProfile | null>;

  /**
   * Log in a user - creates or activates a user profile.
   * This is called by AuthService after successful authentication.
   *
   * @param input - Login details including the server user ID
   * @returns The local profile ID of the logged-in user
   */
  loginUser(input: LoginUserInput): Promise<string>;

  /**
   * Log out the current user.
   * Sets is_active = 0 for the active user and clears the cache.
   */
  logoutUser(): Promise<void>;

  /**
   * Switch to a different user profile.
   */
  switchUser(userId: string): Promise<void>;

  /**
   * Update the active user's profile information.
   */
  updateUserProfile(input: UpdateUserProfileInput): Promise<void>;

  /**
   * Save or update user profile information (legacy compatibility).
   * @deprecated Use updateUserProfile instead
   */
  saveUserProfile(input: UpdateUserProfileInput): Promise<void>;

  /**
   * Get all user profiles (for multi-user management UI).
   */
  listUserProfiles(): Promise<UserProfile[]>;

  /**
   * Create default binders for a new user.
   */
  createUserDefaultBinders(userId?: string): Promise<void>;

  /**
   * Check if user has been initialized (has at least one binder).
   */
  isUserInitialized(userId?: string): Promise<boolean>;

  /**
   * Clear the cached user ID (for testing or forced refresh).
   */
  clearCache(): void;
}

// Re-export types for convenience
export type { LoginUserInput, UpdateUserProfileInput };
