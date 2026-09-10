'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Download, Pause, Play } from 'lucide-react';
import { useT } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface AudioMessagePlayerProps {
  src: string;
  isOutbound?: boolean;
  fileName?: string | null;
  className?: string;
}

const SPEEDS = [1, 1.5, 2] as const;

function formatSeconds(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
}

export function AudioMessagePlayer({
  src,
  isOutbound = false,
  fileName,
  className,
}: AudioMessagePlayerProps) {
  const { t } = useT();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(0);
  const [hasError, setHasError] = useState(false);
  const currentSpeed = SPEEDS[speedIndex];

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    setCurrentTime(0);
    setDuration(0);
    setIsPlaying(false);
    setHasError(false);

    const onLoadedMetadata = () => {
      setDuration(Number.isFinite(audio.duration) ? audio.duration : 0);
      setHasError(false);
    };
    const onTimeUpdate = () => setCurrentTime(audio.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      audio.currentTime = 0;
      setCurrentTime(0);
      setIsPlaying(false);
    };
    const onError = () => {
      setHasError(true);
      setIsPlaying(false);
    };

    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    return () => {
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, [src]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
      return;
    }
    void audio
      .play()
      .then(() => setIsPlaying(true))
      .catch(() => setHasError(true));
  };

  const cycleSpeed = () => {
    const nextIndex = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(nextIndex);
    if (audioRef.current) audioRef.current.playbackRate = SPEEDS[nextIndex];
  };

  const handleSeek = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextTime = Number(event.target.value);
    setCurrentTime(nextTime);
    if (audioRef.current) audioRef.current.currentTime = nextTime;
  };

  if (hasError) {
    return (
      <div
        className={cn(
          'my-1 flex max-w-full items-center gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive',
          className,
        )}
      >
        <AlertCircle className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t('تعذر تشغيل التسجيل الصوتي')}</span>
        <a
          href={src}
          download={fileName || 'audio.ogg'}
          target="_blank"
          rel="noopener noreferrer"
          className="flex shrink-0 items-center gap-1 rounded bg-destructive/20 px-2 py-1 font-medium transition-colors hover:bg-destructive/30"
        >
          <Download className="size-3" aria-hidden />
          {t('تنزيل')}
        </a>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'my-1 flex w-[min(280px,calc(100vw-6rem))] max-w-full select-none flex-col gap-1.5 rounded-md p-2.5',
        isOutbound
          ? 'bg-primary-foreground/15 text-primary-foreground'
          : 'border border-border/60 bg-muted/70 text-foreground',
        className,
      )}
    >
      <audio ref={audioRef} src={src} preload="metadata" aria-hidden />

      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={togglePlay}
          aria-label={
            isPlaying ? t('إيقاف التسجيل الصوتي مؤقتاً') : t('تشغيل التسجيل الصوتي')
          }
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-full shadow-sm transition-transform active:scale-95',
            isOutbound
              ? 'bg-white text-primary hover:bg-white/90'
              : 'bg-primary text-primary-foreground hover:bg-primary/90',
          )}
        >
          {isPlaying ? (
            <Pause className="size-4 fill-current" aria-hidden />
          ) : (
            <Play className="ms-0.5 size-4 fill-current" aria-hidden />
          )}
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <input
            type="range"
            min={0}
            max={duration || 1}
            step={0.1}
            value={Math.min(currentTime, duration || 1)}
            onChange={handleSeek}
            aria-label={t('موقع الصوت')}
            aria-valuetext={`${formatSeconds(currentTime)} / ${formatSeconds(duration)}`}
            className={cn(
              'h-1.5 w-full cursor-pointer appearance-none rounded-full outline-none',
              isOutbound ? 'bg-white/30 accent-white' : 'bg-primary/20 accent-primary',
            )}
          />
          <div className="flex items-center justify-between font-mono text-micro opacity-85">
            <span dir="ltr">{formatSeconds(currentTime)}</span>
            <span dir="ltr">{formatSeconds(duration)}</span>
          </div>
        </div>

        <button
          type="button"
          onClick={cycleSpeed}
          title={t('تغيير سرعة التشغيل')}
          aria-label={t('تغيير سرعة التشغيل')}
          className={cn(
            'flex h-7 shrink-0 items-center justify-center rounded-md px-2 font-mono text-micro font-bold transition-colors',
            isOutbound
              ? 'bg-white/20 text-white hover:bg-white/30'
              : 'border border-border/80 bg-background text-foreground hover:bg-accent',
          )}
        >
          {currentSpeed}x
        </button>
      </div>
    </div>
  );
}
