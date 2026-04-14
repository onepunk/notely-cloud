import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Button,
  Input,
  Menu,
  MenuList,
  MenuItem,
  MenuPopover,
  MenuTrigger,
  Dialog,
  DialogSurface,
  DialogBody,
  DialogTitle,
  DialogContent,
  DialogActions,
} from '@fluentui/react-components';
import {
  Add20Regular,
  ChevronDown20Regular,
  ChevronRight20Regular,
  Tag20Regular,
} from '@fluentui/react-icons';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { useSettingsStore } from '../../../shared/state/settings.store';
import { ColorPickerDialog } from '../../binders/components/ColorPickerDialog';
import { useTagsStore } from '../model/tags.store';
import type { Tag } from '../types';

import styles from './TagList.module.css';

const TAGS_COLLAPSED_KEY = 'ui.tagList.collapsed';

const createVirtualElement = (x: number, y: number): Element =>
  ({
    getBoundingClientRect: () =>
      ({
        x,
        y,
        top: y,
        left: x,
        bottom: y,
        right: x,
        width: 0,
        height: 0,
        toJSON: () => ({ x, y, top: y, left: x, bottom: y, right: x, width: 0, height: 0 }),
      }) as DOMRect,
  }) as Element;

type SortableTagItemProps = {
  tag: Tag;
  active: boolean;
  onClick: () => void;
  onContextMenu: (id: string, position: { x: number; y: number }) => void;
  editing: boolean;
  editValue: string;
  onEditChange: (value: string) => void;
  onEditCommit: () => void;
  onEditCancel: () => void;
  editInputRef: React.RefObject<HTMLInputElement>;
};

const SortableTagItem: React.FC<SortableTagItemProps> = ({
  tag,
  active,
  onClick,
  onContextMenu,
  editing,
  editValue,
  onEditChange,
  onEditCommit,
  onEditCancel,
  editInputRef,
}) => {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: tag.id });
  const style: React.CSSProperties = { transform: CSS.Transform.toString(transform), transition };

  return (
    <li className={styles.li} ref={setNodeRef} style={style}>
      <button
        type="button"
        className={`${styles['item-button']} ${active ? styles['item-button-active'] : ''}`}
        onClick={editing ? undefined : onClick}
        onContextMenu={(event) => {
          event.preventDefault();
          onContextMenu(tag.id, { x: event.clientX, y: event.clientY });
        }}
        {...attributes}
        {...(editing ? {} : listeners)}
        tabIndex={editing ? -1 : 0}
      >
        <div className={styles['item-content']}>
          <span
            className={styles['color-dot']}
            style={{ backgroundColor: tag.color || 'var(--text-tertiary)' }}
          />
          {editing ? (
            <Input
              ref={editInputRef}
              className={styles['rename-input']}
              value={editValue}
              onChange={(_, data) => onEditChange(data.value)}
              onBlur={onEditCancel}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  onEditCommit();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  onEditCancel();
                }
              }}
            />
          ) : (
            <span className={styles['tag-name']}>{tag.name}</span>
          )}
        </div>
        {tag.noteCount !== undefined && tag.noteCount > 0 && !editing && (
          <span className={styles['note-count']}>{tag.noteCount}</span>
        )}
      </button>
    </li>
  );
};

type TagListProps = {
  onTagClick?: (tagId: string) => void;
};

export const TagList: React.FC<TagListProps> = ({ onTagClick }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();

  const {
    tags,
    loading,
    load,
    create,
    rename,
    setColor,
    delete: deleteTag,
    reorder,
  } = useTagsStore((s) => ({
    tags: s.tags,
    loading: s.loading,
    load: s.load,
    create: s.create,
    rename: s.rename,
    setColor: s.setColor,
    delete: s.delete,
    reorder: s.reorder,
  }));

  // Collapse state persisted in settings
  const isCollapsed = useSettingsStore((state) => state.getBoolean(TAGS_COLLAPSED_KEY, false));
  const setBoolean = useSettingsStore((state) => state.setBoolean);

  const toggleCollapsed = React.useCallback(() => {
    void setBoolean(TAGS_COLLAPSED_KEY, !isCollapsed);
  }, [isCollapsed, setBoolean]);

  const [adding, setAdding] = React.useState(false);
  const [newTagName, setNewTagName] = React.useState('');
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const renameInputRef = React.useRef<HTMLInputElement | null>(null);
  const [contextMenu, setContextMenu] = React.useState<{
    id: string;
    position: { x: number; y: number };
  } | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = React.useState<string | null>(null);
  const [colorPickerOpen, setColorPickerOpen] = React.useState(false);
  const [colorPickerTagId, setColorPickerTagId] = React.useState<string | null>(null);
  const [colorPickerInitial, setColorPickerInitial] = React.useState<string | null>(null);

  // Setup sync listeners
  React.useEffect(() => {
    const cleanup = useTagsStore.getState().setupSyncListeners();
    return cleanup;
  }, []);

  // Load tags on mount
  React.useEffect(() => {
    load();
  }, [load]);

  // Focus rename input when renaming starts
  React.useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  // Get active tag from URL
  const activeTagId = React.useMemo(() => {
    const search = new URLSearchParams(location.search);
    if (search.get('view') === 'tag') {
      return search.get('tagId');
    }
    return null;
  }, [location.search]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = tags.findIndex((t) => t.id === active.id);
    const newIndex = tags.findIndex((t) => t.id === over.id);
    const reordered = arrayMove(tags, oldIndex, newIndex);
    await reorder(reordered.map((t) => t.id));
  };

  const handleTagClick = React.useCallback(
    (tagId: string) => {
      if (onTagClick) {
        onTagClick(tagId);
      } else {
        navigate(`/?view=tag&tagId=${tagId}`);
      }
    },
    [navigate, onTagClick]
  );

  const handleAddTag = async () => {
    if (!newTagName.trim()) return;
    await create({ name: newTagName.trim() });
    setNewTagName('');
    setAdding(false);
  };

  const handleOpenContextMenu = React.useCallback(
    (id: string, position: { x: number; y: number }) => {
      setContextMenu({ id, position });
    },
    []
  );

  const handleMenuAction = React.useCallback(
    (action: string) => {
      const [actionType, id] = action.split(':');
      switch (actionType) {
        case 'rename': {
          const tag = tags.find((t) => t.id === id);
          if (tag) {
            setRenameValue(tag.name);
            setRenamingId(id);
          }
          break;
        }
        case 'color': {
          const tag = tags.find((t) => t.id === id);
          if (tag) {
            setColorPickerTagId(id);
            setColorPickerInitial(tag.color);
            setColorPickerOpen(true);
          }
          break;
        }
        case 'delete':
          setDeleteConfirmId(id);
          break;
      }
      setContextMenu(null);
    },
    [tags]
  );

  const handleRenameCommit = React.useCallback(async () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingId(null);
      setRenameValue('');
      return;
    }
    const currentTag = tags.find((t) => t.id === renamingId);
    if (currentTag && currentTag.name !== trimmed) {
      await rename(renamingId, trimmed);
    }
    setRenamingId(null);
    setRenameValue('');
  }, [tags, rename, renamingId, renameValue]);

  const handleRenameCancel = React.useCallback(() => {
    setRenamingId(null);
    setRenameValue('');
  }, []);

  const handleDeleteConfirm = React.useCallback(async () => {
    if (!deleteConfirmId) return;
    await deleteTag(deleteConfirmId);
    setDeleteConfirmId(null);
    // If deleted tag was active, navigate away
    if (activeTagId === deleteConfirmId) {
      navigate('/');
    }
  }, [deleteConfirmId, deleteTag, activeTagId, navigate]);

  const handleColorSelect = React.useCallback(
    async (hex: string) => {
      if (!colorPickerTagId) return;
      await setColor(colorPickerTagId, hex);
      setColorPickerOpen(false);
      setColorPickerTagId(null);
      setColorPickerInitial(null);
    },
    [colorPickerTagId, setColor]
  );

  const contextMenuTarget = React.useMemo(() => {
    if (!contextMenu) return undefined;
    return createVirtualElement(contextMenu.position.x, contextMenu.position.y);
  }, [contextMenu]);

  if (loading && tags.length === 0) {
    return null;
  }

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles['header-toggle']}
          onClick={toggleCollapsed}
          aria-label={isCollapsed ? t('common.expand') : t('common.collapse')}
        >
          {isCollapsed ? <ChevronRight20Regular /> : <ChevronDown20Regular />}
          <span className={styles['header-label']}>
            {t('sidebar.tags')}
          </span>
        </button>
        {!isCollapsed && (
          <Button
            appearance="subtle"
            size="small"
            icon={<Add20Regular />}
            onClick={() => setAdding((v) => !v)}
            aria-label={adding ? t('common.close') : t('sidebar.addTag')}
          />
        )}
      </div>

      {!isCollapsed && (
        <>
          {adding && (
            <div className={styles['add-row']}>
              <Input
                className={styles['add-input']}
                value={newTagName}
                onChange={(_, data) => setNewTagName(data.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    handleAddTag();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setNewTagName('');
                    setAdding(false);
                  }
                }}
                placeholder={t('tags.newTagPlaceholder')}
                autoFocus
              />
            </div>
          )}

          {tags.length === 0 ? (
            <div className={styles.empty}>
              <Tag20Regular />
              <span>{t('sidebar.noTags')}</span>
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={tags.map((t) => t.id)} strategy={verticalListSortingStrategy}>
                <ul className={styles.list}>
                  {tags.map((tag) => (
                    <SortableTagItem
                      key={tag.id}
                      tag={tag}
                      active={activeTagId === tag.id}
                      onClick={() => handleTagClick(tag.id)}
                      onContextMenu={handleOpenContextMenu}
                      editing={renamingId === tag.id}
                      editValue={renamingId === tag.id ? renameValue : ''}
                      onEditChange={setRenameValue}
                      onEditCommit={handleRenameCommit}
                      onEditCancel={handleRenameCancel}
                      editInputRef={renameInputRef}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </>
      )}

      {/* Context Menu */}
      <Menu
        open={!!contextMenu}
        onOpenChange={(_, data) => {
          if (!data.open) setContextMenu(null);
        }}
        positioning={
          contextMenuTarget
            ? { target: contextMenuTarget, position: 'below', align: 'start', offset: 4 }
            : undefined
        }
      >
        <MenuTrigger disableButtonEnhancement>
          <div style={{ width: 0, height: 0 }} />
        </MenuTrigger>
        <MenuPopover className={styles['menu-popover']}>
          <MenuList className={styles['menu-list']}>
            <MenuItem
              className={styles['menu-item']}
              onClick={() => contextMenu && handleMenuAction(`rename:${contextMenu.id}`)}
            >
              {t('common.rename')}
            </MenuItem>
            <MenuItem
              className={styles['menu-item']}
              onClick={() => contextMenu && handleMenuAction(`color:${contextMenu.id}`)}
            >
              {t('tags.setColor')}
            </MenuItem>
            <MenuItem
              className={styles['menu-item']}
              onClick={() => contextMenu && handleMenuAction(`delete:${contextMenu.id}`)}
            >
              {t('common.delete')}
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>

      {/* Color Picker Dialog */}
      <ColorPickerDialog
        open={colorPickerOpen}
        initialColor={colorPickerInitial ?? undefined}
        onClose={() => {
          setColorPickerOpen(false);
          setColorPickerTagId(null);
          setColorPickerInitial(null);
        }}
        onSelect={handleColorSelect}
      />

      {/* Delete Confirmation Dialog */}
      {deleteConfirmId && (
        <Dialog open onOpenChange={() => setDeleteConfirmId(null)}>
          <DialogSurface className={styles['dialog-surface']}>
            <DialogBody>
              <DialogTitle className={styles['dialog-title']}>
                {t('tags.deleteConfirmTitle')}
              </DialogTitle>
              <DialogContent className={styles['dialog-content']}>
                {t('tags.deleteConfirmBody')}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setDeleteConfirmId(null)}>
                  {t('common.cancel')}
                </Button>
                <Button onClick={handleDeleteConfirm}>
                  {t('common.delete')}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </div>
  );
};
