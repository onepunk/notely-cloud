import * as React from 'react';

import styles from './ModalLayout.module.css';

export const ModalLayout: React.FC<{ nav: React.ReactNode; children: React.ReactNode }> = ({
  nav,
  children,
}) => {
  return (
    <div className={styles.grid}>
      <aside className={styles.nav}>{nav}</aside>
      <section className={styles.content}>{children}</section>
    </div>
  );
};
