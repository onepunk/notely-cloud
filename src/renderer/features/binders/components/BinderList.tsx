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
  Warning20Regular,
} from '@fluentui/react-icons';
import * as LucideIcons from 'lucide-react';
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useLocation, useParams } from 'react-router-dom';

import { useSettingsStore } from '../../../shared/state/settings.store';
import { useBindersStore } from '../model/binders.store';

import styles from './BinderList.module.css';
import { ColorPickerDialog } from './ColorPickerDialog';
import { IconPickerDialog } from './IconPickerDialog';

const BINDERS_COLLAPSED_KEY = 'ui.binderList.collapsed';
type LucideIconComponent = React.ComponentType<{
  size?: number;
  className?: string;
  color?: string;
  style?: React.CSSProperties;
}>;
const lucideModule = LucideIcons as unknown as Record<string, LucideIconComponent>;

// Helper to render Lucide icon by name
const LucideIcon: React.FC<{
  name: string;
  size?: number;
  className?: string;
  color?: string;
  style?: React.CSSProperties;
}> = ({ name, size = 16, className, color, style }) => {
  const Icon = lucideModule[name];
  if (!Icon) return null;
  return <Icon size={size} className={className} color={color} style={style} />;
};

type Binder = import('../../../../preload').BinderSummary;

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

function SortableBinderItem({
  binder,
  active,
  onOpenContext,
  onNoteDrop,
  editing,
  editValue,
  onEditChange,
  onEditCommit,
  onEditCancel,
  editInputRef,
}: {
  binder: Binder;
  active: boolean;
  onOpenContext: (id: string, position: { x: number; y: number }) => void;
  onNoteDrop: (noteId: string, targetBinderId: string) => void;
  editing: boolean;
  editValue: string;
  onEditChange: (value: string) => void;
  onEditCommit: () => void;
  onEditCancel: () => void;
  editInputRef: React.RefObject<HTMLInputElement>;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id: binder.id,
  });
  const style: React.CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  const binderColor = binder.color || undefined;
  const [isDragOver, setIsDragOver] = React.useState(false);

  const handleBinderClick = React.useCallback(() => {
    // Dispatch custom event to expand notes list when binder is clicked
    window.dispatchEvent(
      new CustomEvent('sidebar:navigate', { detail: { type: 'binder', binderId: binder.id } })
    );
  }, [binder.id]);

  const handleDragOver = React.useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('text/notely-note-id')) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      setIsDragOver(true);
    }
  }, []);

  const handleDragEnter = React.useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('text/notely-note-id')) {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(true);
    }
  }, []);

  const handleDragLeave = React.useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = React.useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      const noteId = e.dataTransfer.getData('text/notely-note-id');
      if (!noteId) return;
      onNoteDrop(noteId, binder.id);
    },
    [binder.id, onNoteDrop]
  );

  return (
    <li className={styles.li} ref={setNodeRef} style={style}>
      <Link
        to={'/binders/' + binder.id}
        className={styles['item-link']}
        {...attributes}
        {...(editing ? {} : listeners)}
        onClick={(event) => {
          if (editing) {
            event.preventDefault();
            return;
          }
          handleBinderClick();
        }}
        tabIndex={editing ? -1 : undefined}
        aria-disabled={editing || undefined}
        onContextMenu={(e) => {
          e.preventDefault();
          onOpenContext(binder.id, { x: e.clientX, y: e.clientY });
        }}
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          className={`${styles.item} ${active ? styles['item-active'] : ''} ${isDragOver ? styles['item-drag-over'] : ''}`}
        >
          {editing ? (
            <span
              className={styles['item-name']}
              style={binderColor ? { color: binderColor } : undefined}
            >
              {binder.icon ? (
                <LucideIcon name={binder.icon} size={16} color={binderColor} />
              ) : binderColor ? (
                <span
                  className={styles['color-dot']}
                  style={{ backgroundColor: binderColor, borderColor: binderColor }}
                  aria-hidden="true"
                />
              ) : null}
              <Input
                ref={editInputRef}
                className={styles['rename-input']}
                value={editValue}
                style={binderColor ? { color: binderColor } : undefined}
                onChange={(_, data) => onEditChange(data.value)}
                onBlur={onEditCancel}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onEditCommit();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    onEditCancel();
                  }
                }}
              />
            </span>
          ) : (
            <span
              className={styles['item-name']}
              style={binderColor ? { color: binderColor } : undefined}
            >
              {binder.icon ? (
                <LucideIcon name={binder.icon} size={16} color={binderColor} />
              ) : binderColor ? (
                <span
                  className={styles['color-dot']}
                  style={{ backgroundColor: binderColor, borderColor: binderColor }}
                  aria-hidden="true"
                />
              ) : null}
              <span>{binder.name}</span>
            </span>
          )}
          <span className={styles.actions} />
        </div>
      </Link>
    </li>
  );
}

/**
 * ConflictsBinderItem - Special non-sortable binder for showing sync conflicts
 * Only rendered when there are unresolved conflicts
 */
function ConflictsBinderItem({
  binder,
  conflictsCount,
  active,
}: {
  binder: Binder;
  conflictsCount: number;
  active: boolean;
}) {
  const { t } = useTranslation();

  const handleClick = React.useCallback(() => {
    // Dispatch custom event to expand notes list when conflicts binder is clicked
    window.dispatchEvent(
      new CustomEvent('sidebar:navigate', { detail: { type: 'binder', binderId: binder.id } })
    );
  }, [binder.id]);

  return (
    <li className={styles.li}>
      <Link to={'/binders/' + binder.id} className={styles['item-link']} onClick={handleClick}>
        <div
          className={`${styles.item} ${styles['item-conflicts']} ${active ? styles['item-active'] : ''}`}
        >
          <span className={styles['item-name']} style={{ color: '#DC2626' }}>
            <Warning20Regular style={{ color: '#DC2626' }} />
            <span>{t('sidebar.conflicts')}</span>
          </span>
          <span className={styles['conflicts-badge']}>{conflictsCount}</span>
        </div>
      </Link>
    </li>
  );
}

type BinderSidebarProps = {
  compactHeader?: boolean;
};

export const Sidebar: React.FC<BinderSidebarProps> = ({ compactHeader = true }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const { binders, load, add, rename, update, remove, reorder, conflictsBinder, conflictsCount } =
    useBindersStore((s) => ({
      binders: s.binders,
      load: s.load,
      add: s.add,
      rename: s.rename,
      update: s.update,
      remove: s.remove,
      reorder: s.reorder,
      conflictsBinder: s.conflictsBinder,
      conflictsCount: s.conflictsCount,
    }));

  // Collapse state persisted in settings
  const isCollapsed = useSettingsStore((state) => state.getBoolean(BINDERS_COLLAPSED_KEY, false));
  const setBoolean = useSettingsStore((state) => state.setBoolean);

  const toggleCollapsed = React.useCallback(() => {
    void setBoolean(BINDERS_COLLAPSED_KEY, !isCollapsed);
  }, [isCollapsed, setBoolean]);

  const [adding, setAdding] = React.useState(false);
  const [name, setName] = React.useState('');
  const [menuState, setMenuState] = React.useState<{
    type: 'none' | 'delete';
    id?: string;
  }>({ type: 'none' });
  const [iconPickerOpen, setIconPickerOpen] = React.useState(false);
  const [iconPickerBinderId, setIconPickerBinderId] = React.useState<string | null>(null);
  const [colorPickerOpen, setColorPickerOpen] = React.useState(false);
  const [colorPickerBinderId, setColorPickerBinderId] = React.useState<string | null>(null);
  const [colorPickerInitial, setColorPickerInitial] = React.useState<string | null>(null);
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const renameInputRef = React.useRef<HTMLInputElement | null>(null);
  const [contextMenu, setContextMenu] = React.useState<{
    id: string;
    position: { x: number; y: number };
  } | null>(null);

  React.useEffect(() => {
    load();
  }, [load]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const activeId =
    (location.pathname.startsWith('/binders/') && location.pathname.split('/')[2]) || '';

  const onDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = binders.findIndex((b) => b.id === active.id);
    const newIndex = binders.findIndex((b) => b.id === over.id);
    const reordered = arrayMove(binders, oldIndex, newIndex);
    await reorder(reordered.map((b) => b.id));
  };

  const onAdd = async () => {
    if (!name.trim()) return;
    const id = await add(name.trim());
    setName('');
    setAdding(false);
    navigate('/binders/' + id);
  };

  const onOpenMenu = React.useCallback(
    (action: string) => {
      if (action.startsWith('rename:')) {
        const id = action.split(':')[1];
        const b = binders.find((x) => x.id === id);
        setRenameValue(b?.name || '');
        setRenamingId(id);
        setAdding(false);
        setName('');
        setMenuState({ type: 'none' });
      } else if (action.startsWith('color:')) {
        const id = action.split(':')[1];
        const binder = binders.find((x) => x.id === id);
        setColorPickerBinderId(id);
        setColorPickerInitial(binder?.color ?? null);
        setColorPickerOpen(true);
        setMenuState({ type: 'none' });
      } else if (action.startsWith('icon:')) {
        const id = action.split(':')[1];
        setIconPickerBinderId(id);
        setIconPickerOpen(true);
      } else if (action.startsWith('icon-clear:')) {
        const id = action.split(':')[1];
        update({ id, icon: null });
      } else if (action.startsWith('delete:')) {
        setMenuState({ type: 'delete', id: action.split(':')[1] });
      } else {
        setMenuState({ type: 'none' });
      }
      setContextMenu(null);
    },
    [binders, update]
  );
  const openContextMenu = React.useCallback(
    (binderId: string, position: { x: number; y: number }) => {
      setContextMenu({ id: binderId, position });
    },
    []
  );
  const contextMenuTarget = React.useMemo(() => {
    if (!contextMenu) return undefined;
    return createVirtualElement(contextMenu.position.x, contextMenu.position.y);
  }, [contextMenu]);
  const contextBinder = React.useMemo(
    () => (contextMenu ? binders.find((b) => b.id === contextMenu.id) : null),
    [contextMenu, binders]
  );

  React.useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const handleRenameCommit = React.useCallback(async () => {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (!trimmed) {
      setRenamingId(null);
      setRenameValue('');
      return;
    }
    const currentBinder = binders.find((binder) => binder.id === renamingId);
    if (currentBinder && currentBinder.name === trimmed) {
      setRenamingId(null);
      setRenameValue('');
      return;
    }
    await rename(renamingId, trimmed);
    setRenamingId(null);
    setRenameValue('');
  }, [binders, rename, renamingId, renameValue]);

  const handleRenameCancel = React.useCallback(() => {
    setRenamingId(null);
    setRenameValue('');
  }, []);

  const onNoteDrop = async (noteId: string, targetBinderId: string) => {
    try {
      await window.api.storage.moveNote(noteId, targetBinderId);
      // If the dropped note is currently open, switch to its new binder route
      if (params.noteId === noteId) navigate(`/binders/${targetBinderId}/notes/${noteId}`);
      // Ask notes list to refresh
      window.dispatchEvent(new Event('notes:changed'));
    } catch {
      // noop
    }
  };

  return (
    <aside className={styles.root}>
      <div className={compactHeader ? styles['header-compact'] : styles.header}>
        <button
          type="button"
          className={styles['header-toggle']}
          onClick={toggleCollapsed}
          aria-label={isCollapsed ? t('common.expand') : t('common.collapse')}
        >
          {isCollapsed ? <ChevronRight20Regular /> : <ChevronDown20Regular />}
          <span className={styles['header-label']}>{t('sidebar.binders')}</span>
        </button>
        {!isCollapsed && (
          <Button
            appearance="subtle"
            size="small"
            icon={<Add20Regular />}
            onClick={() => setAdding((v) => !v)}
            aria-label={adding ? t('common.close') : t('sidebar.addBinder')}
          />
        )}
      </div>

      {!isCollapsed && (
        <>
          {adding && (
            <div className={styles['add-row']}>
              <Input
                className={styles['add-input']}
                value={name}
                onChange={(_, d) => setName(d.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    onAdd();
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    setName('');
                    setAdding(false);
                  }
                }}
                placeholder={t('binders.title')}
              />
            </div>
          )}

          {/* Conflicts binder - shown at top when there are unresolved conflicts */}
          {conflictsBinder && conflictsCount > 0 && (
            <ul className={styles.list}>
              <ConflictsBinderItem
                binder={conflictsBinder}
                conflictsCount={conflictsCount}
                active={activeId === conflictsBinder.id}
              />
            </ul>
          )}

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext
              items={binders.map((b) => b.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className={styles.list}>
                {binders.map((b) => (
                  <SortableBinderItem
                    key={b.id}
                    binder={b}
                    active={activeId === b.id}
                    onOpenContext={openContextMenu}
                    onNoteDrop={onNoteDrop}
                    editing={renamingId === b.id}
                    editValue={renamingId === b.id ? renameValue : ''}
                    onEditChange={setRenameValue}
                    onEditCommit={handleRenameCommit}
                    onEditCancel={handleRenameCancel}
                    editInputRef={renameInputRef}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </>
      )}

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
              onClick={() => {
                if (contextMenu) onOpenMenu(`rename:${contextMenu.id}`);
              }}
            >
              {t('common.rename')}
            </MenuItem>
            <MenuItem
              className={styles['menu-item']}
              onClick={() => {
                if (contextMenu) onOpenMenu(`color:${contextMenu.id}`);
              }}
            >
              {t('binders.set_colour')}
            </MenuItem>
            <MenuItem
              className={styles['menu-item']}
              onClick={() => {
                if (contextMenu) onOpenMenu(`icon:${contextMenu.id}`);
              }}
            >
              {t('binders.set_icon')}
            </MenuItem>
            {contextBinder?.icon && (
              <MenuItem
                className={styles['menu-item']}
                onClick={() => {
                  if (contextMenu) onOpenMenu(`icon-clear:${contextMenu.id}`);
                }}
              >
                {t('binders.remove_icon')}
              </MenuItem>
            )}
            <MenuItem
              className={styles['menu-item']}
              onClick={() => {
                if (contextMenu) onOpenMenu(`delete:${contextMenu.id}`);
              }}
            >
              {t('common.delete')}
            </MenuItem>
          </MenuList>
        </MenuPopover>
      </Menu>

      <ColorPickerDialog
        open={colorPickerOpen}
        initialColor={colorPickerInitial ?? undefined}
        onClose={() => {
          setColorPickerOpen(false);
          setColorPickerBinderId(null);
          setColorPickerInitial(null);
        }}
        onSelect={async (hex) => {
          if (!colorPickerBinderId) return;
          await update({ id: colorPickerBinderId, color: hex });
          setColorPickerOpen(false);
          setColorPickerBinderId(null);
          setColorPickerInitial(null);
        }}
      />

      {/* Icon Picker Dialog */}
      <IconPickerDialog
        open={iconPickerOpen}
        onClose={() => {
          setIconPickerOpen(false);
          setIconPickerBinderId(null);
        }}
        onSelect={async (iconName) => {
          if (iconPickerBinderId) {
            await update({ id: iconPickerBinderId, icon: iconName });
          }
        }}
      />

      {menuState.type === 'delete' && menuState.id && (
        <Dialog open onOpenChange={() => setMenuState({ type: 'none' })}>
          <DialogSurface className={styles['dialog-surface']}>
            <DialogBody>
              <DialogTitle className={styles['dialog-title']}>
                {t('binders.delete_confirm_title')}
              </DialogTitle>
              <DialogContent className={styles['dialog-content']}>
                {t('binders.delete_confirm_body')}
              </DialogContent>
              <DialogActions>
                <Button appearance="secondary" onClick={() => setMenuState({ type: 'none' })}>
                  {t('common.close')}
                </Button>
                <Button
                  onClick={async () => {
                    await remove(menuState.id!);
                    setMenuState({ type: 'none' });
                  }}
                >
                  {t('common.delete')}
                </Button>
              </DialogActions>
            </DialogBody>
          </DialogSurface>
        </Dialog>
      )}
    </aside>
  );
};
