import { contextBridge, ipcRenderer } from 'electron';

import type {
  MeetingReminderState,
  MeetingReminderTriggerPayload,
  MeetingReminderRecordCommand,
  MeetingReminderRecordResponse,
} from '../common/meetingReminder';

export type BinderSummary = {
  id: string;
  name: string;
  sort_index: number;
  color?: string | null;
  icon?: string | null;
  is_team_shared: number;
  remote_id?: string | null;
  user_profile_id?: string | null;
};

export type NoteListItem = {
  id: string;
  title: string;
  binder_id: string;
  created_at: number;
  updated_at: number;
  deleted: number;
  pinned: number;
  starred?: number;
  archived?: number;
};

// Import shared license types
import type {
  ComponentInfo,
  DownloadProgress,
  DownloadResult,
  SetupStatusEvent,
  VerificationResult,
} from '../shared/types/components';
import type {
  LicensePayload,
  HeartbeatStatus,
  HeartbeatLimitExceeded,
  LicenseWarning,
  LicenseValidatedEvent,
  LicenseExpiredEvent,
  UpgradePollingStatus,
} from '../shared/types/license';

// Import shared component types

// Update info type
export type UpdateInfo = {
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  downloadUrl: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  forceUpdate: boolean;
  platform: string;
};

// Download state type
export type DownloadState = 'idle' | 'downloading' | 'complete' | 'error';

// Download status type
export type DownloadStatus = {
  state: DownloadState;
  progress: number;
  downloadPath: string | null;
  error: string | null;
};

// Legacy type for backwards compatibility
export type LicenseIpcPayload = {
  status?: string;
  type?: string;
  validationMode?: string;
  expiresAt?: string | null;
  lastValidatedAt?: string | null;
  nextValidationAt?: string | null;
  features?: string[];
  issuedTo?: string | null;
  statusMessage?: string | null;
  warning?: string | null;
  [key: string]: unknown;
};

export type StorageApi = {
  // Notes
  createNote: (binderId: string) => Promise<string>;
  saveNote: (input: {
    noteId: string;
    lexicalJson: string;
    plainText: string;
    title?: string;
  }) => Promise<void>;
  getNote: (noteId: string) => Promise<{
    meta: {
      id: string;
      binderId: string;
      title: string;
      createdAt: Date;
      updatedAt: Date;
      deleted: boolean;
      pinned: boolean;
    };
    content: { lexicalJson: string; plainText: string };
  }>;
  listNotesByBinder: (binderId: string) => Promise<NoteListItem[]>;
  listUnassignedNotes: () => Promise<NoteListItem[]>;
  listAllNotes: () => Promise<NoteListItem[]>;
  listNotesByCreatedBetween: (start: number, end: number) => Promise<NoteListItem[]>;
  listDeletedNotes: () => Promise<NoteListItem[]>;
  emptyTrash: () => Promise<{ removed: number }>;
  deleteNote: (noteId: string) => Promise<void>;
  moveNote: (noteId: string, binderId: string) => Promise<void>;
  setStarred: (noteId: string, starred: boolean) => Promise<void>;
  listStarredNotes: () => Promise<NoteListItem[]>;
  setArchived: (noteId: string, archived: boolean) => Promise<void>;
  listArchivedNotes: () => Promise<NoteListItem[]>;
  search: (q: string) => Promise<
    Array<{
      type: 'note' | 'transcription' | 'tag';
      id: string;
      noteId: string | null;
      binderId: string | null;
      title: string;
      snippet: string;
      updatedAt: number;
      tagColor?: string | null;
      tagNoteCount?: number;
    }>
  >;
  // Binders
  listBinders: () => Promise<BinderSummary[]>;
  getDefaultBinderId: (binderName?: string) => Promise<string>;
  createBinder: (name: string, user_profile_id?: string | null) => Promise<string>;
  renameBinder: (id: string, name: string) => Promise<void>;
  updateBinder: (input: {
    id: string;
    name?: string;
    color?: string | null;
    icon?: string | null;
    is_team_shared?: number;
  }) => Promise<void>;
  deleteBinder: (id: string) => Promise<void>;
  reorderBinders: (order: string[]) => Promise<void>;
  // Conflicts (Phase 5)
  listConflicts: () => Promise<NoteListItem[]>;
  countConflicts: () => Promise<{ count: number }>;
  getConflictsForNote: (noteId: string) => Promise<NoteListItem[]>;
  getNotesWithConflicts: () => Promise<string[]>;
  getNoteWithConflictMeta: (noteId: string) => Promise<{
    meta: {
      id: string;
      binderId: string;
      title: string;
      createdAt: Date;
      updatedAt: Date;
      deleted: boolean;
      pinned: boolean;
      starred: boolean;
      archived: boolean;
      isConflict: boolean;
      conflictOfId: string | null;
      conflictCreatedAt: number | null;
    };
    content: { lexicalJson: string; plainText: string };
    conflictCopies: NoteListItem[];
  }>;
  resolveConflictUseConflictVersion: (
    conflictNoteId: string,
    canonicalNoteId: string
  ) => Promise<void>;
  resolveConflictKeepCanonical: (conflictNoteId: string) => Promise<void>;
  getConflictsBinder: () => Promise<BinderSummary | null>;
  hasUnresolvedConflicts: () => Promise<{ hasConflicts: boolean }>;
  listBindersWithConflicts: () => Promise<BinderSummary[]>;
};

export type Api = {
  windowControl: (cmd: 'min' | 'max' | 'close') => void;
  onDeepLink: (cb: (route: string) => void) => void;
  onAuthCompleted: (cb: (p: { success: boolean; error?: string }) => void) => () => void;
  onNotesChanged: (cb: () => void) => () => void;
  onSummaryNotification: (
    cb: (notification: {
      id: string;
      type: 'summary-started' | 'summary-completed' | 'summary-failed';
      title: string;
      message: string;
      jobId?: string;
      summaryId?: string;
      transcriptionId?: string;
      timestamp: Date;
    }) => void
  ) => () => void;
  onSummaryProgress: (
    cb: (progress: {
      jobId: string;
      transcriptionId: string;
      progress?: number;
      currentStep?: string;
      timestamp: Date;
    }) => void
  ) => () => void;
  onNavigateToTranscription: (
    cb: (data: { transcriptionId: string; highlightSummary?: boolean }) => void
  ) => () => void;
  rendererReady: () => void;
  platform: NodeJS.Platform;
  getVersion: () => Promise<string>;
  setTitlebarOverlay: (options: {
    color?: string;
    symbolColor?: string;
    height?: number;
  }) => Promise<boolean>;
  window: {
    openExternal: (url: string) => Promise<void>;
  };
  log: {
    setLevel: (level: 'error' | 'warn' | 'info' | 'http' | 'verbose' | 'debug' | 'silly') => void;
    info: (message: string, meta?: Record<string, unknown>) => void;
    warn: (message: string, meta?: Record<string, unknown>) => void;
    error: (message: string, meta?: Record<string, unknown>) => void;
    debug: (message: string, meta?: Record<string, unknown>) => void;
  };
  storage: StorageApi;
  settings: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
    listByPrefix: (prefix: string) => Promise<Array<{ key: string; value: string }>>;
  };
  user: {
    getProfile: () => Promise<{
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      avatar_path: string | null;
      updated_at: number;
    } | null>;
    saveProfile: (input: {
      first_name?: string | null;
      last_name?: string | null;
      email?: string | null;
      avatar_path?: string | null;
    }) => Promise<void>;
  };
  transcription: {
    startSession: (input: {
      binderId: string;
      noteId?: string;
      language: string;
    }) => Promise<{ sessionId: string; noteId: string }>;
    appendFinalText: (input: { sessionId: string; textChunk: string }) => Promise<void>;
    replaceFullText: (input: { sessionId: string; fullText: string }) => Promise<void>;
    completeSession: (input: { sessionId: string; endTime?: number }) => Promise<void>;
    applyRefinement: (input: {
      sessionId: string;
      segmentId: string;
      originalText: string;
      refinedText: string;
      confidenceImprovement?: number;
      timestamp: number;
    }) => Promise<void>;
    listByNote: (noteId: string) => Promise<
      Array<{
        id: string;
        language: string;
        status: string;
        start_time: number;
        end_time?: number;
        duration_ms?: number;
        char_count: number;
        word_count: number;
        updated_at: number;
      }>
    >;
    get: (sessionId: string) => Promise<{
      session: {
        id: string;
        note_id: string;
        binder_id: string;
        language: string;
        status: string;
        start_time: number;
        end_time?: number;
        duration_ms?: number;
        char_count: number;
        word_count: number;
        created_at: number;
        updated_at: number;
      };
      fullText: string;
    }>;
    exportSession: (input: { sessionId: string; targetPath?: string }) => Promise<string>;
    listModels: () => Promise<string[]>;
    restartServer: () => Promise<{ success: boolean; message?: string }>;
    getServerPort: () => Promise<{ port: number }>;
    saveRecording: (input: {
      sessionId: string;
      wavData: string;
    }) => Promise<{ filePath: string; success: boolean; durationMs: number; recordingId: string }>;
    getRecordingPath: (sessionId: string) => Promise<{ filePath: string | null; exists: boolean }>;
    getRecordingWithMeta: (sessionId: string) => Promise<{
      id: string | null;
      filePath: string | null;
      durationMs: number | null;
      exists: boolean;
    }>;
    refine: (
      sessionId: string,
      hints?: string
    ) => Promise<{ text: string; success: boolean; usedHints?: boolean }>;
    saveCorrection: (input: {
      sessionId: string;
      originalText: string;
      correctedText: string;
    }) => Promise<{ success: boolean }>;
    saveSegments: (input: {
      sessionId: string;
      segments: Array<{
        segmentId: string;
        text: string;
        startTime: number;
        endTime: number;
        sequenceOrder: number;
      }>;
    }) => Promise<{ success: boolean; segmentCount: number }>;
    getSegments: (sessionId: string) => Promise<
      Array<{
        id: string;
        segmentId: string;
        text: string;
        startTime: number;
        endTime: number;
        sequenceOrder: number;
        userEdited: boolean;
        originalText: string | null;
      }>
    >;
    markSegmentEdited: (input: {
      sessionId: string;
      segmentId: string;
      newText: string;
    }) => Promise<{ success: boolean }>;
    listAllWithDetails: () => Promise<
      Array<{
        id: string;
        noteId: string;
        binderId: string;
        noteTitle: string;
        startTime: number;
        endTime: number | null;
        durationMs: number | null;
        wordCount: number;
        charCount: number;
        previewText: string;
      }>
    >;
  };
  summary: {
    generate: (input: {
      transcriptionId: string;
      summaryType?: string;
      forceRegenerate?: boolean;
    }) => Promise<{
      success: boolean;
      summary?: {
        id: string;
        transcriptionId: string;
        summaryText: string;
        summaryType: string;
        processingTimeMs?: number;
        modelUsed?: string;
        backendType?: string;
        pipelineUsed?: boolean;
        createdAt: Date;
        updatedAt: Date;
      };
      error?: string;
    }>;
    get: (summaryId: string) => Promise<{
      success: boolean;
      summary?: {
        id: string;
        transcriptionId: string;
        summaryText: string;
        summaryType: string;
        processingTimeMs?: number;
        modelUsed?: string;
        backendType?: string;
        pipelineUsed?: boolean;
        createdAt: Date;
        updatedAt: Date;
      };
      error?: string;
    }>;
    getByTranscription: (transcriptionId: string) => Promise<{
      success: boolean;
      summaries?: Array<{
        id: string;
        transcriptionId: string;
        summaryText: string;
        summaryType: string;
        processingTimeMs?: number;
        modelUsed?: string;
        backendType?: string;
        pipelineUsed?: boolean;
        createdAt: Date;
        updatedAt: Date;
      }>;
      error?: string;
    }>;
    delete: (summaryId: string) => Promise<{
      success: boolean;
      error?: string;
    }>;
    list: () => Promise<{
      success: boolean;
      summaries?: Array<{
        id: string;
        transcriptionId: string;
        summaryText: string;
        summaryType: string;
        processingTimeMs?: number;
        modelUsed?: string;
        backendType?: string;
        pipelineUsed?: boolean;
        createdAt: Date;
        updatedAt: Date;
      }>;
      error?: string;
    }>;
    checkServerSummaryExists: (transcriptionId: string) => Promise<{
      success: boolean;
      exists?: boolean;
      error?: string;
    }>;
    updateSummaryText: (
      summaryId: string,
      summaryText: string
    ) => Promise<{ success: boolean; error?: string }>;
  };
  calendar: {
    getStatus: () => Promise<{
      connected: boolean;
      syncStatus?: string | null;
      lastSyncTime?: string | null;
      errorMessage?: string | null;
    }>;
    listEvents: (input: {
      startTime: string;
      endTime: string;
      timezone?: string;
      maxResults?: number;
      useCache?: boolean;
      forceRefresh?: boolean;
    }) => Promise<unknown[]>;
    getConnectUrl: () => Promise<string>;
    startConnect: () => Promise<boolean>;
    disconnect: () => Promise<boolean>;
    onConnectResult: (
      cb: (result: { success: boolean; error?: string | null; canceled?: boolean }) => void
    ) => () => void;
  };
  license: {
    getCurrent: () => Promise<LicensePayload | null>;
    validate: (key: string) => Promise<LicensePayload | null>;
    clearCache: () => Promise<void>;
    getFeatures: () => Promise<string[]>;
    hasFeature: (key: string) => Promise<boolean>;
    manualCheck: () => Promise<LicensePayload>;
    checkServerHealth: (
      apiUrl?: string
    ) => Promise<{ online: boolean; responseTime: number; error?: string }>;
    setApiUrl: (url: string | null) => Promise<void>;
    getApiUrl: () => Promise<string>;
    fetchCurrent: () => Promise<LicensePayload>;
    getDiagnostics: () => Promise<unknown>;
    exportDiagnostics: () => Promise<{ success: boolean; path?: string; error?: string }>;
    clearValidationHistory: () => Promise<void>;
    onChanged: (cb: (payload: LicensePayload) => void) => () => void;
    onFeaturesChanged: (cb: (features: string[]) => void) => () => void;
    onValidated: (cb: (event: LicenseValidatedEvent) => void) => () => void;
    onExpired: (cb: (event: LicenseExpiredEvent) => void) => () => void;
    onWarning: (cb: (warning: LicenseWarning) => void) => () => void;
    // Upgrade polling
    startUpgradePolling: () => Promise<void>;
    stopUpgradePolling: () => Promise<void>;
    getUpgradePollingStatus: () => Promise<UpgradePollingStatus>;
    onUpgradePollingStatusChanged: (cb: (status: UpgradePollingStatus) => void) => () => void;
    onUpgradeSuccess: (cb: (license: LicensePayload) => void) => () => void;
  };
  heartbeat: {
    getStatus: () => Promise<HeartbeatStatus>;
    onLimitExceeded: (cb: (event: HeartbeatLimitExceeded) => void) => () => void;
  };
  update: {
    check: (force?: boolean) => Promise<{ success: boolean; data?: UpdateInfo; error?: string }>;
    getCached: () => Promise<UpdateInfo | null>;
    openDownload: () => Promise<boolean>;
    dismiss: (version: string) => Promise<void>;
    isDismissed: (version: string) => Promise<boolean>;
    getVersion: () => Promise<string>;
    // New download methods
    startDownload: () => Promise<{ success: boolean; error?: string }>;
    getDownloadStatus: () => Promise<DownloadStatus>;
    isDownloadReady: () => Promise<boolean>;
    installAndRestart: () => Promise<{ success: boolean; error?: string }>;
    cancelDownload: () => Promise<void>;
    resetDownload: () => Promise<void>;
    // Events
    onAvailable: (cb: (info: UpdateInfo) => void) => () => void;
    onDismissed: (cb: (version: string) => void) => () => void;
    onDownloadStarted: (cb: () => void) => () => void;
    onDownloadProgress: (cb: (progress: number) => void) => () => void;
    onDownloadComplete: (cb: (downloadPath: string) => void) => () => void;
    onDownloadError: (cb: (error: string) => void) => () => void;
  };
  meetingReminder: {
    getState: () => Promise<MeetingReminderState>;
    setEnabled: (enabled: boolean) => Promise<void>;
    setMuteUntil: (muteUntil: number | null) => Promise<void>;
    clearMute: () => Promise<void>;
    snooze: (eventKey: string, snoozeUntil: number) => Promise<void>;
    clearSnooze: (eventKey: string) => Promise<void>;
    refresh: () => Promise<void>;
    dismiss: () => Promise<void>;
    testTrigger: () => Promise<void>;
    onReminderDue: (cb: (payload: MeetingReminderTriggerPayload) => void) => () => void;
    onStateChanged: (cb: (state: MeetingReminderState) => void) => () => void;
    startRecording: (input: {
      payload: MeetingReminderTriggerPayload;
      force?: boolean;
    }) => Promise<MeetingReminderRecordResponse>;
    onRecordCommand: (cb: (command: MeetingReminderRecordCommand) => void) => () => void;
  };
  auth: {
    beginMicrosoftLogin: () => Promise<{ success: boolean; error?: string }>;
    passwordLogin: (
      email: string,
      password: string
    ) => Promise<{
      success: boolean;
      error?: string;
    }>;
    startWebLogin: () => Promise<boolean>;
    linkAccount: () => Promise<{ success: boolean; error?: string }>;
    logout: () => Promise<{ success: boolean; error?: string }>;
    getStatus: () => Promise<{
      isConfigured: boolean;
      isLinked: boolean;
      hasValidAccessToken: boolean;
      tokenExpiresAt: string | null;
      userId: string | null;
      deviceId: string | null;
    }>;
  };
  onSettingsChanged: (cb: (key: string, value: string) => void) => () => void;
  onSettingsHydrate: (cb: (rows: Array<{ key: string; value: string }>) => void) => () => void;
  onProfileChanged?: (cb: () => void) => () => void;
  systemAudio: {
    isSupported: () => Promise<boolean>;
    getInitError: () => Promise<string | null>;
    getLoopbackStream: () => Promise<MediaStream>;
  };
  tags: {
    create: (input: { name: string; color?: string }) => Promise<string>;
    list: () => Promise<
      Array<{
        id: string;
        userId: string | null;
        name: string;
        color: string | null;
        sortIndex: number;
        createdAt: Date;
        updatedAt: Date;
        deleted: boolean;
        noteCount?: number;
      }>
    >;
    get: (id: string) => Promise<{
      id: string;
      userId: string | null;
      name: string;
      color: string | null;
      sortIndex: number;
      createdAt: Date;
      updatedAt: Date;
      deleted: boolean;
      noteCount?: number;
    } | null>;
    update: (input: { id: string; name?: string; color?: string | null }) => Promise<void>;
    delete: (id: string) => Promise<void>;
    reorder: (ids: string[]) => Promise<void>;
    addToNote: (noteId: string, tagId: string) => Promise<string>;
    removeFromNote: (noteId: string, tagId: string) => Promise<void>;
    setNoteTags: (noteId: string, tagIds: string[]) => Promise<void>;
    getByNote: (noteId: string) => Promise<
      Array<{
        id: string;
        userId: string | null;
        name: string;
        color: string | null;
        sortIndex: number;
        createdAt: Date;
        updatedAt: Date;
        deleted: boolean;
        noteCount?: number;
      }>
    >;
    getNotesByTag: (tagId: string) => Promise<NoteListItem[]>;
  };
  onTagsChanged: (cb: () => void) => () => void;
  onNoteTagsChanged: (cb: () => void) => () => void;
  // Sync operations
  sync: {
    getStatus: () => Promise<unknown>;
    performSync: () => Promise<unknown>;
    push: () => Promise<unknown>;
    pull: () => Promise<unknown>;
    resetRetryState: () => Promise<void>;
    getConflicts: () => Promise<unknown>;
    clearConflicts: () => Promise<void>;
    getHealthStatus: () => Promise<unknown>;
    getHealthMetrics: () => Promise<unknown>;
    getServerStats: () => Promise<unknown>;
  };
  onSyncStart: (cb: () => void) => () => void;
  onSyncComplete: (cb: (result: unknown) => void) => () => void;
  onSyncError: (cb: (error: unknown) => void) => () => void;
  // Password protection / security
  security: {
    getPasswordStatus: () => Promise<{
      enabled: boolean;
      locked: boolean;
      rememberActive: boolean;
      rememberUntil: string | null;
      recoveryKeyShown: boolean;
      passwordChangedAt: string | null;
    }>;
    enablePassword: (input: {
      password: string;
      confirmPassword: string;
    }) => Promise<{ success: boolean; error?: string }>;
    disablePassword: (input: { password: string }) => Promise<{ success: boolean; error?: string }>;
    verifyPassword: (input: {
      password: string;
      remember?: boolean;
    }) => Promise<{ success: boolean; error?: string }>;
    changePassword: (input: {
      currentPassword: string;
      newPassword: string;
      confirmPassword: string;
    }) => Promise<{ success: boolean; error?: string }>;
    lock: () => Promise<{ success: boolean }>;
    clearRemember: () => Promise<{ success: boolean }>;
    exportRecoveryKey: () => Promise<string>;
    importRecoveryKey: (input: {
      recoveryKey: string;
    }) => Promise<{ success: boolean; error?: string }>;
    markRecoveryKeyShown: () => Promise<{ success: boolean }>;
    resetPasswordWithRecoveryKey: (input: {
      recoveryKey: string;
      newPassword: string;
      confirmPassword: string;
    }) => Promise<{ success: boolean; error?: string }>;
    onStatusChanged: (
      cb: (status: {
        enabled: boolean;
        locked: boolean;
        rememberActive: boolean;
        rememberUntil: string | null;
        recoveryKeyShown: boolean;
        passwordChangedAt: string | null;
      }) => void
    ) => () => void;
  };
  // Diagnostics upload
  diagnostics: {
    upload: () => Promise<{ success: boolean; error?: string }>;
  };
  // Note export functionality
  export: {
    note: (
      noteId: string,
      format: 'txt' | 'md' | 'docx' | 'rtf' | 'pdf'
    ) => Promise<{
      success: boolean;
      filePath?: string;
      error?: string;
    }>;
  };
  // Component download functionality
  components: {
    checkAll: () => Promise<ComponentInfo[]>;
    download: (componentId: string) => Promise<DownloadResult>;
    downloadAll: () => Promise<{ success: boolean; results: DownloadResult[] }>;
    cancelDownload: () => Promise<void>;
    verify: (componentId: string) => Promise<VerificationResult>;
    repair: (componentId: string) => Promise<DownloadResult>;
    getInfo: (componentId: string) => Promise<ComponentInfo>;
    areAllReady: () => Promise<boolean>;
    getSetupStatus: () => Promise<SetupStatusEvent | null>;
    setupRetryComplete: () => Promise<void>;
    // Event listeners
    onStatusChanged: (cb: (info: ComponentInfo) => void) => () => void;
    onDownloadProgress: (cb: (progress: DownloadProgress) => void) => () => void;
    onDownloadComplete: (cb: (componentId: string) => void) => () => void;
    onDownloadError: (cb: (data: { componentId: string; error: string }) => void) => () => void;
    onAllReady: (cb: () => void) => () => void;
    onSetupStatus: (cb: (status: SetupStatusEvent) => void) => () => void;
  };
  // Native macOS menu integration
  menu: {
    onNavigate: (cb: (route: string) => void) => () => void;
    onOpenTranscriptions: (cb: () => void) => () => void;
    onExport: (cb: (format: string) => void) => () => void;
    onFontZoomIn: (cb: () => void) => () => void;
    onFontZoomOut: (cb: () => void) => () => void;
    onFontZoomReset: (cb: () => void) => () => void;
    onNewNote: (cb: () => void) => () => void;
    updateState: (state: { noteId: string | null }) => void;
  };
};

const storage: StorageApi = {
  createNote: (binderId) => ipcRenderer.invoke('storage:createNote', { binderId }),
  saveNote: (input) => ipcRenderer.invoke('storage:saveNote', input),
  getNote: (noteId) => ipcRenderer.invoke('storage:getNote', { noteId }),
  listNotesByBinder: (binderId) => ipcRenderer.invoke('storage:listNotesByBinder', { binderId }),
  listUnassignedNotes: () => ipcRenderer.invoke('storage:listUnassignedNotes'),
  listAllNotes: () => ipcRenderer.invoke('storage:listAllNotes'),
  listNotesByCreatedBetween: (start, end) =>
    ipcRenderer.invoke('storage:listNotesByCreatedBetween', { start, end }),
  listDeletedNotes: () => ipcRenderer.invoke('storage:listDeletedNotes'),
  emptyTrash: () => ipcRenderer.invoke('storage:emptyTrash'),
  deleteNote: (noteId) => ipcRenderer.invoke('storage:deleteNote', { noteId }),
  moveNote: (noteId, binderId) => ipcRenderer.invoke('storage:moveNote', { noteId, binderId }),
  setStarred: (noteId, starred) => ipcRenderer.invoke('storage:setStarred', { noteId, starred }),
  listStarredNotes: () => ipcRenderer.invoke('storage:listStarredNotes'),
  setArchived: (noteId, archived) =>
    ipcRenderer.invoke('storage:setArchived', { noteId, archived }),
  listArchivedNotes: () => ipcRenderer.invoke('storage:listArchivedNotes'),
  search: (q) => ipcRenderer.invoke('storage:search', { q }),
  listBinders: () => ipcRenderer.invoke('storage:listBinders'),
  getDefaultBinderId: (binderName) => ipcRenderer.invoke('storage:getDefaultBinderId', binderName),
  createBinder: (name, user_profile_id = null) =>
    ipcRenderer.invoke('storage:createBinder', { name, user_profile_id }),
  renameBinder: (id, name) => ipcRenderer.invoke('storage:renameBinder', { id, name }),
  updateBinder: (input) => ipcRenderer.invoke('storage:updateBinder', input),
  deleteBinder: (id) => ipcRenderer.invoke('storage:deleteBinder', { id }),
  reorderBinders: (order) => ipcRenderer.invoke('storage:reorderBinders', { order }),
  // Conflicts (Phase 5)
  listConflicts: () => ipcRenderer.invoke('storage:listConflicts'),
  countConflicts: () => ipcRenderer.invoke('storage:countConflicts'),
  getConflictsForNote: (noteId) => ipcRenderer.invoke('storage:getConflictsForNote', { noteId }),
  getNotesWithConflicts: () => ipcRenderer.invoke('storage:getNotesWithConflicts'),
  getNoteWithConflictMeta: (noteId) =>
    ipcRenderer.invoke('storage:getNoteWithConflictMeta', { noteId }),
  resolveConflictUseConflictVersion: (conflictNoteId, canonicalNoteId) =>
    ipcRenderer.invoke('storage:resolveConflictUseConflictVersion', {
      conflictNoteId,
      canonicalNoteId,
    }),
  resolveConflictKeepCanonical: (conflictNoteId) =>
    ipcRenderer.invoke('storage:resolveConflictKeepCanonical', { conflictNoteId }),
  getConflictsBinder: () => ipcRenderer.invoke('storage:getConflictsBinder'),
  hasUnresolvedConflicts: () => ipcRenderer.invoke('storage:hasUnresolvedConflicts'),
  listBindersWithConflicts: () => ipcRenderer.invoke('storage:listBindersWithConflicts'),
};

const api = {
  windowControl: (cmd: 'min' | 'max' | 'close') => ipcRenderer.send('window-control', cmd),
  onDeepLink: (cb: (route: string) => void) =>
    ipcRenderer.on('deep-link', (_e, route) => cb(route)),
  onAuthCompleted: (cb: (p: { success: boolean; error?: string }) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, p: { success: boolean; error?: string }) =>
      cb(p);
    ipcRenderer.on('auth:completed', handler);
    return () => ipcRenderer.removeListener('auth:completed', handler);
  },
  meetingReminder: {
    getState: (): Promise<MeetingReminderState> => ipcRenderer.invoke('meetingReminder:getState'),
    setEnabled: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke('meetingReminder:setEnabled', { enabled }),
    setMuteUntil: (muteUntil: number | null): Promise<void> =>
      ipcRenderer.invoke('meetingReminder:setMuteUntil', { muteUntil }),
    clearMute: (): Promise<void> => ipcRenderer.invoke('meetingReminder:clearMute'),
    snooze: (eventKey: string, snoozeUntil: number): Promise<void> =>
      ipcRenderer.invoke('meetingReminder:snooze', { eventKey, snoozeUntil }),
    clearSnooze: (eventKey: string): Promise<void> =>
      ipcRenderer.invoke('meetingReminder:clearSnooze', { eventKey }),
    refresh: (): Promise<void> => ipcRenderer.invoke('meetingReminder:refresh'),
    dismiss: (): Promise<void> => ipcRenderer.invoke('meetingReminder:dismiss'),
    testTrigger: (): Promise<void> => ipcRenderer.invoke('meetingReminder:testTrigger'),
    onReminderDue: (cb: (payload: MeetingReminderTriggerPayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: MeetingReminderTriggerPayload) =>
        cb(payload);
      ipcRenderer.on('meetingReminder:reminderDue', handler);
      return () => ipcRenderer.removeListener('meetingReminder:reminderDue', handler);
    },
    onStateChanged: (cb: (state: MeetingReminderState) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: MeetingReminderState) => cb(state);
      ipcRenderer.on('meetingReminder:stateChanged', handler);
      return () => ipcRenderer.removeListener('meetingReminder:stateChanged', handler);
    },
    startRecording: (input: {
      payload: MeetingReminderTriggerPayload;
      force?: boolean;
    }): Promise<MeetingReminderRecordResponse> =>
      ipcRenderer.invoke('meetingReminder:startRecording', input),
    onRecordCommand: (cb: (command: MeetingReminderRecordCommand) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, command: MeetingReminderRecordCommand) =>
        cb(command);
      ipcRenderer.on('meetingReminder:recordCommand', handler);
      return () => ipcRenderer.removeListener('meetingReminder:recordCommand', handler);
    },
  },
  rendererReady: () => ipcRenderer.send('renderer-ready'),
  platform: process.platform,
  isDevelopment: () => ipcRenderer.invoke('app:isDevelopment'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  setTitlebarOverlay: (options: { color?: string; symbolColor?: string; height?: number }) =>
    ipcRenderer.invoke('window:setTitlebarOverlay', options),
  window: {
    openExternal: (url: string) => ipcRenderer.invoke('window:openExternal', url),
  },
  log: {
    setLevel: (level: 'error' | 'warn' | 'info' | 'http' | 'verbose' | 'debug' | 'silly') =>
      ipcRenderer.send('log:setLevel', level),
    info: (message: string, meta?: Record<string, unknown>) =>
      ipcRenderer.send('log:info', { message, meta }),
    warn: (message: string, meta?: Record<string, unknown>) =>
      ipcRenderer.send('log:warn', { message, meta }),
    error: (message: string, meta?: Record<string, unknown>) =>
      ipcRenderer.send('log:error', { message, meta }),
    debug: (message: string, meta?: Record<string, unknown>) =>
      ipcRenderer.send('log:debug', { message, meta }),
  },
  storage,
  settings: {
    get: (key: string) => ipcRenderer.invoke('settings:get', { key }),
    set: (key: string, value: string) => ipcRenderer.invoke('settings:set', { key, value }),
    listByPrefix: (prefix: string) => ipcRenderer.invoke('settings:listByPrefix', { prefix }),
  },
  user: {
    getProfile: () => ipcRenderer.invoke('user:getProfile'),
    saveProfile: (input) => ipcRenderer.invoke('user:saveProfile', input),
  },
  transcription: {
    startSession: (input: { binderId: string; noteId?: string; language: string }) =>
      ipcRenderer.invoke('transcription:startSession', input),
    appendFinalText: (input: { sessionId: string; textChunk: string }) =>
      ipcRenderer.invoke('transcription:appendFinalText', input),
    replaceFullText: (input: { sessionId: string; fullText: string }) =>
      ipcRenderer.invoke('transcription:replaceFullText', input),
    completeSession: (input: { sessionId: string; endTime?: number }) =>
      ipcRenderer.invoke('transcription:completeSession', input),
    applyRefinement: (input: {
      sessionId: string;
      segmentId: string;
      originalText: string;
      refinedText: string;
      confidenceImprovement?: number;
      timestamp: number;
    }) => ipcRenderer.invoke('transcription:applyRefinement', input),
    listByNote: (noteId: string) => ipcRenderer.invoke('transcription:listByNote', { noteId }),
    get: (sessionId: string) => ipcRenderer.invoke('transcription:get', { sessionId }),
    // Convenience bridge for content preview in UI
    getContent: async (sessionId: string): Promise<string> => {
      const result = await ipcRenderer.invoke('transcription:get', { sessionId });
      // result is { session, fullText }
      return result?.fullText ?? '';
    },
    exportSession: (input: { sessionId: string; targetPath?: string }) =>
      ipcRenderer.invoke('transcription:exportSession', input),
    listModels: (): Promise<string[]> => ipcRenderer.invoke('transcription:listModels'),
    restartServer: (): Promise<{ success: boolean; message?: string }> =>
      ipcRenderer.invoke('transcription:restartServer'),
    getServerPort: (): Promise<{ port: number }> =>
      ipcRenderer.invoke('transcription:getServerPort'),
    saveRecording: (input: {
      sessionId: string;
      wavData: string;
    }): Promise<{ filePath: string; success: boolean; durationMs: number; recordingId: string }> =>
      ipcRenderer.invoke('transcription:saveRecording', input),
    getRecordingPath: (sessionId: string): Promise<{ filePath: string | null; exists: boolean }> =>
      ipcRenderer.invoke('transcription:getRecordingPath', { sessionId }),
    getRecordingWithMeta: (
      sessionId: string
    ): Promise<{
      id: string | null;
      filePath: string | null;
      durationMs: number | null;
      exists: boolean;
    }> => ipcRenderer.invoke('transcription:getRecordingWithMeta', { sessionId }),
    refine: (
      sessionId: string,
      hints?: string
    ): Promise<{ text: string; success: boolean; usedHints?: boolean }> =>
      ipcRenderer.invoke('transcription:refine', { sessionId, hints }),
    saveCorrection: (input: {
      sessionId: string;
      originalText: string;
      correctedText: string;
    }): Promise<{ success: boolean }> => ipcRenderer.invoke('transcription:saveCorrection', input),
    saveSegments: (input: {
      sessionId: string;
      segments: Array<{
        segmentId: string;
        text: string;
        startTime: number;
        endTime: number;
        sequenceOrder: number;
      }>;
    }): Promise<{ success: boolean; segmentCount: number }> =>
      ipcRenderer.invoke('transcription:saveSegments', input),
    getSegments: (
      sessionId: string
    ): Promise<
      Array<{
        id: string;
        segmentId: string;
        text: string;
        startTime: number;
        endTime: number;
        sequenceOrder: number;
        userEdited: boolean;
        originalText: string | null;
      }>
    > => ipcRenderer.invoke('transcription:getSegments', { sessionId }),
    markSegmentEdited: (input: {
      sessionId: string;
      segmentId: string;
      newText: string;
    }): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('transcription:markSegmentEdited', input),
    listAllWithDetails: (): Promise<
      Array<{
        id: string;
        noteId: string;
        binderId: string;
        noteTitle: string;
        startTime: number;
        endTime: number | null;
        durationMs: number | null;
        wordCount: number;
        charCount: number;
        previewText: string;
      }>
    > => ipcRenderer.invoke('transcription:listAllWithDetails'),
    // DEV ONLY: Create a transcription with pasted text
    createDevSession: (input: { binderId: string; noteId: string; text: string }) =>
      ipcRenderer.invoke('transcription:createDevSession', input),
  },
  summary: {
    generate: (input: {
      transcriptionId: string;
      summaryType?: string;
      forceRegenerate?: boolean;
    }) => ipcRenderer.invoke('summary:generate', input),
    get: (summaryId: string) => ipcRenderer.invoke('summary:get', { summaryId }),
    getByTranscription: (transcriptionId: string) =>
      ipcRenderer.invoke('summary:getByTranscription', { transcriptionId }),
    delete: (summaryId: string) => ipcRenderer.invoke('summary:delete', { summaryId }),
    list: () => ipcRenderer.invoke('summary:list'),
    checkServerSummaryExists: (transcriptionId: string) =>
      ipcRenderer.invoke('summary:checkServerSummaryExists', transcriptionId),
    updateSummaryText: (summaryId: string, summaryText: string) =>
      ipcRenderer.invoke('summary:updateSummaryText', { summaryId, summaryText }),
  },
  calendar: {
    getStatus: () => ipcRenderer.invoke('calendar:getStatus'),
    listEvents: (input) => ipcRenderer.invoke('calendar:listEvents', input),
    getConnectUrl: () => ipcRenderer.invoke('calendar:getConnectUrl'),
    startConnect: () => ipcRenderer.invoke('calendar:startConnect'),
    disconnect: () => ipcRenderer.invoke('calendar:disconnect'),
    onConnectResult: (cb) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { success: boolean; error?: string | null; canceled?: boolean }
      ) => {
        cb(payload);
      };
      ipcRenderer.on('calendar:connect-result', handler);
      return () => {
        ipcRenderer.removeListener('calendar:connect-result', handler);
      };
    },
  },
  license: {
    getCurrent: () => ipcRenderer.invoke('license:get-current'),
    validate: (key: string) => ipcRenderer.invoke('license:validate', { key }),
    clearCache: () => ipcRenderer.invoke('license:clear-cache'),
    getFeatures: () => ipcRenderer.invoke('license:get-features'),
    hasFeature: (key: string) => ipcRenderer.invoke('license:has-feature', key),
    manualCheck: () => ipcRenderer.invoke('license:manual-check'),
    checkServerHealth: (apiUrl?: string) =>
      ipcRenderer.invoke('license:check-server-health', apiUrl),
    setApiUrl: (url: string | null) => ipcRenderer.invoke('license:set-api-url', url),
    getApiUrl: () => ipcRenderer.invoke('license:get-api-url'),
    fetchCurrent: () => ipcRenderer.invoke('license:fetch-current'),
    getDiagnostics: () => ipcRenderer.invoke('license:get-diagnostics'),
    exportDiagnostics: () => ipcRenderer.invoke('license:export-diagnostics'),
    clearValidationHistory: () => ipcRenderer.invoke('license:clear-validation-history'),
    // Upgrade polling methods
    startUpgradePolling: () => ipcRenderer.invoke('license:start-upgrade-polling'),
    stopUpgradePolling: () => ipcRenderer.invoke('license:stop-upgrade-polling'),
    getUpgradePollingStatus: () =>
      ipcRenderer.invoke('license:get-upgrade-polling-status') as Promise<UpgradePollingStatus>,
    onUpgradePollingStatusChanged: (cb: (status: UpgradePollingStatus) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: UpgradePollingStatus) =>
        cb(status);
      ipcRenderer.on('license:upgrade-polling-status', handler);
      return () => {
        ipcRenderer.removeListener('license:upgrade-polling-status', handler);
      };
    },
    onUpgradeSuccess: (cb: (license: LicensePayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, license: LicensePayload) => cb(license);
      ipcRenderer.on('license:upgrade-success', handler);
      return () => {
        ipcRenderer.removeListener('license:upgrade-success', handler);
      };
    },
    onChanged: (cb: (payload: LicensePayload) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: LicensePayload) => cb(payload);
      ipcRenderer.on('license:changed', handler);
      return () => {
        ipcRenderer.removeListener('license:changed', handler);
      };
    },
    onFeaturesChanged: (cb: (features: string[]) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, features: string[]) => cb(features);
      ipcRenderer.on('license:features-changed', handler);
      return () => {
        ipcRenderer.removeListener('license:features-changed', handler);
      };
    },
    onValidated: (cb: (event: LicenseValidatedEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: LicenseValidatedEvent) =>
        cb(payload);
      ipcRenderer.on('license:validated', handler);
      return () => {
        ipcRenderer.removeListener('license:validated', handler);
      };
    },
    onExpired: (cb: (event: LicenseExpiredEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: LicenseExpiredEvent) =>
        cb(payload);
      ipcRenderer.on('license:expired', handler);
      return () => {
        ipcRenderer.removeListener('license:expired', handler);
      };
    },
    onWarning: (cb: (warning: LicenseWarning) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: LicenseWarning) => cb(payload);
      ipcRenderer.on('license:warning', handler);
      return () => {
        ipcRenderer.removeListener('license:warning', handler);
      };
    },
  },
  heartbeat: {
    getStatus: () => ipcRenderer.invoke('heartbeat:get-status'),
    onLimitExceeded: (cb: (event: HeartbeatLimitExceeded) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: HeartbeatLimitExceeded) =>
        cb(payload);
      ipcRenderer.on('heartbeat:limit-exceeded', handler);
      return () => {
        ipcRenderer.removeListener('heartbeat:limit-exceeded', handler);
      };
    },
  },
  update: {
    check: (force?: boolean) => ipcRenderer.invoke('update:check', force),
    getCached: () => ipcRenderer.invoke('update:getCached'),
    openDownload: () => ipcRenderer.invoke('update:openDownload'),
    dismiss: (version: string) => ipcRenderer.invoke('update:dismiss', version),
    isDismissed: (version: string) => ipcRenderer.invoke('update:isDismissed', version),
    getVersion: () => ipcRenderer.invoke('update:getVersion'),
    // New download methods
    startDownload: () => ipcRenderer.invoke('update:startDownload'),
    getDownloadStatus: () => ipcRenderer.invoke('update:getDownloadStatus'),
    isDownloadReady: () => ipcRenderer.invoke('update:isDownloadReady'),
    installAndRestart: () => ipcRenderer.invoke('update:installAndRestart'),
    cancelDownload: () => ipcRenderer.invoke('update:cancelDownload'),
    resetDownload: () => ipcRenderer.invoke('update:resetDownload'),
    // Events
    onAvailable: (cb: (info: UpdateInfo) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, info: UpdateInfo) => cb(info);
      ipcRenderer.on('update:available', handler);
      return () => {
        ipcRenderer.removeListener('update:available', handler);
      };
    },
    onDismissed: (cb: (version: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, version: string) => cb(version);
      ipcRenderer.on('update:dismissed', handler);
      return () => {
        ipcRenderer.removeListener('update:dismissed', handler);
      };
    },
    onDownloadStarted: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('update:download-started', handler);
      return () => {
        ipcRenderer.removeListener('update:download-started', handler);
      };
    },
    onDownloadProgress: (cb: (progress: number) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: number) => cb(progress);
      ipcRenderer.on('update:download-progress', handler);
      return () => {
        ipcRenderer.removeListener('update:download-progress', handler);
      };
    },
    onDownloadComplete: (cb: (downloadPath: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, downloadPath: string) => cb(downloadPath);
      ipcRenderer.on('update:download-complete', handler);
      return () => {
        ipcRenderer.removeListener('update:download-complete', handler);
      };
    },
    onDownloadError: (cb: (error: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, error: string) => cb(error);
      ipcRenderer.on('update:download-error', handler);
      return () => {
        ipcRenderer.removeListener('update:download-error', handler);
      };
    },
  },
  auth: {
    beginMicrosoftLogin: () => ipcRenderer.invoke('auth:beginMicrosoftLogin'),
    passwordLogin: (email: string, password: string) =>
      ipcRenderer.invoke('auth:passwordLogin', email, password),
    startWebLogin: () => ipcRenderer.invoke('auth:startWebLogin'),
    linkAccount: () => ipcRenderer.invoke('auth:linkAccount'),
    logout: () => ipcRenderer.invoke('auth:logout'),
    getStatus: () => ipcRenderer.invoke('auth:getStatus'),
  },
  onSettingsChanged: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, p: { key: string; value: string }) =>
      cb(p.key, p.value);
    ipcRenderer.on('settings:changed', handler);
    return () => ipcRenderer.removeListener('settings:changed', handler);
  },
  onSettingsHydrate: (cb) => {
    const handler = (_e: Electron.IpcRendererEvent, rows: Array<{ key: string; value: string }>) =>
      cb(rows);
    ipcRenderer.on('settings:hydrate', handler);
    return () => ipcRenderer.removeListener('settings:hydrate', handler);
  },
  onNotesChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('notes:changed', handler);
    return () => ipcRenderer.removeListener('notes:changed', handler);
  },
  onSummaryNotification: (
    cb: (notification: {
      id: string;
      type: 'summary-started' | 'summary-completed' | 'summary-failed';
      title: string;
      message: string;
      jobId?: string;
      summaryId?: string;
      transcriptionId?: string;
      timestamp: Date;
    }) => void
  ) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      notification: {
        type: string;
        message: string;
        summaryId?: string;
        transcriptionId?: string;
        timestamp: Date;
      }
    ) => cb(notification);
    ipcRenderer.on('summary-notification', handler);
    return () => ipcRenderer.removeListener('summary-notification', handler);
  },
  onSummaryProgress: (
    cb: (progress: {
      jobId: string;
      transcriptionId: string;
      progress?: number;
      currentStep?: string;
      timestamp: Date;
    }) => void
  ) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      progress: {
        jobId: string;
        transcriptionId: string;
        progress?: number;
        currentStep?: string;
        timestamp: Date;
      }
    ) => cb(progress);
    ipcRenderer.on('summary-progress', handler);
    return () => ipcRenderer.removeListener('summary-progress', handler);
  },
  onNavigateToTranscription: (
    cb: (data: { transcriptionId: string; highlightSummary?: boolean }) => void
  ) => {
    const handler = (
      _e: Electron.IpcRendererEvent,
      data: { transcriptionId: string; highlightSummary?: boolean }
    ) => cb(data);
    ipcRenderer.on('navigate-to-transcription', handler);
    return () => ipcRenderer.removeListener('navigate-to-transcription', handler);
  },
  onProfileChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('user:profileChanged', handler);
    return () => ipcRenderer.removeListener('user:profileChanged', handler);
  },
  // System audio capture for transcribing meeting participants
  systemAudio: {
    isSupported: () => ipcRenderer.invoke('systemAudio:isSupported'),
    getInitError: () => ipcRenderer.invoke('systemAudio:getInitError'),
    getLoopbackStream: async () => {
      // getLoopbackAudioMediaStream runs in renderer process per package docs
      const { getLoopbackAudioMediaStream } = await import('electron-audio-loopback');
      return getLoopbackAudioMediaStream();
    },
  },
  // Tags management
  tags: {
    create: (input: { name: string; color?: string }) => ipcRenderer.invoke('tags:create', input),
    list: () => ipcRenderer.invoke('tags:list'),
    get: (id: string) => ipcRenderer.invoke('tags:get', { id }),
    update: (input: { id: string; name?: string; color?: string | null }) =>
      ipcRenderer.invoke('tags:update', input),
    delete: (id: string) => ipcRenderer.invoke('tags:delete', { id }),
    reorder: (ids: string[]) => ipcRenderer.invoke('tags:reorder', { ids }),
    addToNote: (noteId: string, tagId: string) =>
      ipcRenderer.invoke('tags:addToNote', { noteId, tagId }),
    removeFromNote: (noteId: string, tagId: string) =>
      ipcRenderer.invoke('tags:removeFromNote', { noteId, tagId }),
    setNoteTags: (noteId: string, tagIds: string[]) =>
      ipcRenderer.invoke('tags:setNoteTags', { noteId, tagIds }),
    getByNote: (noteId: string) => ipcRenderer.invoke('tags:getByNote', { noteId }),
    getNotesByTag: (tagId: string) => ipcRenderer.invoke('tags:getNotesByTag', { tagId }),
  },
  onTagsChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('tags:changed', handler);
    return () => ipcRenderer.removeListener('tags:changed', handler);
  },
  onNoteTagsChanged: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('note-tags:changed', handler);
    return () => ipcRenderer.removeListener('note-tags:changed', handler);
  },
  // Sync operations
  sync: {
    getStatus: () => ipcRenderer.invoke('sync:getStatus'),
    performSync: () => ipcRenderer.invoke('sync:performSync'),
    push: () => ipcRenderer.invoke('sync:push'),
    pull: () => ipcRenderer.invoke('sync:pull'),
    resetRetryState: () => ipcRenderer.invoke('sync:resetRetryState'),
    getConflicts: () => ipcRenderer.invoke('sync:getConflicts'),
    clearConflicts: () => ipcRenderer.invoke('sync:clearConflicts'),
    getHealthStatus: () => ipcRenderer.invoke('sync:getHealthStatus'),
    getHealthMetrics: () => ipcRenderer.invoke('sync:getHealthMetrics'),
    getServerStats: () => ipcRenderer.invoke('sync:getServerStats'),
  },
  onSyncStart: (cb: () => void) => {
    const handler = () => cb();
    ipcRenderer.on('sync:start', handler);
    return () => ipcRenderer.removeListener('sync:start', handler);
  },
  onSyncComplete: (cb: (result: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, result: unknown) => cb(result);
    ipcRenderer.on('sync:complete', handler);
    return () => ipcRenderer.removeListener('sync:complete', handler);
  },
  onSyncError: (cb: (error: unknown) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, error: unknown) => cb(error);
    ipcRenderer.on('sync:error', handler);
    return () => ipcRenderer.removeListener('sync:error', handler);
  },
  // Security / Password Protection
  security: {
    getPasswordStatus: () => ipcRenderer.invoke('security:getPasswordStatus'),
    enablePassword: (input: { password: string; confirmPassword: string }) =>
      ipcRenderer.invoke('security:enablePassword', input),
    disablePassword: (input: { password: string }) =>
      ipcRenderer.invoke('security:disablePassword', input),
    verifyPassword: (input: { password: string; remember?: boolean }) =>
      ipcRenderer.invoke('security:verifyPassword', input),
    changePassword: (input: {
      currentPassword: string;
      newPassword: string;
      confirmPassword: string;
    }) => ipcRenderer.invoke('security:changePassword', input),
    lock: () => ipcRenderer.invoke('security:lock'),
    clearRemember: () => ipcRenderer.invoke('security:clearRemember'),
    exportRecoveryKey: () => ipcRenderer.invoke('security:exportRecoveryKey'),
    importRecoveryKey: (input: { recoveryKey: string }) =>
      ipcRenderer.invoke('security:importRecoveryKey', input),
    markRecoveryKeyShown: () => ipcRenderer.invoke('security:markRecoveryKeyShown'),
    resetPasswordWithRecoveryKey: (input: {
      recoveryKey: string;
      newPassword: string;
      confirmPassword: string;
    }) => ipcRenderer.invoke('security:resetPasswordWithRecoveryKey', input),
    onStatusChanged: (
      cb: (status: {
        enabled: boolean;
        locked: boolean;
        rememberActive: boolean;
        rememberUntil: string | null;
        recoveryKeyShown: boolean;
        passwordChangedAt: string | null;
      }) => void
    ) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        status: {
          enabled: boolean;
          locked: boolean;
          rememberActive: boolean;
          rememberUntil: string | null;
          recoveryKeyShown: boolean;
          passwordChangedAt: string | null;
        }
      ) => cb(status);
      ipcRenderer.on('security:statusChanged', handler);
      return () => ipcRenderer.removeListener('security:statusChanged', handler);
    },
  },
  // Diagnostics upload
  diagnostics: {
    upload: () => ipcRenderer.invoke('diagnostics:upload'),
  },
  // Note export functionality
  export: {
    note: (noteId: string, format: 'txt' | 'md' | 'docx' | 'rtf' | 'pdf') =>
      ipcRenderer.invoke('export:note', { noteId, format }),
  },
  // Component download functionality
  components: {
    checkAll: (): Promise<ComponentInfo[]> => ipcRenderer.invoke('components:checkAll'),
    download: (componentId: string): Promise<DownloadResult> =>
      ipcRenderer.invoke('components:download', componentId),
    downloadAll: (): Promise<{ success: boolean; results: DownloadResult[] }> =>
      ipcRenderer.invoke('components:downloadAll'),
    cancelDownload: (): Promise<void> => ipcRenderer.invoke('components:cancelDownload'),
    verify: (componentId: string): Promise<VerificationResult> =>
      ipcRenderer.invoke('components:verify', componentId),
    repair: (componentId: string): Promise<DownloadResult> =>
      ipcRenderer.invoke('components:repair', componentId),
    getInfo: (componentId: string): Promise<ComponentInfo> =>
      ipcRenderer.invoke('components:getInfo', componentId),
    areAllReady: (): Promise<boolean> => ipcRenderer.invoke('components:areAllReady'),
    getSetupStatus: (): Promise<SetupStatusEvent | null> =>
      ipcRenderer.invoke('components:getSetupStatus'),
    setupRetryComplete: (): Promise<void> => ipcRenderer.invoke('components:setupRetryComplete'),
    onStatusChanged: (cb: (info: ComponentInfo) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, info: ComponentInfo) => cb(info);
      ipcRenderer.on('components:status-changed', handler);
      return () => ipcRenderer.removeListener('components:status-changed', handler);
    },
    onDownloadProgress: (cb: (progress: DownloadProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: DownloadProgress) =>
        cb(progress);
      ipcRenderer.on('components:download-progress', handler);
      return () => ipcRenderer.removeListener('components:download-progress', handler);
    },
    onDownloadComplete: (cb: (componentId: string) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, componentId: string) => cb(componentId);
      ipcRenderer.on('components:download-complete', handler);
      return () => ipcRenderer.removeListener('components:download-complete', handler);
    },
    onDownloadError: (cb: (data: { componentId: string; error: string }) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        data: { componentId: string; error: string }
      ) => cb(data);
      ipcRenderer.on('components:download-error', handler);
      return () => ipcRenderer.removeListener('components:download-error', handler);
    },
    onAllReady: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('components:all-ready', handler);
      return () => ipcRenderer.removeListener('components:all-ready', handler);
    },
    onSetupStatus: (cb: (status: SetupStatusEvent) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: SetupStatusEvent) => cb(status);
      ipcRenderer.on('components:setup-status', handler);
      return () => ipcRenderer.removeListener('components:setup-status', handler);
    },
  },
  // Native macOS menu integration
  menu: {
    onNavigate: (cb: (route: string) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, route: string) => cb(route);
      ipcRenderer.on('menu:navigate', handler);
      return () => ipcRenderer.removeListener('menu:navigate', handler);
    },
    onOpenTranscriptions: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('menu:openTranscriptions', handler);
      return () => ipcRenderer.removeListener('menu:openTranscriptions', handler);
    },
    onExport: (cb: (format: string) => void) => {
      const handler = (_e: Electron.IpcRendererEvent, format: string) => cb(format);
      ipcRenderer.on('menu:export', handler);
      return () => ipcRenderer.removeListener('menu:export', handler);
    },
    onFontZoomIn: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('menu:fontZoomIn', handler);
      return () => ipcRenderer.removeListener('menu:fontZoomIn', handler);
    },
    onFontZoomOut: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('menu:fontZoomOut', handler);
      return () => ipcRenderer.removeListener('menu:fontZoomOut', handler);
    },
    onFontZoomReset: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('menu:fontZoomReset', handler);
      return () => ipcRenderer.removeListener('menu:fontZoomReset', handler);
    },
    onNewNote: (cb: () => void) => {
      const handler = () => cb();
      ipcRenderer.on('menu:newNote', handler);
      return () => ipcRenderer.removeListener('menu:newNote', handler);
    },
    updateState: (state: { noteId: string | null }) => ipcRenderer.send('menu:updateState', state),
  },
};

contextBridge.exposeInMainWorld('api', api);
export type { Api as PreloadApi };
