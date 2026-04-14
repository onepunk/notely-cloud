import {
  Badge,
  Button,
  Caption1,
  Dropdown,
  Field,
  Input,
  Option,
  Switch,
  Textarea,
} from '@fluentui/react-components';
import * as React from 'react';

import {
  SettingsCard,
  SettingsInlineActions,
  SettingsSection,
  SettingsTabLayout,
} from './SettingsTabLayout';
import styles from './SettingsTemplate.module.css';

const timezoneOptions = [
  { value: 'system', label: 'Follow system preference' },
  { value: 'utc', label: 'Coordinated Universal Time (UTC)' },
  { value: 'pst', label: 'Pacific Time (PT)' },
  { value: 'est', label: 'Eastern Time (ET)' },
] as const;

const retentionOptions = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '180', label: '180 days' },
  { value: '365', label: '12 months' },
] as const;

const auditLogEntries = [
  {
    id: '1',
    title: 'Updated workspace theme',
    actor: 'Alex Doe',
    relativeTime: '12 minutes ago',
  },
  {
    id: '2',
    title: 'Enabled advanced recording features',
    actor: 'Casey Smith',
    relativeTime: '2 hours ago',
  },
  {
    id: '3',
    title: 'Adjusted retention policy to 90 days',
    actor: 'Alex Doe',
    relativeTime: 'Yesterday at 4:22 PM',
  },
] as const;

const notificationChannels = [
  {
    id: 'email',
    title: 'Email Summary',
    description: 'Daily digest of highlights and tasks sent at 8:00 AM.',
  },
  {
    id: 'desktop',
    title: 'Desktop Notifications',
    description: 'Real-time alerts for important activity while the app is active.',
  },
  {
    id: 'slack',
    title: 'Slack Integration',
    description: 'Send action items to the #notely channel with smart batching.',
  },
] as const;

type TimezoneOption = (typeof timezoneOptions)[number]['value'];
type RetentionOption = (typeof retentionOptions)[number]['value'];

export const SettingsTemplate: React.FC = () => {
  const [timezone, setTimezone] = React.useState<TimezoneOption>('system');
  const [retention, setRetention] = React.useState<RetentionOption>('90');
  const [dailyDigest, setDailyDigest] = React.useState(true);
  const [weeklyDigest, setWeeklyDigest] = React.useState(false);
  const [autoArchive, setAutoArchive] = React.useState(true);
  const [channelState, setChannelState] = React.useState<Record<string, boolean>>({
    email: true,
    desktop: true,
    slack: false,
  });

  const handleChannelToggle =
    (channelId: string) =>
    (_event: React.ChangeEvent<HTMLInputElement>, data: { checked: boolean }) => {
      setChannelState((prev) => ({ ...prev, [channelId]: data.checked }));
    };

  return (
    <SettingsTabLayout
      title="Template layout"
      description="Use this template as a reference for building new settings tabs. It demonstrates consistent spacing, typography, and reusable sections."
      actions={
        <>
          <Button size="small" appearance="secondary">
            Reset changes
          </Button>
          <Button size="small" appearance="primary">
            Save template
          </Button>
        </>
      }
      meta={<Caption1>Last reviewed 2 hours ago by the design system team</Caption1>}
    >
      <SettingsSection
        title="Quick overview"
        description="High-level cards for status, activity, and helpful shortcuts. Pair call-to-actions with succinct context."
        action={
          <Button size="small" appearance="transparent">
            Refresh insights
          </Button>
        }
      >
        <div className={styles.metricsGrid}>
          <SettingsCard
            title="Workspace status"
            description="Connectivity with Notely Cloud and synced devices."
            footer="Synced with 4 devices · last connection 12 minutes ago"
          >
            <div className={styles.metricStatus}>
              <Badge appearance="filled" color="success">
                Connected
              </Badge>
              <span className={styles.metricDetail}>Latency: 42 ms</span>
            </div>
            <SettingsInlineActions>
              <Button size="small" appearance="secondary">
                View sync logs
              </Button>
              <Button size="small" appearance="transparent">
                Troubleshoot
              </Button>
            </SettingsInlineActions>
          </SettingsCard>

          <SettingsCard
            title="Usage snapshot"
            description="Useful for exposing capacity or billing signals while staying compact."
            footer="Storage resets on May 1, 2025"
          >
            <div className={styles.metricValue}>78%</div>
            <span className={styles.metricDetail}>1.6 GB of 2 GB plan used</span>
            <SettingsInlineActions>
              <Button size="small" appearance="transparent">
                Upgrade plan
              </Button>
            </SettingsInlineActions>
          </SettingsCard>

          <SettingsCard
            title="Recent activity"
            description="Surface the last few changes or critical audit notes."
          >
            <ul className={styles.auditList}>
              {auditLogEntries.map((entry) => (
                <li key={entry.id} className={styles.auditItem}>
                  <span className={styles.auditTitle}>{entry.title}</span>
                  <span className={styles.auditMeta}>
                    {entry.actor} · {entry.relativeTime}
                  </span>
                </li>
              ))}
            </ul>
          </SettingsCard>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Workspace preferences"
        description="Group configuration inputs into digestible cards. Align form controls to a responsive grid for predictable scanning."
      >
        <div className={styles.formGrid}>
          <SettingsCard
            title="Identity"
            description="Surface lightweight profile traits so users can confirm context."
          >
            <Field label="Workspace name" required>
              <Input placeholder="Notely Research Team" />
            </Field>
            <Field label="Tagline" hint="Appears on your shared meeting summaries.">
              <Textarea
                resize="vertical"
                placeholder="Helping everyone arrive prepared with clarity and context."
              />
            </Field>
          </SettingsCard>

          <SettingsCard
            title="Regional defaults"
            description="Keep pickers aligned to the same width for a calmer form layout."
          >
            <Field label="Primary timezone">
              <Dropdown
                selectedOptions={[timezone]}
                onOptionSelect={(_event, data) =>
                  setTimezone((data.optionValue as TimezoneOption) ?? 'system')
                }
              >
                {timezoneOptions.map((option) => (
                  <Option key={option.value} value={option.value}>
                    {option.label}
                  </Option>
                ))}
              </Dropdown>
            </Field>
            <Field label="Data retention">
              <Dropdown
                selectedOptions={[retention]}
                onOptionSelect={(_event, data) =>
                  setRetention((data.optionValue as RetentionOption) ?? '90')
                }
              >
                {retentionOptions.map((option) => (
                  <Option key={option.value} value={option.value}>
                    {option.label}
                  </Option>
                ))}
              </Dropdown>
            </Field>
          </SettingsCard>

          <SettingsCard
            title="Automatic organisation"
            description="Switch groups keep related toggles vertically aligned for easy scanning."
          >
            <Switch
              label="Auto-archive completed projects"
              checked={autoArchive}
              onChange={(_event, data) => setAutoArchive(!!data.checked)}
            />
            <Switch
              label="Send daily digest"
              checked={dailyDigest}
              onChange={(_event, data) => setDailyDigest(!!data.checked)}
            />
            <Switch
              label="Send weekly summary"
              checked={weeklyDigest}
              onChange={(_event, data) => setWeeklyDigest(!!data.checked)}
            />
          </SettingsCard>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Notification channels"
        description="List-based layout for repeatable items. Each row keeps title, description, and control aligned."
        footer="Tip: use this footer slot for helper copy, legal notes, or destructive confirmation."
      >
        <div className={styles.channelList}>
          {notificationChannels.map((channel) => (
            <div key={channel.id} className={styles.channelRow}>
              <div className={styles.channelDetails}>
                <span className={styles.channelTitle}>{channel.title}</span>
                <span className={styles.channelDescription}>{channel.description}</span>
              </div>
              <Switch
                checked={channelState[channel.id]}
                onChange={handleChannelToggle(channel.id)}
                aria-label={`Toggle ${channel.title}`}
              />
            </div>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Danger zone"
        description="A specialised card variant reinforces caution while keeping content aligned with the rest of the layout."
      >
        <SettingsCard
          title="Delete workspace"
          description="Removing this workspace will permanently delete meetings, tasks, and shared notes for all members."
          tone="danger"
          footer="This action cannot be undone."
          actions={
            <SettingsInlineActions>
              <Button appearance="transparent" size="small">
                Export data
              </Button>
            </SettingsInlineActions>
          }
        >
          <div className={styles.dangerRow}>
            <span>
              Confirm you have downloaded any critical information before proceeding with the
              deletion workflow.
            </span>
            <Button appearance="primary" size="small" className={styles.dangerButton}>
              Delete workspace
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>
    </SettingsTabLayout>
  );
};
