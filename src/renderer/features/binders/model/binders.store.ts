import { create } from 'zustand';

import { reportError } from '../../../shared/error';

export type Binder = {
  id: string;
  name: string;
  sort_index: number;
  color?: string | null;
  icon?: string | null;
  is_team_shared: number;
  remote_id?: string | null;
  user_profile_id?: string | null;
};

const BINDER_COLOR_SETTING_PREFIX = 'ui.binderColor.';
const HEX_COLOR_PATTERN = /^#?[0-9A-Fa-f]{6}$/;

const normalizeHexColor = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) return null;
  const normalized = trimmed.replace(/^#/, '').toUpperCase();
  return `#${normalized}`;
};

type State = {
  binders: Binder[];
  loading: boolean;
  // Conflicts binder state (Phase 5)
  conflictsBinder: Binder | null;
  conflictsCount: number;
  load: () => Promise<void>;
  loadConflicts: () => Promise<void>;
  add: (name: string) => Promise<string>;
  rename: (id: string, name: string) => Promise<void>;
  update: (input: {
    id: string;
    name?: string;
    color?: string | null;
    icon?: string | null;
    is_team_shared?: number;
  }) => Promise<void>;
  remove: (id: string) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
  setLocal: (binders: Binder[]) => void;
  setupSyncListeners: () => () => void; // Returns cleanup function
};

export const useBindersStore = create<State>((set, get) => ({
  binders: [],
  loading: false,
  // Conflicts binder state (Phase 5)
  conflictsBinder: null,
  conflictsCount: 0,
  async load() {
    set({ loading: true });
    const rows = await window.api.storage.listBinders();
    let mergedRows = rows;

    try {
      const colorSettings = await window.api.settings.listByPrefix(BINDER_COLOR_SETTING_PREFIX);
      if (Array.isArray(colorSettings) && colorSettings.length > 0) {
        const colorMap = new Map<string, string>();
        for (const entry of colorSettings) {
          const binderId = entry.key.startsWith(BINDER_COLOR_SETTING_PREFIX)
            ? entry.key.slice(BINDER_COLOR_SETTING_PREFIX.length)
            : '';
          const normalized = normalizeHexColor(entry.value);
          if (binderId && normalized) {
            colorMap.set(binderId, normalized);
          }
        }

        if (colorMap.size > 0) {
          mergedRows = rows.map((binder) =>
            colorMap.has(binder.id) ? { ...binder, color: colorMap.get(binder.id)! } : binder
          );
        }
      }
    } catch (error) {
      console.warn('Failed to hydrate binder colour preferences from settings', error);
    }

    set({ binders: mergedRows, loading: false });

    // Also load conflicts state
    await get().loadConflicts();
  },
  async loadConflicts() {
    try {
      // Get conflicts binder and count
      const [conflictsBinder, countResult] = await Promise.all([
        window.api.storage.getConflictsBinder(),
        window.api.storage.countConflicts(),
      ]);

      set({
        conflictsBinder: conflictsBinder as Binder | null,
        conflictsCount: countResult.count,
      });
    } catch (error) {
      console.warn('Failed to load conflicts state', error);
      set({ conflictsBinder: null, conflictsCount: 0 });
    }
  },
  add: async (name: string) => {
    try {
      const id = await window.api.storage.createBinder(name);
      await get().load();
      const current = get().binders;
      const existingIds = new Set(current.map((binder) => binder.id));
      if (current.length > 1 && existingIds.has(id)) {
        const newOrder = [
          id,
          ...current.filter((binder) => binder.id !== id).map((binder) => binder.id),
        ];
        await get().reorder(newOrder);
      }
      return id;
    } catch (e) {
      reportError(e);
      throw e;
    }
  },
  rename: async (id, name) => {
    try {
      await window.api.storage.renameBinder(id, name);
      await get().load();
    } catch (e) {
      reportError(e);
    }
  },
  update: async (input) => {
    try {
      await window.api.storage.updateBinder(input);
      if (input.color !== undefined) {
        const settingKey = `${BINDER_COLOR_SETTING_PREFIX}${input.id}`;
        const normalized = normalizeHexColor(input.color);
        try {
          await window.api.settings.set(settingKey, normalized ?? '');
        } catch (error) {
          console.warn('Failed to persist binder colour preference', {
            binderId: input.id,
            error,
          });
        }
      }
      await get().load();
    } catch (e) {
      reportError(e);
    }
  },
  remove: async (id) => {
    try {
      await window.api.storage.deleteBinder(id);
      await get().load();
    } catch (e) {
      reportError(e);
    }
  },
  reorder: async (ids) => {
    const current = get().binders;
    const map = new Map(current.map((b) => [b.id, b]));
    const reordered = ids.map((id) => map.get(id)!).filter(Boolean);
    set({ binders: reordered });
    try {
      await window.api.storage.reorderBinders(ids);
      await get().load();
    } catch (e) {
      reportError(e);
      await get().load();
    }
  },
  setLocal(binders) {
    set({ binders });
  },
  setupSyncListeners() {
    const cleanupFunctions: (() => void)[] = [];

    // Listen for notes:changed events to refresh conflicts state (Phase 5)
    // This ensures the conflict badge updates when conflicts are resolved locally
    const handleNotesChanged = () => {
      get().loadConflicts();
    };
    window.addEventListener('notes:changed', handleNotesChanged);
    cleanupFunctions.push(() => window.removeEventListener('notes:changed', handleNotesChanged));

    // Return combined cleanup function
    return () => {
      cleanupFunctions.forEach((cleanup) => cleanup());
    };
  },
}));
