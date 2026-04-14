import * as React from 'react';

import styles from './RecordingIndicator.module.css';

interface RecordingIndicatorProps {
  isRecording: boolean;
}

const formatTime = (totalSeconds: number): string => {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

export const RecordingIndicator: React.FC<RecordingIndicatorProps> = ({ isRecording }) => {
  const [elapsedSeconds, setElapsedSeconds] = React.useState(0);
  const startTimeRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    if (isRecording) {
      startTimeRef.current = Date.now();
      setElapsedSeconds(0);

      const interval = setInterval(() => {
        if (startTimeRef.current) {
          const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
          setElapsedSeconds(elapsed);
        }
      }, 1000);

      return () => {
        clearInterval(interval);
      };
    } else {
      startTimeRef.current = null;
      setElapsedSeconds(0);
    }
  }, [isRecording]);

  if (!isRecording) {
    return null;
  }

  return (
    <div className={styles.indicator}>
      <span className={styles.dot} />
      <span className={styles.time}>{formatTime(elapsedSeconds)}</span>
    </div>
  );
};
