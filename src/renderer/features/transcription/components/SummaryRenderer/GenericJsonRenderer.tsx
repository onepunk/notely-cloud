/**
 * GenericJsonRenderer - Fallback renderer for unknown schemas
 *
 * Intelligently renders any JSON structure with:
 * - Automatic type detection (arrays, objects, primitives)
 * - Human-readable key formatting
 * - Collapsible sections for nested data
 * - Clean, accessible styling
 *
 * This serves as the fallback for:
 * - Custom user templates not yet supported
 * - Future schema versions
 * - Unexpected data structures
 */

import * as React from 'react';

import { isEmptyValue } from '../../types/summary';

import styles from './SummaryRenderer.module.css';

interface GenericJsonRendererProps {
  data: Record<string, unknown>;
  showHeaders?: boolean;
  compact?: boolean;
  className?: string;
  /** Depth level for nested rendering */
  depth?: number;
  /** Parent key for context */
  _parentKey?: string;
}

/**
 * Convert a camelCase or snake_case key to a human-readable label
 */
function formatKey(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (str) => str.toUpperCase())
    .trim();
}

/**
 * Determine the best way to render a value based on its type
 */
type RenderType = 'text' | 'list' | 'object' | 'chips' | 'empty';

function determineRenderType(value: unknown): RenderType {
  if (isEmptyValue(value)) return 'empty';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return 'text';
  }
  if (Array.isArray(value)) {
    // Array of primitives -> chips, array of objects -> list
    if (value.length > 0 && typeof value[0] === 'object') {
      return 'list';
    }
    return 'chips';
  }
  if (typeof value === 'object') {
    return 'object';
  }
  return 'text';
}

export const GenericJsonRenderer: React.FC<GenericJsonRendererProps> = ({
  data,
  showHeaders = true,
  compact = false,
  className,
  depth = 0,
  _parentKey,
}) => {
  const containerClass = `${styles.container} ${styles.genericContainer} ${compact ? styles.compact : ''} ${className || ''}`;

  // Get all keys, filtering out internal/meta keys
  const keys = Object.keys(data).filter((key) => !key.startsWith('_') && !isEmptyValue(data[key]));

  if (keys.length === 0) {
    return <div className={`${styles.empty} ${className || ''}`}>No data to display</div>;
  }

  return (
    <div className={containerClass} style={{ '--depth': depth } as React.CSSProperties}>
      {keys.map((key) => {
        const value = data[key];
        const renderType = determineRenderType(value);
        const label = formatKey(key);

        if (renderType === 'empty') return null;

        return (
          <GenericSection
            key={key}
            _fieldKey={key}
            label={label}
            value={value}
            renderType={renderType}
            showHeader={showHeaders}
            compact={compact}
            depth={depth}
          />
        );
      })}
    </div>
  );
};

// ============================================================================
// Generic Section Component
// ============================================================================

interface GenericSectionProps {
  _fieldKey: string;
  label: string;
  value: unknown;
  renderType: RenderType;
  showHeader?: boolean;
  compact?: boolean;
  depth: number;
}

const GenericSection: React.FC<GenericSectionProps> = ({
  _fieldKey,
  label,
  value,
  renderType,
  showHeader = true,
  compact = false,
  depth,
}) => {
  const [isCollapsed, setIsCollapsed] = React.useState(depth > 1);

  // Skip rendering if empty
  if (renderType === 'empty') return null;

  const canCollapse = renderType === 'object' || renderType === 'list';

  return (
    <div className={`${styles.section} ${styles.genericSection}`}>
      {showHeader && (
        <div
          className={`${styles.sectionHeader} ${styles.genericHeader} ${canCollapse ? styles.collapsible : ''}`}
          onClick={() => canCollapse && setIsCollapsed(!isCollapsed)}
        >
          {canCollapse && (
            <span className={`${styles.collapseIcon} ${isCollapsed ? styles.collapsed : ''}`}>
              <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 6l4 4 4-4H4z" />
              </svg>
            </span>
          )}
          <h3 className={styles.sectionTitle}>{label}</h3>
          {renderType === 'list' && Array.isArray(value) && (
            <span className={styles.sectionCount}>{value.length}</span>
          )}
        </div>
      )}

      {!isCollapsed && (
        <div className={styles.sectionContent}>
          <GenericValue value={value} renderType={renderType} compact={compact} depth={depth} />
        </div>
      )}
    </div>
  );
};

// ============================================================================
// Generic Value Renderer
// ============================================================================

interface GenericValueProps {
  value: unknown;
  renderType: RenderType;
  compact?: boolean;
  depth: number;
}

const GenericValue: React.FC<GenericValueProps> = ({ value, renderType, compact, depth }) => {
  switch (renderType) {
    case 'text':
      return <p className={styles.genericText}>{String(value)}</p>;

    case 'chips':
      return (
        <div className={styles.genericChips}>
          {(value as unknown[]).map((item, index) => (
            <span key={index} className={styles.genericChip}>
              {String(item)}
            </span>
          ))}
        </div>
      );

    case 'list':
      return (
        <ul className={styles.genericList}>
          {(value as unknown[]).map((item, index) => (
            <li key={index} className={styles.genericListItem}>
              {typeof item === 'object' && item !== null ? (
                <GenericJsonRenderer
                  data={item as Record<string, unknown>}
                  showHeaders={false}
                  compact={compact}
                  depth={depth + 1}
                />
              ) : (
                <span>{String(item)}</span>
              )}
            </li>
          ))}
        </ul>
      );

    case 'object':
      return (
        <GenericJsonRenderer
          data={value as Record<string, unknown>}
          showHeaders={true}
          compact={compact}
          depth={depth + 1}
        />
      );

    default:
      return <span className={styles.genericText}>{String(value)}</span>;
  }
};

export default GenericJsonRenderer;
