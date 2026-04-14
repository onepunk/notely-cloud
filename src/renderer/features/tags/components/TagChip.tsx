import { Tooltip } from '@fluentui/react-components';
import { Dismiss12Regular } from '@fluentui/react-icons';
import * as React from 'react';

import type { Tag } from '../types';

import styles from './TagChip.module.css';

type TagChipProps = {
  tag: Tag;
  onClick?: () => void;
  onRemove?: () => void;
  showRemove?: boolean;
};

export const TagChip: React.FC<TagChipProps> = ({ tag, onClick, onRemove, showRemove = false }) => {
  const handleRemoveClick = React.useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onRemove?.();
    },
    [onRemove]
  );

  const chipContent = (
    <span
      className={`${styles.chip} ${onClick ? styles['chip-clickable'] : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={
        onClick
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onClick();
              }
            }
          : undefined
      }
    >
      {tag.color && <span className={styles['color-dot']} style={{ backgroundColor: tag.color }} />}
      <span className={styles.name}>{tag.name}</span>
      {showRemove && onRemove && (
        <button
          type="button"
          className={styles['remove-button']}
          onClick={handleRemoveClick}
          aria-label={`Remove tag ${tag.name}`}
        >
          <Dismiss12Regular />
        </button>
      )}
    </span>
  );

  // Show tooltip if tag name is potentially truncated
  if (tag.name.length > 12) {
    return (
      <Tooltip content={tag.name} relationship="label">
        {chipContent}
      </Tooltip>
    );
  }

  return chipContent;
};
