import {
  TextBold20Regular,
  TextItalic20Regular,
  TextUnderline20Regular,
  TextStrikethrough20Regular,
  Code20Regular,
  Link20Regular,
  TextAlignLeft20Regular,
  TextAlignCenter20Regular,
  TextAlignRight20Regular,
  TextAlignJustify20Regular,
  TextIndentDecrease20Regular,
  TextIndentIncrease20Regular,
  TextSubscript20Regular,
  TextSuperscript20Regular,
  ArrowUndo20Regular,
  ArrowRedo20Regular,
  TextFont20Regular,
  ChevronDown20Regular,
  Eraser20Regular,
  LineHorizontal120Regular,
  Add20Regular,
  Subtract20Regular,
  TextCaseLowercase20Regular,
  TextCaseUppercase20Regular,
  TextCaseTitle20Regular,
  Color20Regular,
  TableAdd20Regular,
  Image20Regular,
  MoreHorizontal20Regular,
  Highlight20Regular,
} from '@fluentui/react-icons';
import { $isLinkNode, TOGGLE_LINK_COMMAND } from '@lexical/link';
import {
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
  $isListNode,
} from '@lexical/list';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { INSERT_HORIZONTAL_RULE_COMMAND } from '@lexical/react/LexicalHorizontalRuleNode';
import { $createQuoteNode, $isHeadingNode, $createHeadingNode } from '@lexical/rich-text';
import {
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  FORMAT_TEXT_COMMAND,
  FORMAT_ELEMENT_COMMAND,
  SELECTION_CHANGE_COMMAND,
  COMMAND_PRIORITY_CRITICAL,
  UNDO_COMMAND,
  REDO_COMMAND,
  CAN_UNDO_COMMAND,
  CAN_REDO_COMMAND,
  INDENT_CONTENT_COMMAND,
  OUTDENT_CONTENT_COMMAND,
} from 'lexical';
import * as React from 'react';
import { createPortal } from 'react-dom';

import styles from './ToolbarPlugin.module.css';

const TOOLBAR_PORTAL_ID = 'workspace-toolbar-slot';

const FONT_FAMILY_OPTIONS = [
  { label: 'Arial', value: 'Arial' },
  { label: 'Courier New', value: 'Courier New' },
  { label: 'Georgia', value: 'Georgia' },
  { label: 'Times New Roman', value: 'Times New Roman' },
  { label: 'Trebuchet MS', value: 'Trebuchet MS' },
  { label: 'Verdana', value: 'Verdana' },
];

const BLOCK_TYPE_OPTIONS = [
  { label: 'Paragraph', value: 'paragraph' },
  { label: 'Heading 1', value: 'h1' },
  { label: 'Heading 2', value: 'h2' },
  { label: 'Heading 3', value: 'h3' },
  { label: 'Bullet List', value: 'bullet' },
  { label: 'Numbered List', value: 'number' },
  { label: 'Quote', value: 'quote' },
];

const TEXT_COLORS = [
  '#000000',
  '#ffffff',
  '#888888',
  '#ff0000',
  '#ff9900',
  '#ffff00',
  '#00ff00',
  '#00ffff',
  '#0000ff',
  '#9900ff',
  '#ff00ff',
];

type DropdownType =
  | 'blockType'
  | 'fontFamily'
  | 'textColor'
  | 'textTransform'
  | 'insert'
  | 'alignment'
  | 'overflow'
  | null;

// Priority levels for toolbar items (lower = higher priority, shown first)
const TOOLBAR_ITEM_PRIORITY = {
  undo: 1,
  redo: 2,
  blockType: 3,
  fontFamily: 4,
  fontSize: 5,
  bold: 6,
  italic: 7,
  underline: 8,
  code: 9,
  link: 10,
  textColor: 11,
  textTransform: 12,
  insert: 13,
  alignment: 14,
};

export const ToolbarPlugin: React.FC = () => {
  // Toolbar is disabled in this UI version
  return null;

  const [editor] = useLexicalComposerContext();
  const [isBold, setIsBold] = React.useState(false);
  const [isItalic, setIsItalic] = React.useState(false);
  const [isUnderline, setIsUnderline] = React.useState(false);
  const [isCode, setIsCode] = React.useState(false);
  const [isLink, setIsLink] = React.useState(false);
  const [canUndo, setCanUndo] = React.useState(false);
  const [canRedo, setCanRedo] = React.useState(false);
  const [blockType, setBlockType] = React.useState('paragraph');
  const [fontSize, setFontSize] = React.useState(16);
  const [fontFamily, setFontFamily] = React.useState('Arial');
  const [_textColor, _setTextColor] = React.useState('#000000');
  const [alignment, setAlignment] = React.useState<'left' | 'center' | 'right' | 'justify'>('left');
  const [activeDropdown, setActiveDropdown] = React.useState<DropdownType>(null);
  const [visibleItems, setVisibleItems] = React.useState<string[]>(
    Object.keys(TOOLBAR_ITEM_PRIORITY)
  );
  const [overflowItems, setOverflowItems] = React.useState<string[]>([]);
  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const itemsRef = React.useRef<Map<string, HTMLElement>>(new Map());
  const [portalEl, setPortalEl] = React.useState<HTMLElement | null>(() => {
    if (typeof window === 'undefined') return null;
    return document.getElementById(TOOLBAR_PORTAL_ID);
  });

  const updateToolbar = React.useCallback(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      // Text formatting states
      setIsBold(selection.hasFormat('bold'));
      setIsItalic(selection.hasFormat('italic'));
      setIsUnderline(selection.hasFormat('underline'));
      setIsCode(selection.hasFormat('code'));

      // Link state
      const node = selection.anchor.getNode();
      const parent = node.getParent();
      setIsLink($isLinkNode(parent) || $isLinkNode(node));

      // Block type
      const anchorNode = selection.anchor.getNode();
      const element =
        anchorNode.getKey() === 'root' ? anchorNode : anchorNode.getTopLevelElementOrThrow();

      if ($isListNode(element)) {
        const type = element.getListType();
        setBlockType(type);
      } else {
        const type = $isHeadingNode(element) ? element.getTag() : element.getType();
        setBlockType(type);
      }
    }
  }, []);

  React.useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        updateToolbar();
        return false;
      },
      COMMAND_PRIORITY_CRITICAL
    );
  }, [editor, updateToolbar]);

  React.useEffect(() => {
    return editor.registerCommand(
      CAN_UNDO_COMMAND,
      (payload) => {
        setCanUndo(payload);
        return false;
      },
      COMMAND_PRIORITY_CRITICAL
    );
  }, [editor]);

  React.useEffect(() => {
    return editor.registerCommand(
      CAN_REDO_COMMAND,
      (payload) => {
        setCanRedo(payload);
        return false;
      },
      COMMAND_PRIORITY_CRITICAL
    );
  }, [editor]);

  React.useEffect(() => {
    if (portalEl || typeof window === 'undefined') return;
    const el = document.getElementById(TOOLBAR_PORTAL_ID);
    if (el) {
      setPortalEl(el);
    }
  }, [portalEl]);

  // Handle overflow detection
  React.useEffect(() => {
    const calculateOverflow = () => {
      if (!toolbarRef.current) return;

      const toolbar = toolbarRef.current;
      const toolbarWidth = toolbar.offsetWidth;
      const overflowButtonWidth = 40; // Width of overflow button + margin
      const availableWidth = toolbarWidth - overflowButtonWidth;

      const items = itemsRef.current;
      const sortedKeys = Object.keys(TOOLBAR_ITEM_PRIORITY).sort(
        (a, b) =>
          TOOLBAR_ITEM_PRIORITY[a as keyof typeof TOOLBAR_ITEM_PRIORITY] -
          TOOLBAR_ITEM_PRIORITY[b as keyof typeof TOOLBAR_ITEM_PRIORITY]
      );

      const visible: string[] = [];
      const overflow: string[] = [];
      let usedWidth = 0;

      for (const key of sortedKeys) {
        const element = items.get(key);
        if (element) {
          const itemWidth = element.offsetWidth + 4; // Include gap
          if (usedWidth + itemWidth <= availableWidth) {
            visible.push(key);
            usedWidth += itemWidth;
          } else {
            overflow.push(key);
          }
        }
      }

      setVisibleItems(visible);
      setOverflowItems(overflow);
    };

    // Initial calculation
    calculateOverflow();

    // Recalculate on resize
    const resizeObserver = new ResizeObserver(() => {
      calculateOverflow();
    });

    if (toolbarRef.current) {
      resizeObserver.observe(toolbarRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  // Close dropdowns when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(`.${styles.dropdownContainer}`)) {
        setActiveDropdown(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const toggleDropdown = React.useCallback((dropdown: DropdownType) => {
    setActiveDropdown((current) => (current === dropdown ? null : dropdown));
  }, []);

  const formatBlockType = React.useCallback(
    (type: string) => {
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          if (type === 'paragraph') {
            const paragraph = $createParagraphNode();
            selection.anchor.getNode().replace(paragraph);
          } else if (type.startsWith('h')) {
            const heading = $createHeadingNode(type as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6');
            selection.anchor.getNode().replace(heading);
          } else if (type === 'quote') {
            const quote = $createQuoteNode();
            selection.anchor.getNode().replace(quote);
          } else if (type === 'bullet') {
            if (blockType !== 'bullet') {
              editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
            } else {
              editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
            }
          } else if (type === 'number') {
            if (blockType !== 'number') {
              editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
            } else {
              editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
            }
          }
        }
      });
      setActiveDropdown(null);
    },
    [editor, blockType]
  );

  const insertLink = React.useCallback(() => {
    if (!isLink) {
      const url = prompt('Enter URL:');
      if (url) {
        editor.dispatchCommand(TOGGLE_LINK_COMMAND, url);
      }
    } else {
      editor.dispatchCommand(TOGGLE_LINK_COMMAND, null);
    }
  }, [editor, isLink]);

  const applyTextTransform = React.useCallback(
    (transform: 'lowercase' | 'uppercase' | 'capitalize') => {
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          const text = selection.getTextContent();
          let transformed = text;
          if (transform === 'lowercase') {
            transformed = text.toLowerCase();
          } else if (transform === 'uppercase') {
            transformed = text.toUpperCase();
          } else if (transform === 'capitalize') {
            transformed = text.replace(/\b\w/g, (char) => char.toUpperCase());
          }
          selection.insertText(transformed);
        }
      });
      setActiveDropdown(null);
    },
    [editor]
  );

  const clearFormatting = React.useCallback(() => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        selection.getNodes().forEach((node) => {
          if (node.getType() === 'text') {
            node.setFormat(0);
          }
        });
      }
    });
  }, [editor]);

  const getBlockTypeLabel = () => {
    const option = BLOCK_TYPE_OPTIONS.find((opt) => opt.value === blockType);
    return option?.label || 'Paragraph';
  };

  const isItemVisible = (itemKey: string) => visibleItems.includes(itemKey);

  const toolbar = (
    <div className={styles.toolbarWrapper} style={{ display: 'none' }}>
      <div className={styles.toolbar} ref={toolbarRef}>
        {/* Undo/Redo */}
        {isItemVisible('undo') && (
          <button
            ref={(el) => el && itemsRef.current.set('undo', el)}
            type="button"
            className={styles.toolbarButton}
            onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}
            disabled={!canUndo}
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
          >
            <ArrowUndo20Regular />
          </button>
        )}
        {isItemVisible('redo') && (
          <button
            ref={(el) => el && itemsRef.current.set('redo', el)}
            type="button"
            className={styles.toolbarButton}
            onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}
            disabled={!canRedo}
            aria-label="Redo"
            title="Redo (Ctrl+Y)"
          >
            <ArrowRedo20Regular />
          </button>
        )}

        {(isItemVisible('undo') || isItemVisible('redo')) && <div className={styles.divider} />}

        {/* Block Type Dropdown */}
        {isItemVisible('blockType') && (
          <div
            className={styles.dropdownContainer}
            ref={(el) => el && itemsRef.current.set('blockType', el)}
          >
            <button
              type="button"
              className={styles.toolbarButtonWide}
              onClick={() => toggleDropdown('blockType')}
              aria-label="Block Type"
              title="Block Type"
            >
              <TextFont20Regular />
              <span className={styles.buttonLabel}>{getBlockTypeLabel()}</span>
              <ChevronDown20Regular />
            </button>
            {activeDropdown === 'blockType' && (
              <div className={styles.dropdown}>
                {BLOCK_TYPE_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={styles.dropdownItem}
                    onClick={() => formatBlockType(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {isItemVisible('blockType') && <div className={styles.divider} />}

        {/* Font Family Dropdown */}
        {isItemVisible('fontFamily') && (
          <div
            className={styles.dropdownContainer}
            ref={(el) => el && itemsRef.current.set('fontFamily', el)}
          >
            <button
              type="button"
              className={styles.toolbarButtonWide}
              onClick={() => toggleDropdown('fontFamily')}
              aria-label="Font Family"
              title="Font Family"
            >
              <span className={styles.buttonLabel}>{fontFamily}</span>
              <ChevronDown20Regular />
            </button>
            {activeDropdown === 'fontFamily' && (
              <div className={styles.dropdown}>
                {FONT_FAMILY_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    className={styles.dropdownItem}
                    onClick={() => {
                      setFontFamily(option.value);
                      setActiveDropdown(null);
                    }}
                    style={{ fontFamily: option.value }}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {isItemVisible('fontFamily') && <div className={styles.divider} />}

        {/* Font Size with +/- buttons */}
        {isItemVisible('fontSize') && (
          <div
            className={styles.fontSizeGroup}
            ref={(el) => el && itemsRef.current.set('fontSize', el)}
          >
            <button
              type="button"
              className={styles.toolbarButton}
              onClick={() => setFontSize((prev) => Math.max(8, prev - 1))}
              aria-label="Decrease Font Size"
              title="Decrease Font Size"
            >
              <Subtract20Regular />
            </button>
            <input
              type="number"
              className={styles.fontSizeInput}
              value={fontSize}
              onChange={(e) =>
                setFontSize(Math.max(8, Math.min(72, parseInt(e.target.value) || 16)))
              }
              min="8"
              max="72"
            />
            <button
              type="button"
              className={styles.toolbarButton}
              onClick={() => setFontSize((prev) => Math.min(72, prev + 1))}
              aria-label="Increase Font Size"
              title="Increase Font Size"
            >
              <Add20Regular />
            </button>
          </div>
        )}

        {isItemVisible('fontSize') && <div className={styles.divider} />}

        {/* Text Formatting */}
        {isItemVisible('bold') && (
          <button
            ref={(el) => el && itemsRef.current.set('bold', el)}
            type="button"
            className={`${styles.toolbarButton} ${isBold ? styles.active : ''}`}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')}
            aria-label="Bold"
            title="Bold (Ctrl+B)"
          >
            <TextBold20Regular />
          </button>
        )}
        {isItemVisible('italic') && (
          <button
            ref={(el) => el && itemsRef.current.set('italic', el)}
            type="button"
            className={`${styles.toolbarButton} ${isItalic ? styles.active : ''}`}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')}
            aria-label="Italic"
            title="Italic (Ctrl+I)"
          >
            <TextItalic20Regular />
          </button>
        )}
        {isItemVisible('underline') && (
          <button
            ref={(el) => el && itemsRef.current.set('underline', el)}
            type="button"
            className={`${styles.toolbarButton} ${isUnderline ? styles.active : ''}`}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline')}
            aria-label="Underline"
            title="Underline (Ctrl+U)"
          >
            <TextUnderline20Regular />
          </button>
        )}
        {isItemVisible('code') && (
          <button
            ref={(el) => el && itemsRef.current.set('code', el)}
            type="button"
            className={`${styles.toolbarButton} ${isCode ? styles.active : ''}`}
            onClick={() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code')}
            aria-label="Code"
            title="Inline Code"
          >
            <Code20Regular />
          </button>
        )}
        {isItemVisible('link') && (
          <button
            ref={(el) => el && itemsRef.current.set('link', el)}
            type="button"
            className={`${styles.toolbarButton} ${isLink ? styles.active : ''}`}
            onClick={insertLink}
            aria-label="Link"
            title="Link (Ctrl+K)"
          >
            <Link20Regular />
          </button>
        )}

        {/* Text Color Picker */}
        {isItemVisible('textColor') && (
          <div
            className={styles.dropdownContainer}
            ref={(el) => el && itemsRef.current.set('textColor', el)}
          >
            <button
              type="button"
              className={styles.toolbarButton}
              onClick={() => toggleDropdown('textColor')}
              aria-label="Text Color"
              title="Text Color"
            >
              <Color20Regular />
            </button>
            {activeDropdown === 'textColor' && (
              <div className={styles.colorDropdown}>
                {TEXT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={styles.colorButton}
                    style={{ backgroundColor: color }}
                    onClick={() => {
                      _setTextColor(color);
                      setActiveDropdown(null);
                    }}
                    aria-label={`Color ${color}`}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Text Transform Dropdown */}
        {isItemVisible('textTransform') && (
          <div
            className={styles.dropdownContainer}
            ref={(el) => el && itemsRef.current.set('textTransform', el)}
          >
            <button
              type="button"
              className={styles.toolbarButton}
              onClick={() => toggleDropdown('textTransform')}
              aria-label="Text Transform"
              title="Text Transform"
            >
              <TextCaseTitle20Regular />
            </button>
            {activeDropdown === 'textTransform' && (
              <div className={styles.dropdown}>
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => applyTextTransform('lowercase')}
                >
                  <TextCaseLowercase20Regular />
                  <span>lowercase</span>
                </button>
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => applyTextTransform('uppercase')}
                >
                  <TextCaseUppercase20Regular />
                  <span>UPPERCASE</span>
                </button>
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => applyTextTransform('capitalize')}
                >
                  <TextCaseTitle20Regular />
                  <span>Capitalize</span>
                </button>
                <div className={styles.dropdownDivider} />
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => {
                    editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'strikethrough');
                    setActiveDropdown(null);
                  }}
                >
                  <TextStrikethrough20Regular />
                  <span>Strikethrough</span>
                </button>
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => {
                    editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'subscript');
                    setActiveDropdown(null);
                  }}
                >
                  <TextSubscript20Regular />
                  <span>Subscript</span>
                </button>
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => {
                    editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'superscript');
                    setActiveDropdown(null);
                  }}
                >
                  <TextSuperscript20Regular />
                  <span>Superscript</span>
                </button>
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => {
                    editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'highlight');
                    setActiveDropdown(null);
                  }}
                >
                  <Highlight20Regular />
                  <span>Highlight</span>
                </button>
                <div className={styles.dropdownDivider} />
                <button type="button" className={styles.dropdownItem} onClick={clearFormatting}>
                  <Eraser20Regular />
                  <span>Clear Formatting</span>
                </button>
              </div>
            )}
          </div>
        )}

        {(isItemVisible('textColor') || isItemVisible('textTransform')) && (
          <div className={styles.divider} />
        )}

        {/* Insert Dropdown */}
        {isItemVisible('insert') && (
          <div
            className={styles.dropdownContainer}
            ref={(el) => el && itemsRef.current.set('insert', el)}
          >
            <button
              type="button"
              className={styles.toolbarButtonWide}
              onClick={() => toggleDropdown('insert')}
              aria-label="Insert"
              title="Insert"
            >
              <span className={styles.buttonLabel}>Insert</span>
              <ChevronDown20Regular />
            </button>
            {activeDropdown === 'insert' && (
              <div className={styles.dropdown}>
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => {
                    editor.dispatchCommand(INSERT_HORIZONTAL_RULE_COMMAND, undefined);
                    setActiveDropdown(null);
                  }}
                >
                  <LineHorizontal120Regular />
                  <span>Horizontal Rule</span>
                </button>
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => setActiveDropdown(null)}
                >
                  <Image20Regular />
                  <span>Image</span>
                </button>
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => setActiveDropdown(null)}
                >
                  <TableAdd20Regular />
                  <span>Table</span>
                </button>
              </div>
            )}
          </div>
        )}

        {isItemVisible('insert') && <div className={styles.divider} />}

        {/* Alignment Dropdown */}
        {isItemVisible('alignment') && (
          <div
            className={styles.dropdownContainer}
            ref={(el) => el && itemsRef.current.set('alignment', el)}
          >
            <button
              type="button"
              className={styles.toolbarButton}
              onClick={() => toggleDropdown('alignment')}
              aria-label="Alignment"
              title="Alignment"
            >
              {alignment === 'left' && <TextAlignLeft20Regular />}
              {alignment === 'center' && <TextAlignCenter20Regular />}
              {alignment === 'right' && <TextAlignRight20Regular />}
              {alignment === 'justify' && <TextAlignJustify20Regular />}
            </button>
            {activeDropdown === 'alignment' && (
              <div className={styles.dropdown}>
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => {
                    editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'left');
                    setAlignment('left');
                    setActiveDropdown(null);
                  }}
                >
                  <TextAlignLeft20Regular />
                  <span>Align Left</span>
                </button>
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => {
                    editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center');
                    setAlignment('center');
                    setActiveDropdown(null);
                  }}
                >
                  <TextAlignCenter20Regular />
                  <span>Align Center</span>
                </button>
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => {
                    editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'right');
                    setAlignment('right');
                    setActiveDropdown(null);
                  }}
                >
                  <TextAlignRight20Regular />
                  <span>Align Right</span>
                </button>
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => {
                    editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'justify');
                    setAlignment('justify');
                    setActiveDropdown(null);
                  }}
                >
                  <TextAlignJustify20Regular />
                  <span>Align Justify</span>
                </button>
                <div className={styles.dropdownDivider} />
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => {
                    editor.dispatchCommand(OUTDENT_CONTENT_COMMAND, undefined);
                    setActiveDropdown(null);
                  }}
                >
                  <TextIndentDecrease20Regular />
                  <span>Outdent</span>
                </button>
                <button
                  type="button"
                  className={styles.dropdownItem}
                  onClick={() => {
                    editor.dispatchCommand(INDENT_CONTENT_COMMAND, undefined);
                    setActiveDropdown(null);
                  }}
                >
                  <TextIndentIncrease20Regular />
                  <span>Indent</span>
                </button>
              </div>
            )}
          </div>
        )}

        {/* Overflow Menu */}
        {overflowItems.length > 0 && (
          <>
            <div className={styles.divider} />
            <div className={styles.dropdownContainer}>
              <button
                type="button"
                className={styles.toolbarButton}
                onClick={() => toggleDropdown('overflow')}
                aria-label="More options"
                title="More options"
              >
                <MoreHorizontal20Regular />
              </button>
              {activeDropdown === 'overflow' && (
                <div className={styles.overflowMenu}>
                  {overflowItems.map((itemKey) => {
                    // Render overflow items based on their key
                    switch (itemKey) {
                      case 'undo':
                        return (
                          <button
                            key="undo"
                            type="button"
                            className={styles.overflowMenuItem}
                            onClick={() => {
                              editor.dispatchCommand(UNDO_COMMAND, undefined);
                              setActiveDropdown(null);
                            }}
                            disabled={!canUndo}
                          >
                            <ArrowUndo20Regular />
                            <span>Undo</span>
                          </button>
                        );
                      case 'redo':
                        return (
                          <button
                            key="redo"
                            type="button"
                            className={styles.overflowMenuItem}
                            onClick={() => {
                              editor.dispatchCommand(REDO_COMMAND, undefined);
                              setActiveDropdown(null);
                            }}
                            disabled={!canRedo}
                          >
                            <ArrowRedo20Regular />
                            <span>Redo</span>
                          </button>
                        );
                      case 'bold':
                        return (
                          <button
                            key="bold"
                            type="button"
                            className={styles.overflowMenuItem}
                            onClick={() => {
                              editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold');
                              setActiveDropdown(null);
                            }}
                          >
                            <TextBold20Regular />
                            <span>Bold</span>
                          </button>
                        );
                      case 'italic':
                        return (
                          <button
                            key="italic"
                            type="button"
                            className={styles.overflowMenuItem}
                            onClick={() => {
                              editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic');
                              setActiveDropdown(null);
                            }}
                          >
                            <TextItalic20Regular />
                            <span>Italic</span>
                          </button>
                        );
                      case 'underline':
                        return (
                          <button
                            key="underline"
                            type="button"
                            className={styles.overflowMenuItem}
                            onClick={() => {
                              editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline');
                              setActiveDropdown(null);
                            }}
                          >
                            <TextUnderline20Regular />
                            <span>Underline</span>
                          </button>
                        );
                      case 'code':
                        return (
                          <button
                            key="code"
                            type="button"
                            className={styles.overflowMenuItem}
                            onClick={() => {
                              editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'code');
                              setActiveDropdown(null);
                            }}
                          >
                            <Code20Regular />
                            <span>Code</span>
                          </button>
                        );
                      case 'link':
                        return (
                          <button
                            key="link"
                            type="button"
                            className={styles.overflowMenuItem}
                            onClick={() => {
                              insertLink();
                              setActiveDropdown(null);
                            }}
                          >
                            <Link20Regular />
                            <span>Link</span>
                          </button>
                        );
                      default:
                        return null;
                    }
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );

  if (!portalEl) {
    return null;
  }

  return createPortal(toolbar, portalEl);
};
