import { create } from 'zustand';

type SettingRecord = { key: string; value: string };

type SettingsState = {
  values: Record<string, string>;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  hydrateFromSnapshot: (rows: Array<{ key: string; value: string }>) => void;
  getValue: (key: string, fallback?: string) => string;
  setValue: (key: string, value: string) => Promise<void>;
  getBoolean: (key: string, fallback?: boolean) => boolean;
  setBoolean: (key: string, value: boolean) => Promise<void>;
  onRemoteChange: (key: string, value: string) => void;
};

export const useSettingsStore = create<SettingsState>((set, get) => ({
  values: {},
  hydrated: false,
  async hydrate() {
    const rows = await window.api.settings.listByPrefix('');
    const map: Record<string, string> = {};
    for (const r of rows as SettingRecord[]) map[r.key] = r.value;
    set({ values: map, hydrated: true });
  },
  hydrateFromSnapshot(rows) {
    const map: Record<string, string> = {};
    for (const r of rows) map[r.key] = r.value;
    set({ values: map, hydrated: true });
  },
  getValue(key, fallback = '') {
    const v = get().values[key];
    return v ?? fallback;
  },
  async setValue(key, value) {
    await window.api.settings.set(key, value);
    set((s) => ({ values: { ...s.values, [key]: value } }));
  },
  getBoolean(key, fallback = false) {
    const v = get().values[key];
    if (v === undefined) return fallback ?? false;
    return v === 'true';
  },
  async setBoolean(key, value) {
    await window.api.settings.set(key, value ? 'true' : 'false');
    set((s) => ({ values: { ...s.values, [key]: value ? 'true' : 'false' } }));
  },
  onRemoteChange(key, value) {
    set((s) => ({ values: { ...s.values, [key]: value } }));
  },
}));
