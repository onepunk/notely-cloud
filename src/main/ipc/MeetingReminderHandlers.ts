import { BrowserWindow, ipcMain } from 'electron';
import { z } from 'zod';

import type {
  MeetingReminderState,
  MeetingReminderTarget,
  MeetingReminderTriggerPayload,
  MeetingReminderRecordCommand,
  MeetingReminderRecordResponse,
} from '../../common/meetingReminder';
import { logger } from '../logger';
import { MeetingReminderManager } from '../services/MeetingReminderManager';
import { type IStorageService } from '../storage';

const SetEnabledSchema = z.object({
  enabled: z.boolean(),
});

const SetMuteSchema = z.object({
  muteUntil: z.number().finite().nonnegative().optional().nullable(),
});

const SnoozeSchema = z.object({
  eventKey: z.string().min(1),
  snoozeUntil: z.number().finite().min(0),
});

const ClearSnoozeSchema = z.object({
  eventKey: z.string().min(1),
});

const MeetingReminderTargetSchema = z.object({
  accountId: z.string().min(1),
  eventId: z.string().min(1),
  startTime: z.number().finite(),
  endTime: z.number().finite(),
  title: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  isAllDay: z.boolean(),
  rawPayload: z.unknown().optional(),
});

const StartRecordingSchema = z.object({
  payload: z.object({
    eventKey: z.string().min(1),
    reminderTime: z.number().finite(),
    snoozedUntil: z.number().finite().nullish(),
    event: MeetingReminderTargetSchema,
  }),
  force: z.boolean().optional(),
});

export interface MeetingReminderHandlersDependencies {
  mainWindow?: BrowserWindow | null;
  meetingReminderManager: MeetingReminderManager;
  storage: IStorageService;
  showReminderWindow?: (
    payload: MeetingReminderTriggerPayload,
    state: MeetingReminderState
  ) => Promise<void>;
  hideReminderWindow?: () => void;
}

/**
 * MeetingReminderHandlers exposes IPC endpoints and renderer broadcasts
 * for the meeting reminder workflow.
 */
export class MeetingReminderHandlers {
  private mainWindow: BrowserWindow | null;
  private readonly manager: MeetingReminderManager;
  private readonly storage: IStorageService;
  private readonly showReminderWindow?: (
    payload: MeetingReminderTriggerPayload,
    state: MeetingReminderState
  ) => Promise<void>;
  private readonly hideReminderWindow?: () => void;
  private boundOnReminderDue: (payload: MeetingReminderTriggerPayload) => void;
  private boundOnStateChanged: (state?: unknown) => void;

  constructor(private deps: MeetingReminderHandlersDependencies) {
    this.mainWindow = deps.mainWindow ?? null;
    this.manager = deps.meetingReminderManager;
    this.storage = deps.storage;
    this.showReminderWindow = deps.showReminderWindow;
    this.hideReminderWindow = deps.hideReminderWindow;

    this.boundOnReminderDue = this.handleReminderDue.bind(this);
    this.boundOnStateChanged = this.handleStateChanged;
  }

  register(): void {
    logger.debug('MeetingReminderHandlers: Registering IPC handlers');

    ipcMain.handle('meetingReminder:getState', this.handleGetState);
    ipcMain.handle('meetingReminder:setEnabled', this.handleSetEnabled);
    ipcMain.handle('meetingReminder:setMuteUntil', this.handleSetMuteUntil);
    ipcMain.handle('meetingReminder:clearMute', this.handleClearMute);
    ipcMain.handle('meetingReminder:snooze', this.handleSnooze);
    ipcMain.handle('meetingReminder:clearSnooze', this.handleClearSnooze);
    ipcMain.handle('meetingReminder:refresh', this.handleRefresh);
    ipcMain.handle('meetingReminder:startRecording', this.handleStartRecording);
    ipcMain.handle('meetingReminder:testTrigger', this.handleTestTrigger);
    ipcMain.handle('meetingReminder:dismiss', this.handleDismiss);

    this.manager.on('reminder-due', this.boundOnReminderDue);
    this.manager.on('state-changed', this.boundOnStateChanged);
    this.manager.on('schedule-updated', this.boundOnStateChanged);

    logger.debug('MeetingReminderHandlers: IPC handlers registered');
  }

  cleanup(): void {
    logger.debug('MeetingReminderHandlers: Cleaning up IPC handlers');

    ipcMain.removeHandler('meetingReminder:getState');
    ipcMain.removeHandler('meetingReminder:setEnabled');
    ipcMain.removeHandler('meetingReminder:setMuteUntil');
    ipcMain.removeHandler('meetingReminder:clearMute');
    ipcMain.removeHandler('meetingReminder:snooze');
    ipcMain.removeHandler('meetingReminder:clearSnooze');
    ipcMain.removeHandler('meetingReminder:refresh');
    ipcMain.removeHandler('meetingReminder:startRecording');
    ipcMain.removeHandler('meetingReminder:testTrigger');
    ipcMain.removeHandler('meetingReminder:dismiss');

    this.manager.off('reminder-due', this.boundOnReminderDue);
    this.manager.off('state-changed', this.boundOnStateChanged);
    this.manager.off('schedule-updated', this.boundOnStateChanged);
  }

  updateMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('meetingReminder:stateChanged', this.manager.getState());
    }
  }

  private handleReminderDue(payload: MeetingReminderTriggerPayload): void {
    logger.info('MeetingReminderHandlers: Broadcasting reminder due event', {
      eventKey: payload.eventKey,
      title: payload.event.title,
    });

    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    this.mainWindow.webContents.send('meetingReminder:reminderDue', payload);
  }

  private handleStateChanged = (_state?: unknown): void => {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      return;
    }

    this.mainWindow.webContents.send('meetingReminder:stateChanged', this.manager.getState());
  };

  private handleGetState = async (): Promise<MeetingReminderState> => {
    return this.manager.getState();
  };

  private handleSetEnabled = async (
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> => {
    const { enabled } = SetEnabledSchema.parse(input);
    await this.manager.setEnabled(enabled);
  };

  private handleSetMuteUntil = async (
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> => {
    const { muteUntil } = SetMuteSchema.parse(input);

    if (muteUntil === null || muteUntil === undefined) {
      await this.manager.setMuteUntil(null);
      return;
    }

    await this.manager.setMuteUntil(muteUntil);
  };

  private handleClearMute = async (): Promise<void> => {
    await this.manager.setMuteUntil(null);
  };

  private handleSnooze = async (
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> => {
    const { eventKey, snoozeUntil } = SnoozeSchema.parse(input);
    await this.manager.snooze(eventKey, snoozeUntil);
  };

  private handleClearSnooze = async (
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<void> => {
    const { eventKey } = ClearSnoozeSchema.parse(input);
    await this.manager.clearSnooze(eventKey);
  };

  private handleRefresh = async (): Promise<void> => {
    await this.manager.refreshSchedule();
  };

  private handleStartRecording = async (
    _event: Electron.IpcMainInvokeEvent,
    input: unknown
  ): Promise<MeetingReminderRecordResponse> => {
    const { payload, force } = StartRecordingSchema.parse(input);

    const meetingTitle =
      payload.event.title?.trim() && payload.event.title.trim().length > 0
        ? payload.event.title.trim()
        : 'Untitled meeting';

    const binderId = await this.resolveTargetBinderId();
    const hasActive = this.manager.hasActiveTranscriptionSession();

    if (hasActive && !force) {
      logger.info(
        'MeetingReminderHandlers: Active transcription detected; confirmation required before starting reminder recording',
        { eventKey: payload.eventKey }
      );
      return {
        status: 'needs-confirmation',
        reason: 'A transcription session is already in progress.',
      };
    }

    if (!this.mainWindow || this.mainWindow.isDestroyed()) {
      logger.error('MeetingReminderHandlers: Cannot start recording – main window unavailable');
      throw new Error('Main window unavailable for meeting recording');
    }

    const normalizedEvent: MeetingReminderTarget = {
      accountId: payload.event.accountId,
      eventId: payload.event.eventId,
      startTime: payload.event.startTime,
      endTime: payload.event.endTime,
      title: meetingTitle,
      description: payload.event.description ?? null,
      location: payload.event.location ?? null,
      isAllDay: payload.event.isAllDay,
      rawPayload: payload.event.rawPayload,
    };

    const command: MeetingReminderRecordCommand = {
      binderId,
      meetingTitle,
      eventKey: payload.eventKey,
      eventStartTime: payload.event.startTime,
      reminderTime: payload.reminderTime,
      shouldStopExisting: hasActive,
      event: normalizedEvent,
    };

    try {
      if (this.mainWindow.isMinimized()) {
        this.mainWindow.restore();
      }
      this.mainWindow.focus();
    } catch (error) {
      logger.warn('MeetingReminderHandlers: Failed to focus main window for meeting recording', {
        error: error instanceof Error ? error.message : error,
      });
    }

    logger.info('MeetingReminderHandlers: Dispatching record command to renderer', {
      eventKey: payload.eventKey,
      binderId,
      shouldStopExisting: command.shouldStopExisting,
    });

    this.mainWindow.webContents.send('meetingReminder:recordCommand', command);

    return {
      status: 'started',
      binderId,
    };
  };

  private handleTestTrigger = async (): Promise<void> => {
    logger.info('MeetingReminderHandlers: Manually triggering test reminder');

    if (!this.showReminderWindow) {
      logger.error('MeetingReminderHandlers: showReminderWindow callback not available');
      throw new Error('Test reminder trigger is not configured');
    }

    const testPayload: MeetingReminderTriggerPayload = {
      eventKey: 'test-event-' + Date.now(),
      reminderTime: Date.now(),
      snoozedUntil: null,
      hasActiveTranscription: false,
      event: {
        accountId: 'test-account',
        eventId: 'test-event-id',
        startTime: Date.now() + 60000, // 1 minute from now
        endTime: Date.now() + 3660000, // 1 hour and 1 minute from now
        title: 'Test Meeting',
        description: 'This is a test meeting reminder',
        location: null,
        isAllDay: false,
        rawPayload: null,
      },
    };

    const state = this.manager.getState();
    await this.showReminderWindow(testPayload, state);
  };

  private handleDismiss = async (): Promise<void> => {
    logger.info('MeetingReminderHandlers: Dismissing reminder window');

    if (this.hideReminderWindow) {
      this.hideReminderWindow();
    } else {
      logger.warn('MeetingReminderHandlers: hideReminderWindow callback not available');
    }

    await this.manager.refreshSchedule();
  };

  private async resolveTargetBinderId(): Promise<string> {
    try {
      const lastBinderId = await this.storage.settings.get('ui.lastBinderId');
      if (lastBinderId) {
        try {
          const exists = await this.storage.binders.exists(lastBinderId);
          if (exists) {
            return lastBinderId;
          }
          logger.debug('MeetingReminderHandlers: Last binder ID no longer valid, falling back', {
            lastBinderId,
          });
        } catch (error) {
          logger.warn('MeetingReminderHandlers: Failed to validate last binder ID', {
            lastBinderId,
            error: error instanceof Error ? error.message : error,
          });
        }
      }
    } catch (error) {
      logger.warn('MeetingReminderHandlers: Failed to read last binder ID from settings', {
        error: error instanceof Error ? error.message : error,
      });
    }

    try {
      return await this.storage.binders.getDefaultBinderId();
    } catch (error) {
      logger.error('MeetingReminderHandlers: Failed to resolve default binder ID', {
        error: error instanceof Error ? error.message : error,
      });
      throw new Error('Unable to resolve binder for meeting recording');
    }
  }
}
