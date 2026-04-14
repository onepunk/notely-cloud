import { Spinner, Tooltip } from '@fluentui/react-components';
import {
  Play20Regular,
  Pause20Regular,
  Speaker220Regular,
  SpeakerMute20Regular,
} from '@fluentui/react-icons';
import * as React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useSettingsStore } from '../../../shared/state/settings.store';
import { useTranscriptionStore } from '../model/transcription.store';

import styles from './AudioPlayer.module.css';

const OUTPUT_DEVICE_KEY = 'system.audio.outputDeviceId';

type Props = {
  sessionId: string;
};

/**
 * Format milliseconds to MM:SS display
 */
function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export const AudioPlayer: React.FC<Props> = ({ sessionId }) => {
  const audioRef = useRef<HTMLAudioElement>(null);
  const seekThrottleRef = useRef<number | null>(null);

  const audioPlayer = useTranscriptionStore((s) => s.audioPlayer);
  const loadAudio = useTranscriptionStore((s) => s.loadAudio);
  const setAudioPlaying = useTranscriptionStore((s) => s.setAudioPlaying);
  const seekAudioTo = useTranscriptionStore((s) => s.seekAudioTo);
  const setAudioVolume = useTranscriptionStore((s) => s.setAudioVolume);
  const setAudioMuted = useTranscriptionStore((s) => s.setAudioMuted);
  const updateAudioCurrentTime = useTranscriptionStore((s) => s.updateAudioCurrentTime);

  // Get output device from settings
  const settingsValues = useSettingsStore((s) => s.values);
  const outputDeviceId = settingsValues[OUTPUT_DEVICE_KEY] || '';

  const { isPlaying, currentTimeMs, durationMs, volume, isMuted, filePath, isLoading } =
    audioPlayer;

  // Load audio when sessionId changes
  useEffect(() => {
    if (sessionId) {
      loadAudio(sessionId);
    }
  }, [sessionId, loadAudio]);

  // Set output device when it changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // setSinkId is available on HTMLMediaElement in modern browsers
    const audioWithSink = audio as HTMLAudioElement & {
      setSinkId?: (sinkId: string) => Promise<void>;
    };

    if (audioWithSink.setSinkId && outputDeviceId) {
      audioWithSink.setSinkId(outputDeviceId).catch((err) => {
        console.warn('Failed to set audio output device:', err);
      });
    }
  }, [outputDeviceId, filePath]);

  // Sync audio element with store state
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !filePath) return;

    if (isPlaying && audio.paused) {
      audio.play().catch(console.error);
    } else if (!isPlaying && !audio.paused) {
      audio.pause();
    }
  }, [isPlaying, filePath]);

  // Sync volume
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = isMuted ? 0 : volume;
  }, [volume, isMuted]);

  // Handle seek from store (e.g., clicking timestamp)
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !filePath) return;

    const targetTime = currentTimeMs / 1000;
    // Only seek if difference is significant (avoid feedback loops)
    if (Math.abs(audio.currentTime - targetTime) > 0.5) {
      audio.currentTime = targetTime;
    }
  }, [currentTimeMs, filePath]);

  // Handle time update from audio element (throttled)
  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;

    // Throttle updates to ~4Hz
    if (seekThrottleRef.current) return;
    seekThrottleRef.current = window.setTimeout(() => {
      seekThrottleRef.current = null;
    }, 250);

    updateAudioCurrentTime(Math.round(audio.currentTime * 1000));
  }, [updateAudioCurrentTime]);

  // Handle audio ended
  const handleEnded = useCallback(() => {
    setAudioPlaying(false);
    seekAudioTo(0);
  }, [setAudioPlaying, seekAudioTo]);

  // Handle play/pause toggle
  const handlePlayPause = useCallback(() => {
    setAudioPlaying(!isPlaying);
  }, [isPlaying, setAudioPlaying]);

  // Handle seek bar change
  const handleSeekChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newTime = parseInt(e.target.value, 10);
      seekAudioTo(newTime);
      // Also update audio element immediately
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = newTime / 1000;
      }
    },
    [seekAudioTo]
  );

  // Handle volume change
  const handleVolumeChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newVolume = parseFloat(e.target.value);
      setAudioVolume(newVolume);
      if (isMuted && newVolume > 0) {
        setAudioMuted(false);
      }
    },
    [setAudioVolume, setAudioMuted, isMuted]
  );

  // Handle mute toggle
  const handleMuteToggle = useCallback(() => {
    setAudioMuted(!isMuted);
  }, [isMuted, setAudioMuted]);

  // Volume popup state
  const [showVolumePopup, setShowVolumePopup] = useState(false);
  const volumePopupRef = useRef<HTMLDivElement>(null);
  const volumeButtonRef = useRef<HTMLButtonElement>(null);

  // Close volume popup when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        showVolumePopup &&
        volumePopupRef.current &&
        volumeButtonRef.current &&
        !volumePopupRef.current.contains(e.target as Node) &&
        !volumeButtonRef.current.contains(e.target as Node)
      ) {
        setShowVolumePopup(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showVolumePopup]);

  const handleVolumeButtonClick = useCallback(() => {
    setShowVolumePopup((prev) => !prev);
  }, []);

  // If no file path and not loading, don't render
  if (!isLoading && !filePath) {
    return null;
  }

  // Loading state
  if (isLoading) {
    return (
      <div className={styles.audioPlayer}>
        <div className={styles.loadingContainer}>
          <Spinner size="tiny" />
          <span className={styles.loadingText}>Loading recording...</span>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.audioPlayer}>
      {/* Hidden audio element */}
      <audio
        ref={audioRef}
        src={filePath ? `file://${filePath}` : undefined}
        onTimeUpdate={handleTimeUpdate}
        onEnded={handleEnded}
        onLoadedMetadata={() => {
          const audio = audioRef.current;
          if (audio && audio.duration) {
            // Update duration if not set from metadata
            if (!durationMs) {
              updateAudioCurrentTime(0);
            }
          }
        }}
      />

      {/* Play/Pause button */}
      <Tooltip content={isPlaying ? 'Pause' : 'Play'} relationship="label">
        <button
          type="button"
          className={styles.controlButton}
          onClick={handlePlayPause}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? <Pause20Regular /> : <Play20Regular />}
        </button>
      </Tooltip>

      {/* Current time */}
      <span className={styles.timeDisplay}>{formatTime(currentTimeMs)}</span>

      {/* Seek bar */}
      <input
        type="range"
        className={styles.seekBar}
        min={0}
        max={durationMs || 0}
        value={currentTimeMs}
        onChange={handleSeekChange}
        aria-label="Seek"
        style={
          {
            '--progress': `${durationMs > 0 ? (currentTimeMs / durationMs) * 100 : 0}%`,
          } as React.CSSProperties
        }
      />

      {/* Duration */}
      <span className={styles.timeDisplay}>{formatTime(durationMs)}</span>

      {/* Volume control with popup */}
      <div className={styles.volumeControl}>
        <Tooltip content={isMuted ? 'Unmute' : 'Volume'} relationship="label">
          <button
            ref={volumeButtonRef}
            type="button"
            className={styles.controlButton}
            onClick={handleVolumeButtonClick}
            onDoubleClick={handleMuteToggle}
            aria-label={isMuted ? 'Unmute' : 'Volume'}
          >
            {isMuted || volume === 0 ? <SpeakerMute20Regular /> : <Speaker220Regular />}
          </button>
        </Tooltip>
        {showVolumePopup && (
          <div ref={volumePopupRef} className={styles.volumePopup}>
            <input
              type="range"
              className={styles.volumeBarVertical}
              min={0}
              max={1}
              step={0.01}
              value={isMuted ? 0 : volume}
              onChange={handleVolumeChange}
              aria-label="Volume"
              style={
                {
                  '--volume-progress': `${(isMuted ? 0 : volume) * 100}%`,
                } as React.CSSProperties
              }
            />
          </div>
        )}
      </div>
    </div>
  );
};
