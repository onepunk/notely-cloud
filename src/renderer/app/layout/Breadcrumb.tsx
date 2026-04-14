import { ChevronRight12Regular } from '@fluentui/react-icons';
import { FolderClosed } from 'lucide-react';
import * as React from 'react';
import { useNavigate } from 'react-router-dom';

import styles from './Breadcrumb.module.css';

export interface BreadcrumbItem {
  label: string;
  path?: string;
}

interface BreadcrumbProps {
  items: BreadcrumbItem[];
  binderName?: string | null;
  onBinderClick?: () => void;
  onGoHome?: () => string;
}

export const Breadcrumb: React.FC<BreadcrumbProps> = ({
  items,
  binderName,
  onBinderClick,
  onGoHome,
}) => {
  const navigate = useNavigate();

  const handleBinderClick = React.useCallback(() => {
    if (onBinderClick) {
      onBinderClick();
    } else if (onGoHome) {
      const route = onGoHome();
      navigate(route);
    } else {
      navigate('/');
    }
  }, [navigate, onBinderClick, onGoHome]);

  const handleItemClick = React.useCallback(
    (path?: string) => {
      if (path) {
        navigate(path);
      }
    },
    [navigate]
  );

  // Always show the binder button (even with no items)
  const displayName = binderName || 'Home';

  return (
    <nav className={styles.breadcrumb} aria-label="Breadcrumb">
      {items.length > 0 &&
        items.map((item, index) => (
          <React.Fragment key={index}>
            {index > 0 && <ChevronRight12Regular className={styles.separator} />}
            {item.path && index < items.length - 1 ? (
              <button
                type="button"
                className={styles.link}
                onClick={() => handleItemClick(item.path)}
              >
                {item.label}
              </button>
            ) : (
              <span className={styles.current}>{item.label}</span>
            )}
          </React.Fragment>
        ))}
    </nav>
  );
};
