export type MeetingReminderSnoozeMap = Record<string, number>;

export type MeetingReminderTarget = {
  accountId: string;
  eventId: string;
  startTime: number;
  endTime: number;
  title: string;
  description?: string | null;
  location?: string | null;
  isAllDay: boolean;
  rawPayload: unknown;
};

export type MeetingReminderTriggerPayload = {
  reminderTime: number;
  eventKey: string;
  event: MeetingReminderTarget;
  snoozedUntil?: number | null;
  hasActiveTranscription: boolean;
};

export type MeetingReminderState = {
  enabled: boolean;
  muteUntil: number | null;
  snoozes: MeetingReminderSnoozeMap;
  scheduledCount: number;
};

export type MeetingReminderRecordCommand = {
  binderId: string;
  meetingTitle: string;
  eventKey: string;
  eventStartTime: number;
  reminderTime: number;
  shouldStopExisting: boolean;
  event: MeetingReminderTarget;
};

export type MeetingReminderRecordResponse =
  | {
      status: 'needs-confirmation';
      reason?: string;
    }
  | {
      status: 'started';
      binderId: string;
    };
