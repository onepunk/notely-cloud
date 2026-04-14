import { Input, Popover, PopoverSurface, PopoverTrigger } from '@fluentui/react-components';
import { Add16Regular, Checkmark16Regular, Tag16Regular } from '@fluentui/react-icons';
import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { useTagsStore } from '../model/tags.store';
import type { Tag } from '../types';

import { TagChip } from './TagChip';
import styles from './TagPicker.module.css';

type TagPickerProps = {
  noteId: string;
  selectedTags: Tag[];
  onTagsChange: (tags: Tag[]) => void;
};

export const TagPicker: React.FC<TagPickerProps> = ({ noteId, selectedTags, onTagsChange }) => {
  const { t } = useTranslation();
  const { tags, load, create, addTagToNote, removeTagFromNote } = useTagsStore((s) => ({
    tags: s.tags,
    load: s.load,
    create: s.create,
    addTagToNote: s.addTagToNote,
    removeTagFromNote: s.removeTagFromNote,
  }));

  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');

  React.useEffect(() => {
    if (open) {
      load();
    }
  }, [open, load]);

  const selectedIds = React.useMemo(() => new Set(selectedTags.map((t) => t.id)), [selectedTags]);

  const filteredTags = React.useMemo(() => {
    if (!search.trim()) return tags;
    const query = search.toLowerCase().trim();
    return tags.filter((tag) => tag.name.toLowerCase().includes(query));
  }, [tags, search]);

  const canCreateNew = React.useMemo(() => {
    if (!search.trim()) return false;
    const query = search.toLowerCase().trim();
    return !tags.some((tag) => tag.name.toLowerCase() === query);
  }, [tags, search]);

  const handleTagClick = React.useCallback(
    async (tag: Tag) => {
      if (selectedIds.has(tag.id)) {
        // Remove tag
        await removeTagFromNote(noteId, tag.id);
        onTagsChange(selectedTags.filter((t) => t.id !== tag.id));
      } else {
        // Add tag
        await addTagToNote(noteId, tag.id);
        onTagsChange([...selectedTags, tag]);
      }
    },
    [noteId, selectedIds, selectedTags, addTagToNote, removeTagFromNote, onTagsChange]
  );

  const handleCreateTag = React.useCallback(async () => {
    if (!search.trim()) return;
    const tagId = await create({ name: search.trim() });
    await addTagToNote(noteId, tagId);
    // Reload tags to get the new tag with full data
    await load();
    const newTag = useTagsStore.getState().tags.find((t) => t.id === tagId);
    if (newTag) {
      onTagsChange([...selectedTags, newTag]);
    }
    setSearch('');
  }, [search, noteId, create, addTagToNote, load, selectedTags, onTagsChange]);

  const handleRemoveTag = React.useCallback(
    async (tag: Tag) => {
      await removeTagFromNote(noteId, tag.id);
      onTagsChange(selectedTags.filter((t) => t.id !== tag.id));
    },
    [noteId, selectedTags, removeTagFromNote, onTagsChange]
  );

  return (
    <div className={styles.container}>
      {selectedTags.length > 0 && (
        <div className={styles['selected-tags']}>
          {selectedTags.map((tag) => (
            <TagChip key={tag.id} tag={tag} showRemove onRemove={() => handleRemoveTag(tag)} />
          ))}
        </div>
      )}

      <Popover open={open} onOpenChange={(_, data) => setOpen(data.open)} positioning="below-start">
        <PopoverTrigger disableButtonEnhancement>
          <button type="button" className={styles['trigger-button']}>
            <Tag16Regular />
            <span>{t('tags.addTag')}</span>
          </button>
        </PopoverTrigger>
        <PopoverSurface className={styles['popover-surface']}>
          <div className={styles['search-input']}>
            <Input
              placeholder={t('tags.searchOrCreate')}
              value={search}
              onChange={(_, data) => setSearch(data.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && canCreateNew) {
                  event.preventDefault();
                  handleCreateTag();
                }
              }}
              autoFocus
            />
          </div>

          {filteredTags.length > 0 ? (
            <ul className={styles['tag-list']}>
              {filteredTags.map((tag) => {
                const isSelected = selectedIds.has(tag.id);
                return (
                  <li key={tag.id}>
                    <button
                      type="button"
                      className={`${styles['tag-option']} ${isSelected ? styles['tag-option-selected'] : ''}`}
                      onClick={() => handleTagClick(tag)}
                    >
                      <span
                        className={styles['tag-option-color']}
                        style={{ backgroundColor: tag.color || 'var(--text-tertiary)' }}
                      />
                      <span className={styles['tag-option-name']}>{tag.name}</span>
                      {isSelected && <Checkmark16Regular className={styles['tag-option-check']} />}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : !canCreateNew ? (
            <div className={styles['empty-message']}>
              {t('tags.noTagsFound')}
            </div>
          ) : null}

          {canCreateNew && (
            <button type="button" className={styles['create-option']} onClick={handleCreateTag}>
              <Add16Regular />
              <span>
                {t('tags.createTag')} &quot;{search.trim()}&quot;
              </span>
            </button>
          )}
        </PopoverSurface>
      </Popover>
    </div>
  );
};
