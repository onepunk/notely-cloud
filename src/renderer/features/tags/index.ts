/**
 * Tags feature exports
 */

// Types
export type { Tag, NoteTag, CreateTagInput, UpdateTagInput } from './types';

// Store
export { useTagsStore } from './model/tags.store';

// Components
export { TagList } from './components/TagList';
export { TagChip } from './components/TagChip';
export { TagPicker } from './components/TagPicker';
export { TagInput } from './components/TagInput';
