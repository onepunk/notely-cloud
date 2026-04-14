/**
 * Main application services
 *
 * These services handle application-level concerns that are separate from
 * storage operations (which are in ./storage/services/).
 */

export { AuthValidationService, type AuthValidationResult } from './AuthValidationService';
export {
  MeetingReminderManager,
  type MeetingReminderManagerDependencies,
  type MeetingReminderManagerEvents,
} from './MeetingReminderManager';
export type {
  MeetingReminderTarget,
  MeetingReminderTriggerPayload,
  MeetingReminderState,
} from '../../common/meetingReminder';
export { LicenseService, type LicensePayload } from './license/LicenseService';
export { HeartbeatService } from './heartbeat/HeartbeatService';
export { UpgradePollingService } from './license/UpgradePollingService';
export { ComponentManager, type ComponentManagerEvents } from './components';
