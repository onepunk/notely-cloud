import crypto from 'crypto';

import Database from 'better-sqlite3-multiple-ciphers';
type DatabaseInstance = InstanceType<typeof Database>;

import { logger } from '../../logger';
import { TransactionManager } from '../core/TransactionManager';
import { IDatabaseManager } from '../interfaces/IDatabaseManager';
import { IUserService, UserProfile } from '../interfaces/IUserService';
import { DEFAULT_BINDERS, UNASSIGNED_BINDER_ID } from '../migrations/seeds/defaultBinders';

/**
 * User profile row from the new user_profiles table
 */
interface UserProfileRow {
  id: string;
  server_user_id: string | null;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  avatar_path: string | null;
  is_active: number;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

/**
 * Input for logging in a user (creating or activating a user profile)
 */
export interface LoginUserInput {
  serverUserId: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Input for updating a user profile
 */
export interface UpdateUserProfileInput {
  firstName?: string;
  lastName?: string;
  email?: string;
  avatarPath?: string;
}

/**
 * UserService - User profile and session management
 *
 * This service manages the user_profiles table which is the single source of truth
 * for user identity in the desktop client.
 *
 * Key concepts:
 * - `id`: Local UUID used in all entity tables (binders, notes, tags, etc.)
 * - `server_user_id`: Maps to the server's auth user ID for sync
 * - `is_active`: Only one user can be active at a time (supports multi-user)
 *
 * The active user's `id` is used for all data operations. When syncing, the
 * server user ID is used to authenticate but data is scoped by local profile ID.
 */
export class UserService implements IUserService {
  // Cache the active user ID to avoid repeated DB queries
  private cachedActiveUserId: string | null = null;

  constructor(
    private databaseManager: IDatabaseManager,
    private transactionManager: TransactionManager
  ) {}

  private get db(): DatabaseInstance {
    return this.databaseManager.getDatabase();
  }

  /**
   * Get the current active user's profile ID.
   *
   * This is the single source of truth for user identity.
   * Returns the `id` (local UUID) of the active user profile.
   *
   * @throws Error if no active user is found (user must log in first)
   */
  async getCurrentUserId(): Promise<string> {
    // Return cached value if available
    if (this.cachedActiveUserId) {
      return this.cachedActiveUserId;
    }

    // Query for active user
    const activeUser = this.db
      .prepare('SELECT id FROM user_profiles WHERE is_active = 1 LIMIT 1')
      .get() as { id: string } | undefined;

    if (activeUser) {
      this.cachedActiveUserId = activeUser.id;
      return activeUser.id;
    }

    // Check for legacy current_user_id in settings (pre-migration028 compatibility)
    const legacyUserIdRow = this.db
      .prepare("SELECT value FROM settings WHERE key = 'current_user_id'")
      .get() as { value: string } | undefined;

    if (legacyUserIdRow?.value && this.isValidUuid(legacyUserIdRow.value)) {
      // Migrate legacy user to user_profiles
      logger.info('UserService: Migrating legacy current_user_id to user_profiles', {
        userId: legacyUserIdRow.value.substring(0, 8) + '...',
      });

      await this.createUserProfile({
        id: legacyUserIdRow.value,
        isActive: true,
      });

      this.cachedActiveUserId = legacyUserIdRow.value;
      return legacyUserIdRow.value;
    }

    // No active user found - this is an error state
    // The user must log in first
    throw new Error(
      'No active user found. Please log in to continue. ' +
        'If you were previously logged in, you may need to re-authenticate.'
    );
  }

  /**
   * Check if there is currently an active user.
   * Unlike getCurrentUserId, this does not throw - it returns false if no user is active.
   */
  async hasActiveUser(): Promise<boolean> {
    try {
      await this.getCurrentUserId();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Ensure a local user profile exists for standalone/offline use.
   *
   * This creates an anonymous local profile if no user exists, allowing the app
   * to function without OAuth login. The profile has no server_user_id until
   * the user authenticates via OAuth.
   *
   * @returns The local profile ID (existing or newly created)
   */
  async ensureLocalUser(): Promise<string> {
    // Check if there's already an active user
    const existingActive = this.db
      .prepare('SELECT id FROM user_profiles WHERE is_active = 1 LIMIT 1')
      .get() as { id: string } | undefined;

    if (existingActive) {
      this.cachedActiveUserId = existingActive.id;
      return existingActive.id;
    }

    // Check for any existing user (e.g., previously logged out)
    const anyUser = this.db.prepare('SELECT id FROM user_profiles LIMIT 1').get() as
      | { id: string }
      | undefined;

    if (anyUser) {
      // Reactivate the existing user
      const now = Date.now();
      this.db
        .prepare('UPDATE user_profiles SET is_active = 1, updated_at = ? WHERE id = ?')
        .run(now, anyUser.id);
      this.cachedActiveUserId = anyUser.id;

      logger.info('UserService: Reactivated existing local user', {
        userId: anyUser.id.substring(0, 8) + '...',
      });

      return anyUser.id;
    }

    // No user exists - create anonymous local profile
    const localUserId = crypto.randomUUID();
    const now = Date.now();

    logger.info('UserService: Creating anonymous local user for standalone use', {
      userId: localUserId.substring(0, 8) + '...',
    });

    await this.transactionManager.execute(() => {
      this.db
        .prepare(
          `
          INSERT INTO user_profiles (
            id, server_user_id, email, first_name, last_name,
            is_active, created_at, updated_at
          ) VALUES (?, NULL, NULL, 'Local', 'User', 1, ?, ?)
        `
        )
        .run(localUserId, now, now);

      // Create default binders for the new user
      this.createUserDefaultBindersSync(localUserId);
    });

    this.cachedActiveUserId = localUserId;
    return localUserId;
  }

  /**
   * Get the full profile of the currently active user.
   */
  async getActiveUserProfile(): Promise<UserProfile | null> {
    const activeUser = this.db
      .prepare('SELECT * FROM user_profiles WHERE is_active = 1 LIMIT 1')
      .get() as UserProfileRow | undefined;

    if (!activeUser) {
      return null;
    }

    return this.mapRowToProfile(activeUser);
  }

  /**
   * Get user profile by local ID.
   * Falls back to the most recently updated profile if no active user exists.
   */
  async getUserProfile(userId?: string): Promise<UserProfile | null> {
    let targetId = userId;

    if (!targetId) {
      try {
        targetId = await this.getCurrentUserId();
      } catch {
        // No active user - fall back to most recently updated profile
        const recentProfile = this.db
          .prepare('SELECT id FROM user_profiles ORDER BY updated_at DESC LIMIT 1')
          .get() as { id: string } | undefined;

        if (!recentProfile) {
          return null;
        }
        targetId = recentProfile.id;
      }
    }

    const row = this.db.prepare('SELECT * FROM user_profiles WHERE id = ?').get(targetId) as
      | UserProfileRow
      | undefined;

    return row ? this.mapRowToProfile(row) : null;
  }

  /**
   * Get user profile by server user ID.
   */
  async getUserProfileByServerUserId(serverUserId: string): Promise<UserProfile | null> {
    const row = this.db
      .prepare('SELECT * FROM user_profiles WHERE server_user_id = ?')
      .get(serverUserId) as UserProfileRow | undefined;

    return row ? this.mapRowToProfile(row) : null;
  }

  /**
   * Log in a user - creates or activates a user profile.
   *
   * This is called by AuthService after successful authentication.
   * It ensures the user has a local profile and sets them as the active user.
   *
   * If an anonymous local profile exists (created for standalone use), it will
   * be linked to the OAuth credentials rather than creating a new profile.
   * This preserves any data created before the user authenticated.
   *
   * @param input - Login details including the server user ID
   * @returns The local profile ID of the logged-in user
   */
  async loginUser(input: LoginUserInput): Promise<string> {
    const { serverUserId, email, firstName, lastName } = input;
    const now = Date.now();

    logger.info('UserService: Login user', {
      serverUserId: serverUserId.substring(0, 8) + '...',
      email: email || 'not provided',
    });

    return await this.transactionManager.execute(() => {
      // Check if user already exists by server_user_id
      const existingUserByServerId = this.db
        .prepare('SELECT id FROM user_profiles WHERE server_user_id = ?')
        .get(serverUserId) as { id: string } | undefined;

      let localUserId: string;

      if (existingUserByServerId) {
        // User already authenticated before - update and activate
        localUserId = existingUserByServerId.id;

        this.db
          .prepare(
            `
          UPDATE user_profiles SET
            email = COALESCE(?, email),
            first_name = COALESCE(?, first_name),
            last_name = COALESCE(?, last_name),
            is_active = 1,
            updated_at = ?,
            last_login_at = ?
          WHERE id = ?
        `
          )
          .run(email || null, firstName || null, lastName || null, now, now, localUserId);

        logger.info('UserService: Activated existing authenticated user profile', {
          localUserId: localUserId.substring(0, 8) + '...',
        });
      } else {
        // Check for anonymous local profile (no server_user_id) to link
        const anonymousProfile = this.db
          .prepare('SELECT id FROM user_profiles WHERE server_user_id IS NULL AND is_active = 1')
          .get() as { id: string } | undefined;

        if (anonymousProfile) {
          // Link OAuth credentials to existing anonymous profile
          localUserId = anonymousProfile.id;

          this.db
            .prepare(
              `
            UPDATE user_profiles SET
              server_user_id = ?,
              email = COALESCE(?, email),
              first_name = COALESCE(?, first_name),
              last_name = COALESCE(?, last_name),
              is_active = 1,
              updated_at = ?,
              last_login_at = ?
            WHERE id = ?
          `
            )
            .run(
              serverUserId,
              email || null,
              firstName || null,
              lastName || null,
              now,
              now,
              localUserId
            );

          logger.info('UserService: Linked OAuth to existing anonymous profile', {
            localUserId: localUserId.substring(0, 8) + '...',
            serverUserId: serverUserId.substring(0, 8) + '...',
          });
        } else {
          // No existing profile - create new one
          localUserId = crypto.randomUUID();

          this.db
            .prepare(
              `
            INSERT INTO user_profiles (
              id, server_user_id, email, first_name, last_name,
              is_active, created_at, updated_at, last_login_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
          `
            )
            .run(
              localUserId,
              serverUserId,
              email || null,
              firstName || null,
              lastName || null,
              now,
              now,
              now
            );

          logger.info('UserService: Created new user profile', {
            localUserId: localUserId.substring(0, 8) + '...',
          });

          // Create default binders for new user
          this.createUserDefaultBindersSync(localUserId);
        }
      }

      // Deactivate all other users
      this.db.prepare('UPDATE user_profiles SET is_active = 0 WHERE id != ?').run(localUserId);

      // Update cache
      this.cachedActiveUserId = localUserId;

      return localUserId;
    });
  }

  /**
   * Log out the current user.
   * Sets is_active = 0 for the active user and clears the cache.
   */
  async logoutUser(): Promise<void> {
    logger.info('UserService: Logging out active user');

    this.db.prepare('UPDATE user_profiles SET is_active = 0 WHERE is_active = 1').run();
    this.cachedActiveUserId = null;
  }

  /**
   * Switch to a different user profile.
   *
   * @param userId - The local profile ID to switch to
   */
  async switchUser(userId: string): Promise<void> {
    logger.info('UserService: Switching to user', {
      userId: userId.substring(0, 8) + '...',
    });

    await this.transactionManager.execute(() => {
      // Verify user exists
      const user = this.db.prepare('SELECT id FROM user_profiles WHERE id = ?').get(userId) as
        | { id: string }
        | undefined;

      if (!user) {
        throw new Error(`User profile not found: ${userId}`);
      }

      // Deactivate all users
      this.db.prepare('UPDATE user_profiles SET is_active = 0').run();

      // Activate the target user
      this.db
        .prepare('UPDATE user_profiles SET is_active = 1, updated_at = ? WHERE id = ?')
        .run(Date.now(), userId);

      // Update cache
      this.cachedActiveUserId = userId;
    });
  }

  /**
   * Update the active user's profile information.
   */
  async updateUserProfile(input: UpdateUserProfileInput): Promise<void> {
    const userId = await this.getCurrentUserId();
    const now = Date.now();

    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (input.firstName !== undefined) {
      updates.push('first_name = ?');
      values.push(input.firstName);
    }
    if (input.lastName !== undefined) {
      updates.push('last_name = ?');
      values.push(input.lastName);
    }
    if (input.email !== undefined) {
      updates.push('email = ?');
      values.push(input.email);
    }
    if (input.avatarPath !== undefined) {
      updates.push('avatar_path = ?');
      values.push(input.avatarPath);
    }

    if (updates.length === 0) {
      return; // Nothing to update
    }

    updates.push('updated_at = ?');
    values.push(now);
    values.push(userId);

    this.db.prepare(`UPDATE user_profiles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  /**
   * Save or update user profile information (legacy compatibility).
   * @deprecated Use updateUserProfile instead
   */
  async saveUserProfile(input: UpdateUserProfileInput): Promise<void> {
    return this.updateUserProfile(input);
  }

  /**
   * Get all user profiles (for multi-user management UI).
   */
  async listUserProfiles(): Promise<UserProfile[]> {
    const rows = this.db
      .prepare('SELECT * FROM user_profiles ORDER BY last_login_at DESC NULLS LAST')
      .all() as UserProfileRow[];

    return rows.map((row) => this.mapRowToProfile(row));
  }

  /**
   * Delete a user profile and all associated data.
   * Warning: This is destructive and cannot be undone.
   */
  async deleteUserProfile(userId: string): Promise<void> {
    const currentUserId = await this.getCurrentUserId();

    if (userId === currentUserId) {
      throw new Error('Cannot delete the currently active user. Switch users first.');
    }

    await this.transactionManager.execute(() => {
      // Delete all user data (cascade would be ideal but SQLite support varies)
      // For now, we'll let foreign key constraints handle it or orphan the data
      this.db.prepare('DELETE FROM user_profiles WHERE id = ?').run(userId);
    });

    logger.info('UserService: Deleted user profile', {
      userId: userId.substring(0, 8) + '...',
    });
  }

  /**
   * Check if user has been initialized (has at least one binder).
   */
  async isUserInitialized(userId?: string): Promise<boolean> {
    const targetId = userId || (await this.getCurrentUserId());

    const stmt = this.db.prepare(
      'SELECT COUNT(*) AS count FROM binders WHERE user_profile_id = ? AND deleted = 0'
    );
    const row = stmt.get(targetId) as { count: number };

    return row.count > 0;
  }

  /**
   * Create default binders for a new user.
   */
  async createUserDefaultBinders(userId?: string): Promise<void> {
    const targetId = userId || (await this.getCurrentUserId());

    await this.transactionManager.execute(() => {
      this.createUserDefaultBindersSync(targetId);
    });
  }

  /**
   * Create a user profile with specific parameters.
   * Used for migration and testing.
   */
  private async createUserProfile(params: {
    id: string;
    serverUserId?: string;
    email?: string;
    firstName?: string;
    lastName?: string;
    isActive?: boolean;
  }): Promise<void> {
    const now = Date.now();

    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO user_profiles (
        id, server_user_id, email, first_name, last_name,
        is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        params.id,
        params.serverUserId || null,
        params.email || null,
        params.firstName || null,
        params.lastName || null,
        params.isActive ? 1 : 0,
        now,
        now
      );
  }

  /**
   * Clear the cached user ID (for testing or forced refresh).
   */
  clearCache(): void {
    this.cachedActiveUserId = null;
  }

  /**
   * Validate if a string is a valid UUID.
   */
  private isValidUuid(value: string): boolean {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  /**
   * Map database row to UserProfile.
   */
  private mapRowToProfile(row: UserProfileRow): UserProfile {
    return {
      id: row.id,
      serverUserId: row.server_user_id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      avatarPath: row.avatar_path,
      isActive: row.is_active === 1,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      lastLoginAt: row.last_login_at ? new Date(row.last_login_at) : null,
    };
  }

  /**
   * Synchronous version of createUserDefaultBinders for use within transactions.
   * Creates the system "Unassigned" binder with hardcoded UUID for consistency.
   */
  private createUserDefaultBindersSync(userId: string): void {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO binders(
        id, user_profile_id, name, sort_index, color, icon,
        is_team_shared, remote_id, created_at, updated_at, deleted, binder_type
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `);

    for (const binder of DEFAULT_BINDERS) {
      // Use hardcoded UUID for Unassigned binder to ensure consistency across installations
      const binderId =
        binder.id === UNASSIGNED_BINDER_ID ? UNASSIGNED_BINDER_ID : crypto.randomUUID();

      stmt.run(
        binderId,
        userId,
        binder.name,
        binder.sort_index,
        null, // color
        null, // icon
        0, // is_team_shared
        null, // remote_id
        now, // created_at
        now, // updated_at
        0, // deleted
        binder.type // binder_type (SYSTEM for Unassigned, USER for others)
      );
    }

    logger.info('UserService: Created default binders for user', {
      userId: userId.substring(0, 8) + '...',
    });
  }
}
