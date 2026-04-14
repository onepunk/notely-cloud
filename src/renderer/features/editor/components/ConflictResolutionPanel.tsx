import { Button, Card, CardHeader, Tab, TabList, Text, Divider } from '@fluentui/react-components';
import {
  Warning24Regular,
  ArrowLeft24Regular,
  Checkmark24Regular,
  Dismiss24Regular,
  Copy24Regular,
} from '@fluentui/react-icons';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { reportError } from '@shared/error';

import styles from './ConflictResolutionPanel.module.css';

type ConflictNote = {
  id: string;
  title: string;
  binder_id: string;
  created_at: number;
  updated_at: number;
};

type NoteWithConflictMeta = {
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
  content: {
    lexicalJson: string;
    plainText: string;
  };
  conflictCopies: ConflictNote[];
};

type Props = {
  noteId: string;
  onResolved?: () => void;
};

export const ConflictResolutionPanel: React.FC<Props> = ({ noteId, onResolved }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [loading, setLoading] = React.useState(true);
  const [noteData, setNoteData] = React.useState<NoteWithConflictMeta | null>(null);
  const [selectedConflictId, setSelectedConflictId] = React.useState<string | null>(null);
  const [conflictContent, setConflictContent] = React.useState<{
    lexicalJson: string;
    plainText: string;
  } | null>(null);
  const [resolving, setResolving] = React.useState(false);

  // Load note data with conflict metadata
  const loadNoteData = React.useCallback(async () => {
    setLoading(true);
    try {
      const data = await window.api.storage.getNoteWithConflictMeta(noteId);
      setNoteData(data);

      // Auto-select first conflict if available
      if (data.conflictCopies.length > 0 && !selectedConflictId) {
        setSelectedConflictId(data.conflictCopies[0].id);
      }
    } catch (error) {
      reportError(error, 'E4012', { noteId });
    } finally {
      setLoading(false);
    }
  }, [noteId, selectedConflictId, t]);

  // Load selected conflict content
  const loadConflictContent = React.useCallback(async () => {
    if (!selectedConflictId) {
      setConflictContent(null);
      return;
    }

    try {
      const data = await window.api.storage.getNote(selectedConflictId);
      setConflictContent(data.content);
    } catch (error) {
      console.error('Failed to load conflict content', error);
    }
  }, [selectedConflictId]);

  React.useEffect(() => {
    loadNoteData();
  }, [loadNoteData]);

  React.useEffect(() => {
    loadConflictContent();
  }, [loadConflictContent]);

  // Use conflict version (replace canonical with conflict content)
  const handleUseConflictVersion = async () => {
    if (!selectedConflictId || !noteId) return;

    setResolving(true);
    try {
      await window.api.storage.resolveConflictUseConflictVersion(selectedConflictId, noteId);
      toast.success(t('conflicts.resolvedUseConflict'));
      onResolved?.();
      // Reload data
      await loadNoteData();
      // Trigger refresh
      window.dispatchEvent(new Event('notes:changed'));
    } catch (error) {
      reportError(error, 'E4013', { noteId, conflictId: selectedConflictId });
    } finally {
      setResolving(false);
    }
  };

  // Keep canonical (delete conflict copy)
  const handleKeepCanonical = async () => {
    if (!selectedConflictId) return;

    setResolving(true);
    try {
      await window.api.storage.resolveConflictKeepCanonical(selectedConflictId);
      toast.success(t('conflicts.resolvedKeepCanonical'));
      onResolved?.();
      // Reload data
      await loadNoteData();
      // Trigger refresh
      window.dispatchEvent(new Event('notes:changed'));
    } catch (error) {
      reportError(error, 'E4013', { conflictId: selectedConflictId });
    } finally {
      setResolving(false);
    }
  };

  // Copy conflict content to clipboard
  const handleCopyConflictContent = async () => {
    if (!conflictContent?.plainText) return;

    try {
      await navigator.clipboard.writeText(conflictContent.plainText);
      toast.success(t('common.copied'));
    } catch (error) {
      reportError(error, 'E8006');
    }
  };

  // Navigate back
  const handleBack = () => {
    navigate(-1);
  };

  if (loading) {
    return (
      <div className={styles.root}>
        <div className={styles.loading}>{t('common.loading')}</div>
      </div>
    );
  }

  if (!noteData) {
    return (
      <div className={styles.root}>
        <div className={styles.error}>{t('conflicts.notFound')}</div>
      </div>
    );
  }

  const { meta, content, conflictCopies } = noteData;

  // No conflicts - should not happen if called correctly
  if (conflictCopies.length === 0) {
    return (
      <div className={styles.root}>
        <div className={styles.noConflicts}>
          <Checkmark24Regular />
          <Text>{t('conflicts.noConflicts')}</Text>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <Button
          appearance="subtle"
          icon={<ArrowLeft24Regular />}
          onClick={handleBack}
          aria-label={t('common.back')}
        />
        <div className={styles.headerTitle}>
          <Warning24Regular className={styles.warningIcon} />
          <Text size={500} weight="semibold">
            {t('conflicts.resolveTitle')}
          </Text>
        </div>
        <div className={styles.headerSpacer} />
      </div>

      <div className={styles.conflictInfo}>
        <Text size={300} className={styles.conflictDescription}>
          {t('conflicts.description')}
        </Text>
      </div>

      <div className={styles.conflictList}>
        <Text size={300} weight="semibold" className={styles.sectionTitle}>
          {t('conflicts.conflictVersions', { count: conflictCopies.length })}
        </Text>
        <TabList
          selectedValue={selectedConflictId || ''}
          onTabSelect={(_, data) => setSelectedConflictId(data.value as string)}
          className={styles.tabs}
        >
          {conflictCopies.map((conflict, index) => (
            <Tab key={conflict.id} value={conflict.id}>
              {t('conflicts.version')} #{index + 1}
            </Tab>
          ))}
        </TabList>
      </div>

      <div className={styles.contentComparison}>
        {/* Current (canonical) version */}
        <Card className={styles.contentCard}>
          <CardHeader
            header={
              <Text weight="semibold" className={styles.cardTitle}>
                {t('conflicts.currentVersion')}
              </Text>
            }
            description={
              <Text size={200} className={styles.cardDescription}>
                {meta.title || t('notes.untitled')}
              </Text>
            }
          />
          <Divider />
          <div className={styles.contentPreview}>
            <pre className={styles.contentText}>{content.plainText || t('notes.empty')}</pre>
          </div>
        </Card>

        {/* Conflict version */}
        <Card className={`${styles.contentCard} ${styles.conflictCard}`}>
          <CardHeader
            header={
              <Text weight="semibold" className={styles.cardTitle}>
                {t('conflicts.conflictVersion')}
              </Text>
            }
            description={
              <Text size={200} className={styles.cardDescription}>
                {conflictCopies.find((c) => c.id === selectedConflictId)?.title ||
                  t('notes.untitled')}
              </Text>
            }
            action={
              <Button
                appearance="subtle"
                icon={<Copy24Regular />}
                onClick={handleCopyConflictContent}
                title={t('common.copy')}
                size="small"
              />
            }
          />
          <Divider />
          <div className={styles.contentPreview}>
            <pre className={styles.contentText}>
              {conflictContent?.plainText || t('notes.empty')}
            </pre>
          </div>
        </Card>
      </div>

      <div className={styles.actions}>
        <Button
          appearance="secondary"
          icon={<Checkmark24Regular />}
          onClick={handleKeepCanonical}
          disabled={resolving}
        >
          {t('conflicts.keepCurrent')}
        </Button>
        <Button
          appearance="primary"
          icon={<Checkmark24Regular />}
          onClick={handleUseConflictVersion}
          disabled={resolving}
        >
          {t('conflicts.useConflict')}
        </Button>
        <Button
          appearance="subtle"
          icon={<Dismiss24Regular />}
          onClick={handleBack}
          disabled={resolving}
        >
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
};
