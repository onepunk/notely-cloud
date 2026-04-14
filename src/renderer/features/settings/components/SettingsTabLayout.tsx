import * as React from 'react';

import styles from './SettingsTabLayout.module.css';

type ClassValue = string | null | undefined | false;

const mergeClassNames = (...values: ClassValue[]) => values.filter(Boolean).join(' ');

type SettingsTabLayoutProps = {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
};

export const SettingsTabLayout: React.FC<SettingsTabLayoutProps> = ({
  title,
  description,
  actions,
  meta,
  children,
}) => (
  <div className={styles.page}>
    <header className={styles.header}>
      <div className={styles.headerText}>
        <span className={styles.headerTitle}>{title}</span>
        {description ? <span className={styles.headerDescription}>{description}</span> : null}
        {meta ? <div className={styles.headerMeta}>{meta}</div> : null}
      </div>
      {actions ? <div className={styles.headerActions}>{actions}</div> : null}
    </header>
    <div className={styles.sections}>{children}</div>
  </div>
);

type SettingsSectionProps = {
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
};

export const SettingsSection: React.FC<SettingsSectionProps> = ({
  title,
  description,
  action,
  footer,
  children,
  className,
  bodyClassName,
}) => (
  <section className={mergeClassNames(styles.section, className)}>
    <div className={styles.sectionHeader}>
      <div className={styles.sectionHeaderText}>
        <span className={styles.sectionTitle}>{title}</span>
        {description ? <span className={styles.sectionDescription}>{description}</span> : null}
      </div>
      {action ? <div className={styles.sectionActions}>{action}</div> : null}
    </div>
    <div className={mergeClassNames(styles.sectionBody, bodyClassName)}>{children}</div>
    {footer ? <div className={styles.sectionFooter}>{footer}</div> : null}
  </section>
);

type SettingsCardProps = {
  title: string;
  description?: React.ReactNode;
  footer?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  tone?: 'default' | 'danger';
  className?: string;
};

export const SettingsCard: React.FC<SettingsCardProps> = ({
  title,
  description,
  footer,
  actions,
  children,
  tone = 'default',
  className,
}) => (
  <article
    className={mergeClassNames(styles.card, tone === 'danger' ? styles.cardDanger : '', className)}
  >
    <div className={styles.cardHeader}>
      <span className={styles.cardTitle}>{title}</span>
      {description ? <span className={styles.cardDescription}>{description}</span> : null}
    </div>
    {actions ? <div className={styles.inlineActions}>{actions}</div> : null}
    <div className={styles.cardBody}>{children}</div>
    {footer ? <div className={styles.cardFooter}>{footer}</div> : null}
  </article>
);

export const SettingsInlineActions: React.FC<React.PropsWithChildren> = ({ children }) => (
  <div className={styles.inlineActions}>{children}</div>
);
