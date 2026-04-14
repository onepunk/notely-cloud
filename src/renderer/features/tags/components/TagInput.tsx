import * as React from 'react';
import { useTranslation } from 'react-i18next';

import { useTagsStore } from '../model/tags.store';
import type { Tag } from '../types';

import { TagChip } from './TagChip';
import styles from './TagInput.module.css';

type TagInputProps = {
  noteId: string;
  selectedTags: Tag[];
  onTagsChange: (tags: Tag[]) => void;
};

export const TagInput: React.FC<TagInputProps> = ({ noteId, selectedTags, onTagsChange }) => {
  const { t } = useTranslation();
  const { tags, load, create, addTagToNote, removeTagFromNote } = useTagsStore((s) => ({
    tags: s.tags,
    load: s.load,
    create: s.create,
    addTagToNote: s.addTagToNote,
    removeTagFromNote: s.removeTagFromNote,
  }));

  const [inputValue, setInputValue] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    load();
  }, [load]);

  const handleInputChange = React.useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);
  }, []);

  const handleCreateOrAddTag = React.useCallback(async () => {
    const tagName = inputValue.trim();
    if (!tagName) return;

    // Check if tag already exists (case-insensitive)
    const existingTag = tags.find((t) => t.name.toLowerCase() === tagName.toLowerCase());

    if (existingTag) {
      // Check if already added to note
      const alreadyAdded = selectedTags.some((t) => t.id === existingTag.id);
      if (!alreadyAdded) {
        await addTagToNote(noteId, existingTag.id);
        onTagsChange([...selectedTags, existingTag]);
      }
    } else {
      // Create new tag
      const tagId = await create({ name: tagName });
      await addTagToNote(noteId, tagId);
      await load();
      const newTag = useTagsStore.getState().tags.find((t) => t.id === tagId);
      if (newTag) {
        onTagsChange([...selectedTags, newTag]);
      }
    }

    setInputValue('');
    inputRef.current?.focus();
  }, [inputValue, tags, noteId, create, addTagToNote, load, selectedTags, onTagsChange]);

  const handleRemoveTag = React.useCallback(
    async (tag: Tag) => {
      await removeTagFromNote(noteId, tag.id);
      onTagsChange(selectedTags.filter((t) => t.id !== tag.id));
    },
    [noteId, selectedTags, removeTagFromNote, onTagsChange]
  );

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleCreateOrAddTag();
      } else if (e.key === 'Backspace' && !inputValue && selectedTags.length > 0) {
        const lastTag = selectedTags[selectedTags.length - 1];
        handleRemoveTag(lastTag);
      }
    },
    [handleCreateOrAddTag, inputValue, selectedTags, handleRemoveTag]
  );

  const handleContainerClick = React.useCallback(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className={styles.wrapper}>
      <div className={styles.container} onClick={handleContainerClick}>
        {selectedTags.map((tag) => (
          <TagChip key={tag.id} tag={tag} showRemove onRemove={() => handleRemoveTag(tag)} />
        ))}
        <input
          ref={inputRef}
          type="text"
          className={styles.input}
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          placeholder={selectedTags.length === 0 ? t('tags.addTagPlaceholder') : ''}
          aria-label={t('tags.addTag')}
        />
      </div>
    </div>
  );
};
