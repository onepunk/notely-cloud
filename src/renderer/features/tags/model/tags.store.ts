import { create } from 'zustand';

import { reportError } from '../../../shared/error';
import type { Tag, CreateTagInput, UpdateTagInput } from '../types';

type State = {
  tags: Tag[];
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  create: (input: CreateTagInput) => Promise<string>;
  update: (input: UpdateTagInput) => Promise<void>;
  rename: (id: string, name: string) => Promise<void>;
  setColor: (id: string, color: string | null) => Promise<void>;
  delete: (id: string) => Promise<void>;
  reorder: (ids: string[]) => Promise<void>;
  getTagsByNote: (noteId: string) => Promise<Tag[]>;
  setNoteTags: (noteId: string, tagIds: string[]) => Promise<void>;
  addTagToNote: (noteId: string, tagId: string) => Promise<string>;
  removeTagFromNote: (noteId: string, tagId: string) => Promise<void>;
  setLocal: (tags: Tag[]) => void;
  setupSyncListeners: () => () => void;
};

/**
 * Convert API response to Tag type with proper Date objects
 */
const toTag = (row: {
  id: string;
  userId: string | null;
  name: string;
  color: string | null;
  sortIndex: number;
  createdAt: string | Date;
  updatedAt: string | Date;
  deleted: boolean;
  noteCount?: number;
}): Tag => ({
  id: row.id,
  userId: row.userId,
  name: row.name,
  color: row.color,
  sortIndex: row.sortIndex,
  createdAt: row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  updatedAt: row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt),
  deleted: row.deleted,
  noteCount: row.noteCount,
});

export const useTagsStore = create<State>((set, get) => ({
  tags: [],
  loading: false,
  error: null,

  async load() {
    set({ loading: true, error: null });
    try {
      const rows = await window.api.tags.list();
      const tags = rows.map(toTag);
      set({ tags, loading: false });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Failed to load tags';
      set({ error: message, loading: false });
      reportError(e);
    }
  },

  async create(input: CreateTagInput) {
    try {
      const id = await window.api.tags.create(input);
      await get().load();
      // Move newly created tag to the front
      const current = get().tags;
      const existingIds = new Set(current.map((tag) => tag.id));
      if (current.length > 1 && existingIds.has(id)) {
        const newOrder = [id, ...current.filter((tag) => tag.id !== id).map((tag) => tag.id)];
        await get().reorder(newOrder);
      }
      return id;
    } catch (e) {
      reportError(e);
      throw e;
    }
  },

  async update(input: UpdateTagInput) {
    try {
      await window.api.tags.update(input);
      await get().load();
    } catch (e) {
      reportError(e);
      throw e;
    }
  },

  async rename(id: string, name: string) {
    try {
      await window.api.tags.update({ id, name });
      await get().load();
    } catch (e) {
      reportError(e);
      throw e;
    }
  },

  async setColor(id: string, color: string | null) {
    try {
      await window.api.tags.update({ id, color });
      await get().load();
    } catch (e) {
      reportError(e);
      throw e;
    }
  },

  async delete(id: string) {
    try {
      await window.api.tags.delete(id);
      await get().load();
    } catch (e) {
      reportError(e);
      throw e;
    }
  },

  async reorder(ids: string[]) {
    // Optimistic update
    const current = get().tags;
    const map = new Map(current.map((t) => [t.id, t]));
    const reordered = ids.map((id) => map.get(id)!).filter(Boolean);
    set({ tags: reordered });

    try {
      await window.api.tags.reorder(ids);
      await get().load();
    } catch (e) {
      reportError(e);
      // Rollback on error
      await get().load();
      throw e;
    }
  },

  async getTagsByNote(noteId: string) {
    try {
      const rows = await window.api.tags.getByNote(noteId);
      return rows.map(toTag);
    } catch (e) {
      reportError(e);
      throw e;
    }
  },

  async setNoteTags(noteId: string, tagIds: string[]) {
    try {
      await window.api.tags.setNoteTags(noteId, tagIds);
    } catch (e) {
      reportError(e);
      throw e;
    }
  },

  async addTagToNote(noteId: string, tagId: string) {
    try {
      const noteTagId = await window.api.tags.addToNote(noteId, tagId);
      return noteTagId;
    } catch (e) {
      reportError(e);
      throw e;
    }
  },

  async removeTagFromNote(noteId: string, tagId: string) {
    try {
      await window.api.tags.removeFromNote(noteId, tagId);
    } catch (e) {
      reportError(e);
      throw e;
    }
  },

  setLocal(tags: Tag[]) {
    set({ tags });
  },

  setupSyncListeners() {
    const cleanupFunctions: (() => void)[] = [];

    // Listen for tag changes (root-level API)
    if (typeof window.api?.onTagsChanged === 'function') {
      const unsubscribeTagsChanged = window.api.onTagsChanged(() => {
        get().load();
      });
      cleanupFunctions.push(unsubscribeTagsChanged);
    }

    // Listen for note-tag association changes (root-level API)
    if (typeof window.api?.onNoteTagsChanged === 'function') {
      const unsubscribeNoteTagsChanged = window.api.onNoteTagsChanged(() => {
        // Note-tag changes might affect note counts, so reload
        get().load();
      });
      cleanupFunctions.push(unsubscribeNoteTagsChanged);
    }

    // Listen for sync completion events
    if (typeof window.api?.onSyncComplete === 'function') {
      const unsubscribeSyncComplete = window.api.onSyncComplete(() => {
        get().load();
      });
      cleanupFunctions.push(unsubscribeSyncComplete);
    }

    return () => {
      cleanupFunctions.forEach((cleanup) => cleanup());
    };
  },
}));
