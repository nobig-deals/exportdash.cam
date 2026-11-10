'use client';

import { useRef, useEffect, useState, useCallback, lazy, Suspense, ReactNode, useMemo } from 'react';
import { useSeiData } from '@/hooks/useSeiData';
import { TelemetryCard } from './TelemetryCard';
import { VideoSequence, ANGLE_LABELS, ANGLE_ORDER, VideoMoment, TrimPoints, CameraSegment, LayoutCameraConfig, DEFAULT_LAYOUT_CONFIG, loadLayoutConfig, saveLayoutConfig, FormatType, FORMAT_PRESETS, getFormatPreset, PortraitLayoutType, PortraitCameraConfig, PORTRAIT_LAYOUTS, getPortraitLayout, loadPortraitLayout, savePortraitLayout, loadPortraitCameraConfig, savePortraitCameraConfig, DEFAULT_PORTRAIT_CAMERA_CONFIG, AlignPosition, PortraitAlignConfig, DEFAULT_PORTRAIT_ALIGN_CONFIG, loadPortraitAlignConfig, savePortraitAlignConfig } from '@/types/video';
import { findMomentForTime, toAbsoluteTime } from '@/lib/sequence-detector';
import {
  IconArrowUp,
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUpLeft,
  IconArrowUpRight,
  IconSquare,
  IconPictureInPicture,
  IconColumns3,
  IconLayoutGrid,
  IconBolt,
  IconMapPin,
  IconMaximize,
  IconMinimize,
  IconPlayerPlay,
  IconPlayerPause,
  IconRewindBackward15,
  IconRewindForward15,
  IconPlayerSkipBack,
  IconPlayerSkipForward,
  IconList,
  IconPlus,
  IconTrash,
  IconChevronDown,
  IconCheck,
  IconScissors,
  IconWand,
  IconClock,
  IconSettings2,
  IconAspectRatio,
  IconBrandTiktok,
  IconBrandInstagram,
  IconBrandX,
  IconBrandYoutube,
} from '@tabler/icons-react';
import { VideoExporter } from './VideoExporter';
import { LayoutConfigPopover } from './LayoutConfigPopover';
import { PortraitCameraSelector } from './PortraitCameraSelector';
import { TelemetryTimeline } from './TelemetryTimeline';
import { Tooltip } from './Tooltip';

// Lazy load MapView to avoid SSR issues with Leaflet
const MapView = lazy(() => import('./MapView').then(mod => ({ default: mod.MapView })));

interface VideoPlayerProps {
  sequences: VideoSequence[];
  selectedSequence: VideoSequence | null;
  onSelectSequence: (sequence: VideoSequence) => void;
  onClear: () => void;
  onAddFiles: (files: File[]) => void;
}

const ANGLE_ICONS: Record<string, ReactNode> = {
  front: <IconArrowUp size={14} />,
  back: <IconArrowDown size={14} />,
  left_repeater: <IconArrowLeft size={14} />,
  right_repeater: <IconArrowRight size={14} />,
  left_pillar: <IconArrowUpLeft size={14} />,
  right_pillar: <IconArrowUpRight size={14} />,
};

const FORMAT_ICONS: Record<string, ReactNode> = {
  original: <IconAspectRatio size={14} />,
  tiktok: <IconBrandTiktok size={14} />,
  instagram: <IconBrandInstagram size={14} />,
  'instagram-story': <IconBrandInstagram size={14} />,
  twitter: <IconBrandX size={14} />,
  'youtube-shorts': <IconBrandYoutube size={14} />,
};

type LayoutType = 'single' | 'pip' | 'triple' | 'all';

interface LayoutConfig {
  id: LayoutType;
  label: string;
  icon: ReactNode;
  description: string;
}

const LAYOUTS: LayoutConfig[] = [
  {
    id: 'single',
    label: 'Single',
    icon: <IconSquare size={14} />,
    description: 'One camera',
  },
  {
    id: 'pip',
    label: 'PiP',
    icon: <IconPictureInPicture size={14} />,
    description: 'Main + corners',
  },
  {
    id: 'triple',
    label: 'Triple',
    icon: <IconColumns3 size={14} />,
    description: 'Front + sides',
  },
  {
    id: 'all',
    label: 'All 6',
    icon: <IconLayoutGrid size={14} />,
    description: 'All cameras',
  },
];

function loadOverlayConfig(): Record<string, unknown> {
  try {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('exportdash-overlay-config') : null;
    if (saved) {
      const parsed: unknown = JSON.parse(saved);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  } catch { /* ignore corrupt localStorage */ }
  return {};
}

export function VideoPlayer({
  sequences,
  selectedSequence: sequence,
  onSelectSequence,
  onClear,
  onAddFiles,
}: VideoPlayerProps) {
  const [showSequenceMenu, setShowSequenceMenu] = useState(false);
  const mainVideoRef = useRef<HTMLVideoElement>(null);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);

  // Playback state
  const [selectedAngle, setSelectedAngle] = useState<string>('front');
  const [layout, setLayout] = useState<LayoutType>('single');
  const [currentMomentIndex, setCurrentMomentIndex] = useState(0);
  const [localTime, setLocalTime] = useState(0);  // Time within current clip
  const [isPlaying, setIsPlaying] = useState(false);

  // Read overlay config once from localStorage for all initial states
  const [initConfig] = useState(loadOverlayConfig);

  const [speedUnit, setSpeedUnit] = useState<'mph' | 'kmh'>(
    initConfig.speedUnit === 'mph' || initConfig.speedUnit === 'kmh' ? initConfig.speedUnit : 'mph'
  );
  const [playbackRate, setPlaybackRate] = useState(1);
  const [showMap, setShowMap] = useState<boolean>(
    typeof initConfig.showMap === 'boolean' ? initConfig.showMap : true
  );
  const [showTelemetry, setShowTelemetry] = useState<boolean>(
    typeof initConfig.showTelemetry === 'boolean' ? initConfig.showTelemetry : true
  );
  const [showDateTime, setShowDateTime] = useState<boolean>(
    typeof initConfig.showDateTime === 'boolean' ? initConfig.showDateTime : true
  );

  // Persist overlay toggle states to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('exportdash-overlay-config', JSON.stringify({
        showTelemetry,
        showMap,
        showDateTime,
        speedUnit,
      }));
    } catch { /* ignore localStorage write errors */ }
  }, [showTelemetry, showMap, showDateTime, speedUnit]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [videoAspectRatio, setVideoAspectRatio] = useState<number | null>(null);
  const [isTimelineDragging, setIsTimelineDragging] = useState(false);

  // Format presets
  const [format, setFormat] = useState<FormatType>('original');
  const [showSafeZones, setShowSafeZones] = useState(false);
  const formatPreset = useMemo(() => getFormatPreset(format), [format]);
  const isPortraitFormat = formatPreset.aspectRatio > 0 && formatPreset.aspectRatio < 1;
  // Camera track only drives Single and PiP layouts in landscape formats
  const cameraTrackActive = !isPortraitFormat && (layout === 'single' || layout === 'pip');

  // Layout camera config
  const [layoutConfig, setLayoutConfig] = useState<LayoutCameraConfig>(DEFAULT_LAYOUT_CONFIG);
  const [showLayoutConfig, setShowLayoutConfig] = useState(false);

  // Portrait layout state
  const [portraitLayout, setPortraitLayout] = useState<PortraitLayoutType>('p-1-2');
  const [portraitCameraConfig, setPortraitCameraConfig] = useState<PortraitCameraConfig>({ ...DEFAULT_PORTRAIT_CAMERA_CONFIG });
  const [portraitAlignConfig, setPortraitAlignConfig] = useState<PortraitAlignConfig>({ ...DEFAULT_PORTRAIT_ALIGN_CONFIG });

  // Load layout config from localStorage on mount
  useEffect(() => {
    setLayoutConfig(loadLayoutConfig());
    setPortraitLayout(loadPortraitLayout());
    setPortraitCameraConfig(loadPortraitCameraConfig());
    setPortraitAlignConfig(loadPortraitAlignConfig());
  }, []);

  const handleLayoutConfigChange = useCallback((newConfig: LayoutCameraConfig) => {
    setLayoutConfig(newConfig);
    saveLayoutConfig(newConfig);
  }, []);

  const handlePortraitLayoutChange = useCallback((newLayout: PortraitLayoutType) => {
    setPortraitLayout(newLayout);
    savePortraitLayout(newLayout);
  }, []);

  const handlePortraitSlotChange = useCallback((slotIdx: number, newAngle: string) => {
    setPortraitCameraConfig(prev => {
      const slots = [...(prev[portraitLayout] || [])];
      // If the newAngle is already assigned to another slot, swap
      const existingIdx = slots.indexOf(newAngle);
      if (existingIdx !== -1 && existingIdx !== slotIdx) {
        slots[existingIdx] = slots[slotIdx];
      }
      slots[slotIdx] = newAngle;
      const updated = { ...prev, [portraitLayout]: slots };
      savePortraitCameraConfig(updated);
      return updated;
    });
  }, [portraitLayout]);

  const handlePortraitAlignChange = useCallback((slotIdx: number, align: AlignPosition) => {
    setPortraitAlignConfig(prev => {
      const slots = [...(prev[portraitLayout] || [])];
      slots[slotIdx] = align;
      const updated = { ...prev, [portraitLayout]: slots };
      savePortraitAlignConfig(updated);
      return updated;
    });
  }, [portraitLayout]);

  // Edit mode state
  const [isEditMode, setIsEditMode] = useState(false);
  const [isTrimming, setIsTrimming] = useState(false); // When true, show full timeline for trim adjustment
  const [trimPoints, setTrimPoints] = useState<TrimPoints | null>(null);
  const [cameraSegments, setCameraSegments] = useState<CameraSegment[]>([]);
  const [useCustomCameraTrack, setUseCustomCameraTrack] = useState(false);

  // Check if camera track has been customized (more than one segment)
  const hasCustomCameraTrack = useMemo(() => {
    return cameraSegments.length > 1;
  }, [cameraSegments]);

  // Video URL management
  const [videoUrls, setVideoUrls] = useState<Record<string, string>>({});
  const [preloadedUrls, setPreloadedUrls] = useState<Record<string, string>>({});

  // Current moment from sequence
  const currentMoment = sequence?.moments[currentMomentIndex] || null;

  // Calculate absolute time and total duration
  const absoluteTime = useMemo(() => {
    if (!sequence) return 0;
    return toAbsoluteTime(sequence, currentMomentIndex, localTime);
  }, [sequence, currentMomentIndex, localTime]);

  const totalDuration = sequence?.totalDuration || 0;

  // Get the main video file for SEI data
  const mainVideo = currentMoment?.videos.find(v => v.angle === 'front') || currentMoment?.videos[0];

  const { seiData, isLoading, error, allSeiMessages, fps } = useSeiData(
    sequence,
    currentMomentIndex,
    absoluteTime
  );

  // Map SEI data with event.json GPS fallback
  const mapSeiData = useMemo(() => {
    if (seiData?.latitude_deg && seiData?.longitude_deg) return seiData;
    if (sequence?.event?.est_lat && sequence?.event?.est_lon) {
      return { ...(seiData || {}), latitude_deg: sequence.event.est_lat, longitude_deg: sequence.event.est_lon } as typeof seiData;
    }
    return seiData;
  }, [seiData, sequence?.event]);

  // Reset state when sequence changes
  useEffect(() => {
    if (sequence && sequence.moments.length > 0) {
      setCurrentMomentIndex(0);
      setLocalTime(0);
      setIsPlaying(false);

      // Auto-select first available angle (prefer front)
      const firstMoment = sequence.moments[0];
      const frontVideo = firstMoment.videos.find(v => v.angle === 'front');
      const defaultAngle = frontVideo?.angle || firstMoment.videos[0]?.angle || 'front';
      setSelectedAngle(defaultAngle);

      // Reset edit mode state
      setIsEditMode(false);
      setIsTrimming(false);
      setTrimPoints({ inPoint: 0, outPoint: sequence.totalDuration });
      setCameraSegments([{ startTime: 0, endTime: sequence.totalDuration, angle: defaultAngle }]);
      setUseCustomCameraTrack(false);
    }
  }, [sequence?.id]);

  // Auto-enable custom camera track when user adds segments
  useEffect(() => {
    if (hasCustomCameraTrack && !useCustomCameraTrack) {
      setUseCustomCameraTrack(true);
    }
  }, [hasCustomCameraTrack, useCustomCameraTrack]);

  // Create object URLs for current moment's videos
  useEffect(() => {
    if (!currentMoment) {
      setVideoUrls({});
      return;
    }

    const urls: Record<string, string> = {};
    for (const video of currentMoment.videos) {
      urls[video.angle] = URL.createObjectURL(video.file);
    }
    setVideoUrls(urls);

    return () => {
      Object.values(urls).forEach(url => URL.revokeObjectURL(url));
    };
  }, [currentMoment?.id]);

  // Preload next moment's videos for seamless transition
  useEffect(() => {
    if (!sequence || currentMomentIndex >= sequence.moments.length - 1) {
      setPreloadedUrls({});
      return;
    }

    const nextMoment = sequence.moments[currentMomentIndex + 1];
    const urls: Record<string, string> = {};
    for (const video of nextMoment.videos) {
      urls[video.angle] = URL.createObjectURL(video.file);
    }
    setPreloadedUrls(urls);

    return () => {
      Object.values(urls).forEach(url => URL.revokeObjectURL(url));
    };
  }, [sequence?.id, currentMomentIndex]);

  // Sync all videos to main video time
  const syncVideos = useCallback((targetTime?: number) => {
    const mainTime = targetTime ?? mainVideoRef.current?.currentTime ?? 0;
    Object.entries(videoRefs.current).forEach(([angle, video]) => {
      if (video && angle !== selectedAngle && Math.abs(video.currentTime - mainTime) > 0.1) {
        video.currentTime = mainTime;
      }
    });
    if (targetTime !== undefined && mainVideoRef.current) {
      mainVideoRef.current.currentTime = targetTime;
      setLocalTime(targetTime);
    }
  }, [selectedAngle]);

  const handleTimeUpdate = useCallback(() => {
    if (mainVideoRef.current) {
      setLocalTime(mainVideoRef.current.currentTime);
      syncVideos();
    }
  }, [syncVideos]);

  // Handle video ended - auto-advance to next clip
  const handleVideoEnded = useCallback(() => {
    if (!sequence) return;

    if (currentMomentIndex < sequence.moments.length - 1) {
      // Advance to next clip
      setCurrentMomentIndex(prev => prev + 1);
      setLocalTime(0);
      // Will auto-play after new video loads
    } else {
      // End of sequence
      setIsPlaying(false);
    }
  }, [sequence, currentMomentIndex]);

  // A clip that plays to its end fires 'pause' right before 'ended' - keep
  // isPlaying so the next clip auto-plays after handleVideoEnded advances
  const handleMainPause = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    if (!e.currentTarget.ended) setIsPlaying(false);
  }, []);

  // Track playback state for restoring after layout/angle changes
  const pendingRestoreRef = useRef<{ time: number; playing: boolean } | null>(null);
  const shouldAutoPlayRef = useRef(false);

  const handleLoadedMetadata = useCallback(() => {
    if (mainVideoRef.current) {
      const { videoWidth, videoHeight } = mainVideoRef.current;
      if (videoWidth && videoHeight) {
        setVideoAspectRatio(videoWidth / videoHeight);
      }
      // Restore playback position if pending
      if (pendingRestoreRef.current) {
        const { time, playing } = pendingRestoreRef.current;
        mainVideoRef.current.currentTime = time;
        Object.values(videoRefs.current).forEach(v => {
          if (v) v.currentTime = time;
        });
        if (playing) {
          mainVideoRef.current.play().catch(() => {});
          Object.values(videoRefs.current).forEach(v => v?.play().catch(() => {}));
          setIsPlaying(true);
        }
        pendingRestoreRef.current = null;
      }

      // Auto-play after advancing to next clip
      if (shouldAutoPlayRef.current) {
        mainVideoRef.current.play().catch(() => {});
        Object.values(videoRefs.current).forEach(v => v?.play().catch(() => {}));
        setIsPlaying(true);
        shouldAutoPlayRef.current = false;
      }
    }
  }, []);

  // When moment index changes, check if we should auto-play
  useEffect(() => {
    if (isPlaying && currentMomentIndex > 0) {
      shouldAutoPlayRef.current = true;
    }
  }, [currentMomentIndex]);

  // Switch cameras based on camera segments (when custom track enabled)
  // Works both during playback AND when scrubbing timeline
  useEffect(() => {
    if (!cameraTrackActive || !useCustomCameraTrack || cameraSegments.length === 0) return;

    // Skip while a restore is pending — the video is remounting and localTime
    // may temporarily be 0, which would cause a false switch back
    if (pendingRestoreRef.current) return;

    // Find which segment the current time falls into
    const currentSegment = cameraSegments.find(
      seg => absoluteTime >= seg.startTime && absoluteTime < seg.endTime
    );

    if (currentSegment && currentSegment.angle !== selectedAngle) {
      // Save playback state before switching so video resumes after remount
      pendingRestoreRef.current = { time: localTime, playing: isPlaying };
      setSelectedAngle(currentSegment.angle);
    }
  }, [cameraTrackActive, useCustomCameraTrack, absoluteTime, cameraSegments, selectedAngle, localTime, isPlaying]);

  // Custom setters that preserve playback state
  const handleLayoutChange = useCallback((newLayout: LayoutType) => {
    if (newLayout === layout) return;
    pendingRestoreRef.current = { time: localTime, playing: isPlaying };
    setLayout(newLayout);
  }, [layout, localTime, isPlaying]);

  const handleAngleChange = useCallback((newAngle: string) => {
    if (newAngle === selectedAngle) return;
    pendingRestoreRef.current = { time: localTime, playing: isPlaying };
    setSelectedAngle(newAngle);
  }, [selectedAngle, localTime, isPlaying]);

  // Fullscreen handler
  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;

    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().then(() => {
        setIsFullscreen(true);
      }).catch(() => {});
    } else {
      document.exitFullscreen().then(() => {
        setIsFullscreen(false);
      }).catch(() => {});
    }
  }, []);

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // Toggle trim mode (scissors button) - enters edit mode if needed
  const toggleTrimMode = useCallback(() => {
    if (!isEditMode) {
      // Not in edit mode - enter edit mode AND start trimming
      setIsEditMode(true);
      setIsTrimming(true);
    } else if (isTrimming) {
      // Already trimming - exit edit mode entirely
      setIsEditMode(false);
      setIsTrimming(false);
    } else {
      // In edit mode but not trimming (on camera track) - start trimming
      setIsTrimming(true);
    }
  }, [isEditMode, isTrimming]);

  // Handle trim point changes
  const handleTrimChange = useCallback((newTrimPoints: TrimPoints) => {
    setTrimPoints(newTrimPoints);
  }, []);

  const togglePlay = useCallback(() => {
    if (mainVideoRef.current) {
      if (isPlaying) {
        mainVideoRef.current.pause();
        Object.values(videoRefs.current).forEach(v => v?.pause());
      } else {
        mainVideoRef.current.play();
        Object.values(videoRefs.current).forEach(v => v?.play().catch(() => {}));
      }
      setIsPlaying(!isPlaying);
    }
  }, [isPlaying]);

  // Seek to absolute time (handles cross-clip seeking)
  const seekToAbsoluteTime = useCallback((targetAbsoluteTime: number) => {
    if (!sequence) return;

    const clampedTime = Math.max(0, Math.min(targetAbsoluteTime, totalDuration));
    const { momentIndex, localTime: newLocalTime } = findMomentForTime(sequence, clampedTime);

    if (momentIndex !== currentMomentIndex) {
      // Need to change clips
      pendingRestoreRef.current = { time: newLocalTime, playing: isPlaying };
      setCurrentMomentIndex(momentIndex);
      setLocalTime(newLocalTime);
    } else {
      // Same clip, just seek
      syncVideos(newLocalTime);
    }
  }, [sequence, totalDuration, currentMomentIndex, isPlaying, syncVideos]);

  const handleSeek = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    seekToAbsoluteTime(time);
  }, [seekToAbsoluteTime]);

  const handleTimelineSeek = useCallback((time: number) => {
    seekToAbsoluteTime(time);
  }, [seekToAbsoluteTime]);

  // Handle trim preview - seek video while dragging trim handles
  const handleTrimPreview = useCallback((previewTime: number | null) => {
    if (previewTime !== null) {
      seekToAbsoluteTime(previewTime);
    }
  }, [seekToAbsoluteTime]);

  const handlePlaybackRateChange = useCallback((rate: number) => {
    setPlaybackRate(rate);
    if (mainVideoRef.current) {
      mainVideoRef.current.playbackRate = rate;
    }
    Object.values(videoRefs.current).forEach(v => {
      if (v) v.playbackRate = rate;
    });
  }, []);

  // Skip to previous/next clip
  const skipToPreviousClip = useCallback(() => {
    if (!sequence || currentMomentIndex <= 0) return;
    pendingRestoreRef.current = { time: 0, playing: isPlaying };
    setCurrentMomentIndex(prev => prev - 1);
    setLocalTime(0);
  }, [sequence, currentMomentIndex, isPlaying]);

  const skipToNextClip = useCallback(() => {
    if (!sequence || currentMomentIndex >= sequence.moments.length - 1) return;
    pendingRestoreRef.current = { time: 0, playing: isPlaying };
    setCurrentMomentIndex(prev => prev + 1);
    setLocalTime(0);
  }, [sequence, currentMomentIndex, isPlaying]);

  const formatTime = (time: number): string => {
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  // Click on a sub-video to make it the main selected angle
  const handleVideoClick = useCallback((angle: string) => {
    if (layout === 'single') {
      togglePlay();
    } else {
      handleAngleChange(angle);
    }
  }, [layout, togglePlay, handleAngleChange]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!mainVideoRef.current || !sequence) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          togglePlay();
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekToAbsoluteTime(absoluteTime - 5);
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekToAbsoluteTime(absoluteTime + 5);
          break;
        case 'u':
          setSpeedUnit((prev) => (prev === 'mph' ? 'kmh' : 'mph'));
          break;
        case '1':
          handleLayoutChange('single');
          break;
        case '2':
          handleLayoutChange('pip');
          break;
        case '3':
          handleLayoutChange('triple');
          break;
        case '4':
          handleLayoutChange('all');
          break;
        case 'm':
          setShowMap(prev => !prev);
          break;
        case 't':
          setShowTelemetry(prev => !prev);
          break;
        case 'd':
          setShowDateTime(prev => !prev);
          break;
        case 'f':
          toggleFullscreen();
          break;
        case '[':
          skipToPreviousClip();
          break;
        case ']':
          skipToNextClip();
          break;
        case 'e':
          toggleTrimMode();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [togglePlay, absoluteTime, sequence, seekToAbsoluteTime, handleLayoutChange, toggleFullscreen, skipToPreviousClip, skipToNextClip, toggleTrimMode]);

  if (!sequence || !currentMoment || Object.keys(videoUrls).length === 0) {
    return (
      <div className="bg-gray-900 rounded-xl aspect-video flex items-center justify-center">
        <div className="text-center text-gray-500">
          <svg className="w-16 h-16 mx-auto mb-4 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          <p>Select a sequence to play</p>
        </div>
      </div>
    );
  }

  const availableAngles = currentMoment.videos.map(v => v.angle);

  // Render a single video element
  const renderVideo = (angle: string, isMain: boolean, className: string = '') => {
    const url = videoUrls[angle];
    const isAvailable = availableAngles.includes(angle);

    if (!url || !isAvailable) {
      return (
        <div className={`bg-gray-900 flex items-center justify-center text-gray-600 text-xs ${className}`}>
          {ANGLE_LABELS[angle] || angle}
        </div>
      );
    }

    return (
      <div className={`relative ${className}`}>
        <video
          ref={(el) => {
            videoRefs.current[angle] = el;
            if (isMain) {
              (mainVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
            }
          }}
          src={url}
          className="w-full h-full object-contain bg-black"
          muted={!isMain}
          onTimeUpdate={isMain ? handleTimeUpdate : undefined}
          onLoadedMetadata={isMain ? handleLoadedMetadata : undefined}
          onEnded={isMain ? handleVideoEnded : undefined}
          onPlay={isMain ? () => setIsPlaying(true) : undefined}
          onPause={isMain ? handleMainPause : undefined}
          onClick={() => isMain ? togglePlay() : handleAngleChange(angle)}
        />
        {isMain && layout !== 'single' && layout !== 'pip' && (
          <div className="absolute top-1 right-1 w-2 h-2 bg-blue-500 rounded-full" />
        )}
      </div>
    );
  };

  // Play button overlay
  const renderPlayOverlay = () => {
    if (isPlaying || isTimelineDragging) return null;
    return (
      <button
        onClick={togglePlay}
        className="absolute inset-0 flex items-center justify-center bg-black/20 hover:bg-black/30 transition-colors z-10"
      >
        <div className="w-16 h-16 rounded-full bg-white/20 backdrop-blur-sm flex items-center justify-center">
          <svg className="w-8 h-8 text-white ml-1" fill="currentColor" viewBox="0 0 20 20">
            <path d="M6.3 2.841A1.5 1.5 0 004 4.11V15.89a1.5 1.5 0 002.3 1.269l9.344-5.89a1.5 1.5 0 000-2.538L6.3 2.84z" />
          </svg>
        </div>
      </button>
    );
  };

  // Render video grid based on layout
  const renderVideoGrid = () => {
    // Portrait social format — use portrait layout system
    if (format !== 'original' && isPortraitFormat) {
      const layoutMeta = getPortraitLayout(portraitLayout);
      const cameraSlots = portraitCameraConfig[portraitLayout] || DEFAULT_PORTRAIT_CAMERA_CONFIG[portraitLayout] || ['front'];
      const hasGps = !!(mapSeiData?.latitude_deg && mapSeiData?.longitude_deg);

      return (
        <div className="relative w-full h-full bg-black overflow-hidden flex flex-col">
          {layoutMeta.grid.map((row, rowIdx) => (
            <div
              key={rowIdx}
              className="flex gap-[1px]"
              style={{ flex: layoutMeta.rowWeights[rowIdx] }}
            >
              {row.map((slotIdx, colIdx) => {
                // Map slot
                if (slotIdx === -1) {
                  return (
                    <div key={colIdx} className="relative flex-1 bg-gray-900 flex items-center justify-center overflow-hidden isolate z-0">
                      {hasGps && showMap ? (
                        <Suspense fallback={<div className="bg-gray-900 w-full h-full" />}>
                          <MapView seiData={mapSeiData} />
                        </Suspense>
                      ) : (
                        <span className="text-gray-600 text-xs">Map</span>
                      )}
                    </div>
                  );
                }

                const angle = cameraSlots[slotIdx] || 'front';
                const isMain = slotIdx === 0;
                const url = videoUrls[angle];
                const isAvailable = availableAngles.includes(angle);
                const alignSlots = portraitAlignConfig[portraitLayout] || [];
                const slotAlign = alignSlots[slotIdx] || 'center';

                return (
                  <div key={colIdx} className="group relative flex-1 bg-black overflow-hidden">
                    {url && isAvailable ? (
                      <video
                        ref={(el) => {
                          videoRefs.current[angle] = el;
                          if (isMain) {
                            (mainVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
                          }
                        }}
                        src={url}
                        className="w-full h-full object-cover bg-black"
                        style={{ objectPosition: slotAlign }}
                        muted={!isMain}
                        onTimeUpdate={isMain ? handleTimeUpdate : undefined}
                        onLoadedMetadata={isMain ? handleLoadedMetadata : undefined}
                        onEnded={isMain ? handleVideoEnded : undefined}
                        onPlay={isMain ? () => setIsPlaying(true) : undefined}
                        onPause={isMain ? handleMainPause : undefined}
                        onClick={togglePlay}
                      />
                    ) : (
                      <div className="w-full h-full bg-gray-900 flex items-center justify-center text-gray-600 text-xs">
                        {ANGLE_LABELS[angle] || angle}
                      </div>
                    )}
                    {/* Camera selector + alignment overlay — hover-reveal */}
                    <PortraitCameraSelector
                      currentAngle={angle}
                      availableAngles={availableAngles}
                      assignedAngles={cameraSlots}
                      onChange={(newAngle) => handlePortraitSlotChange(slotIdx, newAngle)}
                      currentAlign={slotAlign}
                      onAlignChange={(align) => handlePortraitAlignChange(slotIdx, align)}
                    />
                    {/* Main indicator */}
                    {isMain && layoutMeta.slotCount > 1 && (
                      <div className="absolute top-1.5 right-1.5 w-2 h-2 bg-blue-500 rounded-full z-10" />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {renderPlayOverlay()}
        </div>
      );
    }

    // Single view - just one camera
    if (layout === 'single') {
      return (
        <div className="relative w-full bg-black flex items-center justify-center aspect-video max-h-full">
          <div className="w-full h-full">
            {renderVideo(selectedAngle, true, 'w-full h-full')}
          </div>
          <div className="absolute top-3 right-3 bg-black/60 backdrop-blur-sm rounded px-2 py-1 text-xs font-medium flex items-center gap-1">
            {ANGLE_ICONS[selectedAngle]} {ANGLE_LABELS[selectedAngle]}
          </div>
          {/* Clip indicator for multi-clip sequences */}
          {sequence.clipCount > 1 && (
            <div className="absolute top-3 left-3 bg-black/60 backdrop-blur-sm rounded px-2 py-1 text-xs font-medium">
              Clip {currentMomentIndex + 1}/{sequence.clipCount}
            </div>
          )}
          {renderPlayOverlay()}
        </div>
      );
    }

    // PiP view - main camera with configurable corners
    // corners: [bottom-left, bottom-center, bottom-right, top-left, top-right]
    if (layout === 'pip') {
      const corners = layoutConfig.pip.corners;
      const ar = videoAspectRatio || 16 / 9;

      const hasGps = !!(mapSeiData?.latitude_deg && mapSeiData?.longitude_deg);

      // Position classes for each corner slot
      const cornerPositions = [
        'absolute bottom-3 left-3',                        // 0: bottom-left
        'absolute bottom-3 left-1/2 -translate-x-1/2',    // 1: bottom-center
        'absolute bottom-3 right-3',                       // 2: bottom-right
        'absolute top-3 left-3',                           // 3: top-left
        'absolute top-3 right-3',                          // 4: top-right
      ];

      // Render a single PiP corner element (camera, map, or nothing)
      const renderPipCorner = (value: string, idx: number) => {
        if (value === 'none' || value === selectedAngle) return null;
        const pos = cornerPositions[idx];
        if (value === 'map') {
          if (!hasGps) return null;
          return (
            <div key={idx} className={`${pos} w-[18%] aspect-square rounded-lg overflow-hidden border border-white/20 shadow-lg pointer-events-auto`}>
              <Suspense fallback={<div className="bg-gray-900 w-full h-full" />}>
                <MapView seiData={mapSeiData} />
              </Suspense>
            </div>
          );
        }
        if (!availableAngles.includes(value)) return null;
        return (
          <div
            key={idx}
            className={`${pos} w-[18%] rounded-lg overflow-hidden border border-white/20 shadow-lg pointer-events-none`}
          >
            {renderVideo(value, false, 'w-full')}
          </div>
        );
      };

      return (
        <div className="relative w-full bg-black flex items-center justify-center aspect-video max-h-full overflow-hidden">
          <div
            className="relative max-w-full max-h-full"
            style={{ aspectRatio: `${ar}` }}
          >
            <div className="w-full h-full">
              {renderVideo(selectedAngle, true, 'w-full h-full')}
            </div>
            {/* All 5 PiP corners - each absolutely positioned */}
            {corners.map((value, idx) => renderPipCorner(value, idx))}

            {renderPlayOverlay()}
          </div>
        </div>
      );
    }

    // Triple view - front + left + right in a row
    if (layout === 'triple') {
      const tripleAngles = layoutConfig.triple.cameras;

      return (
        <div className="relative w-full bg-black flex items-center justify-center overflow-hidden aspect-video max-h-full">
          <div className="grid grid-cols-3 w-full">
            {tripleAngles.map((angle, idx) => {
              const isMain = angle === selectedAngle;
              const isAvailable = availableAngles.includes(angle);

              return (
                <div
                  key={idx}
                  className={`relative overflow-hidden ${
                    isMain ? 'ring-2 ring-inset ring-blue-500' : ''
                  } ${isAvailable ? 'cursor-pointer' : 'opacity-40'}`}
                  onClick={() => isAvailable && handleAngleChange(angle)}
                >
                  {renderVideo(angle, isMain, 'w-full')}
                </div>
              );
            })}
          </div>
          {renderPlayOverlay()}
        </div>
      );
    }

    // All 6 cameras - 2 rows of 3
    if (layout === 'all') {
      const rows = [
        layoutConfig.all.topRow,
        layoutConfig.all.bottomRow,
      ];

      return (
        <div className="relative w-full bg-black flex items-center justify-center overflow-hidden aspect-video max-h-full">
          <div className="absolute inset-0 flex flex-col gap-1 p-1">
            {rows.map((row, rowIdx) => (
              <div key={rowIdx} className="flex-1 flex gap-1 min-h-0">
                {row.map((angle, colIdx) => {
                  const isMain = angle === selectedAngle;
                  const isAvailable = availableAngles.includes(angle);

                  return (
                    <div
                      key={colIdx}
                      className={`relative flex-1 rounded overflow-hidden ${
                        isMain ? 'ring-2 ring-blue-500' : ''
                      } ${isAvailable ? 'cursor-pointer' : 'opacity-40'}`}
                      onClick={() => isAvailable && handleAngleChange(angle)}
                    >
                      {renderVideo(angle, isMain, 'w-full h-full')}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {renderPlayOverlay()}
        </div>
      );
    }

    return null;
  };

  return (
    <div
      ref={containerRef}
      className={`flex flex-col gap-2 ${
        isFullscreen
          ? 'fixed inset-0 z-50 bg-black p-4'
          : 'max-w-[1800px] mx-auto h-[calc(100vh-2rem)]'
      }`}
    >
      {/* Video Container with Overlays */}
      <div
        ref={videoContainerRef}
        className={`relative bg-black rounded-xl overflow-hidden flex items-center justify-center ${
          isFullscreen ? 'flex-1' : isPortraitFormat ? 'h-[60vh] self-center' : 'max-h-[60vh]'
        }`}
        style={isPortraitFormat ? { aspectRatio: `${formatPreset.aspectRatio}` } : undefined}
      >
        {renderVideoGrid()}

        {/* Overlay anchor - matches visible video area */}
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none z-20"
        >
          <div
            className={`relative pointer-events-none ${
              (isPortraitFormat || layout === 'pip') && videoAspectRatio ? 'max-w-full max-h-full h-full' : 'w-full h-full'
            }`}
            style={isPortraitFormat
              ? { aspectRatio: `${formatPreset.aspectRatio}` }
              : layout === 'pip' && videoAspectRatio
                ? { aspectRatio: `${videoAspectRatio}` }
                : undefined
            }
          >
            {/* Telemetry Overlay - Top Center */}
            {showTelemetry && (
              <div className="absolute top-3 left-1/2 -translate-x-1/2 pointer-events-auto">
                <TelemetryCard
                  seiData={seiData}
                  isLoading={isLoading}
                  error={error}
                  speedUnit={speedUnit}
                  onSpeedUnitToggle={() => setSpeedUnit(prev => prev === 'mph' ? 'kmh' : 'mph')}
                />
              </div>
            )}

            {/* Date/Time Overlay - Below Telemetry or Top Center */}
            {showDateTime && (
              <div className={`absolute left-1/2 -translate-x-1/2 pointer-events-none ${
                showTelemetry
                  ? [1, 2, 3].includes(seiData?.autopilot_state ?? 0) ? 'top-[105px]' : 'top-[95px]'
                  : 'top-3'
              }`}>
                <div className="px-2 py-1 rounded-md bg-black/50 backdrop-blur-sm text-white/90 text-xs font-medium">
                  {(() => {
                    const realTime = new Date(currentMoment.timestamp.getTime() + localTime * 1000);
                    const date = realTime.toISOString().split('T')[0];
                    const time = realTime.toTimeString().split(' ')[0];
                    return <>{date} &nbsp; {time}</>;
                  })()}
                </div>
              </div>
            )}

            {/* Map Overlay - skip if portrait layout has map slot, or PiP corner has map */}
            {showMap && !(isPortraitFormat && getPortraitLayout(portraitLayout).hasMap) && !(layout === 'pip' && layoutConfig.pip.corners.includes('map')) && (
              <div className={`absolute w-[180px] h-[180px] rounded-lg overflow-hidden shadow-xl opacity-90 hover:opacity-100 transition-opacity pointer-events-auto ${
                layout === 'pip' ? 'top-3 right-3' : 'bottom-3 right-3'
              }`}>
                <Suspense fallback={
                  <div className="bg-gray-900 w-full h-full flex items-center justify-center">
                    <div className="text-gray-500 text-xs">Loading...</div>
                  </div>
                }>
                  <MapView seiData={mapSeiData} />
                </Suspense>
              </div>
            )}

            {/* Safe Zone Overlay */}
            {showSafeZones && formatPreset.safeZones.length > 0 && (
              <>
                {formatPreset.safeZones.map((zone, idx) => (
                  <div
                    key={idx}
                    className="absolute border border-yellow-400/50 bg-yellow-400/8 rounded-sm pointer-events-none"
                    style={{
                      top: `${zone.top * 100}%`,
                      left: `${zone.left * 100}%`,
                      width: `${zone.width * 100}%`,
                      height: `${zone.height * 100}%`,
                    }}
                  >
                    <span className="absolute top-0.5 left-1 text-[7px] text-yellow-400/70 font-medium uppercase tracking-wider">
                      {zone.label}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {/* Controls Area - Scrollable if needed */}
      <div className={`flex-1 overflow-y-auto space-y-2 min-h-0 ${isFullscreen ? '' : ''}`}>
        {/* Playback Controls - Under Video */}
        <div className="bg-gray-800/50 rounded-xl px-4 py-3">
        <div className="flex items-center gap-2">
          {/* Skip to Previous Clip */}
          {sequence.clipCount > 1 && (
            <Tooltip content="Previous clip ([)" position="bottom">
              <button
                onClick={skipToPreviousClip}
                disabled={currentMomentIndex === 0}
                className={`w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full transition-all ${
                  currentMomentIndex === 0
                    ? 'bg-white/5 text-gray-600 cursor-not-allowed'
                    : 'bg-white/10 hover:bg-white/20 text-white'
                }`}
              >
                <IconPlayerSkipBack size={16} />
              </button>
            </Tooltip>
          )}

          {/* Skip Back 15s */}
          <Tooltip content="Back 15s" position="bottom">
            <button
              onClick={() => seekToAbsoluteTime(absoluteTime - 15)}
              className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-all"
            >
              <IconRewindBackward15 size={18} className="text-white" />
            </button>
          </Tooltip>

          {/* Play/Pause Button */}
          <Tooltip content={isPlaying ? "Pause (Space)" : "Play (Space)"} position="bottom">
            <button
              onClick={togglePlay}
              className="w-11 h-11 flex-shrink-0 flex items-center justify-center rounded-full bg-white/15 hover:bg-white/25 transition-all"
            >
              {isPlaying ? (
                <IconPlayerPause size={24} className="text-white" />
              ) : (
                <IconPlayerPlay size={24} className="text-white ml-0.5" />
              )}
            </button>
          </Tooltip>

          {/* Skip Forward 15s */}
          <Tooltip content="Forward 15s" position="bottom">
            <button
              onClick={() => seekToAbsoluteTime(absoluteTime + 15)}
              className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition-all"
            >
              <IconRewindForward15 size={18} className="text-white" />
            </button>
          </Tooltip>

          {/* Skip to Next Clip */}
          {sequence.clipCount > 1 && (
            <Tooltip content="Next clip (])" position="bottom">
              <button
                onClick={skipToNextClip}
                disabled={currentMomentIndex >= sequence.moments.length - 1}
                className={`w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full transition-all ${
                  currentMomentIndex >= sequence.moments.length - 1
                    ? 'bg-white/5 text-gray-600 cursor-not-allowed'
                    : 'bg-white/10 hover:bg-white/20 text-white'
                }`}
              >
                <IconPlayerSkipForward size={16} />
              </button>
            </Tooltip>
          )}

          {/* Time + Timeline */}
          {(() => {
            // When trimmed (and not in trim mode), show trimmed range
            const effectiveStart = (!isTrimming && trimPoints) ? trimPoints.inPoint : 0;
            const effectiveEnd = (!isTrimming && trimPoints) ? trimPoints.outPoint : totalDuration;
            const clampedTime = Math.max(effectiveStart, Math.min(effectiveEnd, absoluteTime));

            return (
              <>
                <span className="text-sm text-gray-400 w-12 tabular-nums ml-2">{formatTime(clampedTime - effectiveStart)}</span>
                <input
                  type="range"
                  min={effectiveStart}
                  max={effectiveEnd || 0}
                  step={0.1}
                  value={clampedTime}
                  onChange={handleSeek}
                  className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
                />
                <span className="text-sm text-gray-400 w-12 tabular-nums">{formatTime(effectiveEnd - effectiveStart)}</span>
              </>
            );
          })()}

          {/* Playback Speed */}
          <div className="flex items-center gap-1 flex-shrink-0 ml-2">
            {[0.5, 1, 1.5, 2].map((rate) => (
              <button
                key={rate}
                onClick={() => handlePlaybackRateChange(rate)}
                className={`px-2 py-1 text-xs font-medium rounded-lg transition-colors ${
                  playbackRate === rate ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                {rate}x
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Control Bar: Camera + Layout + Date + Toggles */}
      <div className="bg-gray-800/50 rounded-xl px-3 py-2">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Camera buttons — only in landscape mode */}
          {!isPortraitFormat && (
            <>
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-gray-500 mr-1">Cameras:</span>
                {ANGLE_ORDER.map((angle) => {
                  const isAvailable = availableAngles.includes(angle);
                  const canSelect = layout === 'single' || layout === 'pip' || isEditMode || hasCustomCameraTrack;
                  const isDisabled = !isAvailable || !canSelect;
                  const isActive = selectedAngle === angle && !useCustomCameraTrack && canSelect;

                  return (
                    <Tooltip key={angle} content={ANGLE_LABELS[angle]} position="top">
                      <button
                        disabled={isDisabled}
                        onClick={() => {
                          if (!isDisabled) {
                            setUseCustomCameraTrack(false);
                            handleAngleChange(angle);
                          }
                        }}
                        className={`p-1.5 rounded text-xs font-medium transition-all ${
                          isActive
                            ? isEditMode ? 'bg-purple-600 text-white' : 'bg-blue-600 text-white'
                            : isDisabled
                            ? 'bg-gray-800/50 text-gray-600 cursor-not-allowed'
                            : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                        }`}
                      >
                        {ANGLE_ICONS[angle]}
                      </button>
                    </Tooltip>
                  );
                })}
                {hasCustomCameraTrack && (
                  <Tooltip content="Use custom camera track" position="top">
                    <button
                      onClick={() => setUseCustomCameraTrack(true)}
                      className={`px-2 py-1 rounded text-xs font-medium transition-all flex items-center gap-1 ${
                        useCustomCameraTrack
                          ? 'bg-gradient-to-r from-purple-600 to-pink-600 text-white'
                          : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                      }`}
                    >
                      <IconWand size={14} />
                      <span>Custom</span>
                    </button>
                  </Tooltip>
                )}
              </div>
              <div className="w-px h-5 bg-gray-700" />
            </>
          )}

          {/* Unified Layout section — swaps content based on format */}
          <div className="flex items-center gap-1 relative">
            <span className="text-[10px] text-gray-500 mr-1">Layout:</span>
            {isPortraitFormat ? (
              <>
                {/* Portrait: current layout button + gear opens modal */}
                <Tooltip content="Change portrait layout" position="top">
                  <button
                    onClick={() => setShowLayoutConfig(prev => !prev)}
                    className={`px-2 py-1 rounded text-xs font-medium transition-all flex items-center gap-1 ${
                      showLayoutConfig
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                  >
                    <IconSettings2 size={14} />
                    <span>{getPortraitLayout(portraitLayout).label}</span>
                  </button>
                </Tooltip>
                {showLayoutConfig && (
                  <LayoutConfigPopover
                    layout={layout === 'single' ? 'pip' : layout}
                    config={layoutConfig}
                    onChange={handleLayoutConfigChange}
                    onClose={() => setShowLayoutConfig(false)}
                    isPortraitFormat={isPortraitFormat}
                    portraitLayout={portraitLayout}
                    onPortraitLayoutChange={handlePortraitLayoutChange}
                  />
                )}
              </>
            ) : (
              <>
                {/* Landscape: layout buttons + optional config gear */}
                {LAYOUTS.map((l) => (
                  <Tooltip key={l.id} content={l.label} position="top">
                    <button
                      onClick={() => handleLayoutChange(l.id)}
                      className={`p-1.5 rounded text-xs font-medium transition-all ${
                        layout === l.id
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                      }`}
                    >
                      {l.icon}
                    </button>
                  </Tooltip>
                ))}
                {layout !== 'single' && (
                  <Tooltip content="Configure layout" position="top">
                    <button
                      onClick={() => setShowLayoutConfig(prev => !prev)}
                      className={`p-1.5 rounded text-xs font-medium transition-all ${
                        showLayoutConfig
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                      }`}
                    >
                      <IconSettings2 size={14} />
                    </button>
                  </Tooltip>
                )}
                {showLayoutConfig && layout !== 'single' && (
                  <LayoutConfigPopover
                    layout={layout}
                    config={layoutConfig}
                    onChange={handleLayoutConfigChange}
                    onClose={() => setShowLayoutConfig(false)}
                    isPortraitFormat={isPortraitFormat}
                  />
                )}
              </>
            )}
          </div>

          {/* Divider */}
          <div className="w-px h-5 bg-gray-700" />

          {/* Format buttons */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-gray-500 mr-1">Format:</span>
            {FORMAT_PRESETS.map((f) => (
              <Tooltip key={f.id} content={f.label} position="top">
                <button
                  onClick={() => setFormat(f.id)}
                  className={`p-1.5 rounded text-xs font-medium transition-all ${
                    format === f.id
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                  }`}
                >
                  {FORMAT_ICONS[f.id]}
                </button>
              </Tooltip>
            ))}
            {formatPreset.safeZones.length > 0 && (
              <Tooltip content={showSafeZones ? 'Hide safe zones' : 'Show safe zones'} position="top">
                <button
                  onClick={() => setShowSafeZones(prev => !prev)}
                  className={`px-1.5 py-1 rounded text-[10px] font-bold transition-all ${
                    showSafeZones
                      ? 'bg-yellow-500 text-black'
                      : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                  }`}
                >
                  SAFE
                </button>
              </Tooltip>
            )}
          </div>

          {/* Divider */}
          <div className="w-px h-5 bg-gray-700" />

          {/* Trim button */}
          <Tooltip content="Trim video (E)" position="top">
            <button
              onClick={toggleTrimMode}
              className={`px-2 py-1 rounded text-xs font-medium transition-all flex items-center gap-1 ${
                isTrimming
                  ? 'bg-yellow-500 text-black'
                  : isEditMode
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
              }`}
            >
              <IconScissors size={14} />
              <span>Trim</span>
            </button>
          </Tooltip>

          {/* Spacer */}
          <div className="flex-1" />

          {/* Overlay Toggles */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-gray-500 mr-1">Show:</span>
            <Tooltip content="Telemetry (T)" position="top">
              <button
                onClick={() => setShowTelemetry(prev => !prev)}
                className={`p-1.5 rounded transition-all ${
                  showTelemetry
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                <IconBolt size={16} />
              </button>
            </Tooltip>
            {showTelemetry && (
              <Tooltip content={`Speed: ${speedUnit === 'mph' ? 'mph' : 'km/h'} (click to switch)`} position="top">
                <button
                  onClick={() => setSpeedUnit(prev => prev === 'mph' ? 'kmh' : 'mph')}
                  className="px-1.5 h-[28px] flex items-center rounded transition-all bg-gray-700 text-gray-300 hover:bg-gray-600 text-[10px] font-bold leading-none"
                >
                  {speedUnit === 'mph' ? 'MPH' : 'KMH'}
                </button>
              </Tooltip>
            )}
            <Tooltip content="Map (M)" position="top">
              <button
                onClick={() => setShowMap(prev => !prev)}
                className={`p-1.5 rounded transition-all ${
                  showMap
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                <IconMapPin size={16} />
              </button>
            </Tooltip>
            <Tooltip content="Date/Time (D)" position="top">
              <button
                onClick={() => setShowDateTime(prev => !prev)}
                className={`p-1.5 rounded transition-all ${
                  showDateTime
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
                }`}
              >
                <IconClock size={16} />
              </button>
            </Tooltip>

            {/* Divider */}
            <div className="w-px h-4 bg-gray-600 mx-1" />

            {/* Fullscreen */}
            <Tooltip content={isFullscreen ? "Exit fullscreen (F)" : "Fullscreen (F)"} position="top">
              <button
                onClick={toggleFullscreen}
                className="p-1.5 rounded bg-gray-700 text-gray-400 hover:bg-gray-600 transition-all"
              >
                {isFullscreen ? <IconMinimize size={16} /> : <IconMaximize size={16} />}
              </button>
            </Tooltip>

            {/* Divider */}
            <div className="w-px h-4 bg-gray-600 mx-1" />

            {/* Export */}
            <VideoExporter
              sequence={sequence}
              selectedAngle={selectedAngle}
              allSeiMessages={allSeiMessages}
              fps={fps}
              speedUnit={speedUnit}
              filename={`tesla-${sequence.dateRange}-${sequence.timeRange.split(' - ')[0].replace(/:/g, '-')}`}
              trimPoints={trimPoints}
              // Without a custom track the exporter follows the camera picked in the toolbar
              cameraSegments={useCustomCameraTrack ? cameraSegments : []}
              showTelemetry={showTelemetry}
              showDateTime={showDateTime}
              showMap={showMap}
              layout={layout}
              layoutConfig={layoutConfig}
              format={format}
              portraitLayout={portraitLayout}
              portraitCameraConfig={portraitCameraConfig}
              portraitAlignConfig={portraitAlignConfig}
            />

            {/* Divider */}
            <div className="w-px h-4 bg-gray-600 mx-1" />

            {/* Sequence Selector */}
            <button
              onClick={() => setShowSequenceMenu(true)}
              className="flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium transition-all bg-gray-700 text-gray-300 hover:bg-gray-600"
            >
              <IconList size={14} />
              <span>
                {sequences.length > 1 ? `${sequences.indexOf(sequence) + 1}/${sequences.length}` : 'Files'}
              </span>
            </button>

            {/* Sequence Dialog */}
            {showSequenceMenu && (
              <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm" onClick={() => setShowSequenceMenu(false)}>
                <div className="bg-gray-900 rounded-xl w-80 max-h-[70vh] shadow-2xl border border-gray-700 overflow-hidden" onClick={e => e.stopPropagation()}>
                  <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-white">Video Files</h3>
                    <button onClick={() => setShowSequenceMenu(false)} className="text-gray-400 hover:text-white">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>

                  <div className="max-h-64 overflow-y-auto">
                    {sequences.map((seq) => {
                      const isSelected = seq.id === sequence.id;
                      return (
                        <button
                          key={seq.id}
                          onClick={() => {
                            onSelectSequence(seq);
                            setShowSequenceMenu(false);
                          }}
                          className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${
                            isSelected
                              ? 'bg-blue-600/20 text-white'
                              : 'hover:bg-gray-800 text-gray-300'
                          }`}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium truncate">
                              {seq.moments[0].time}
                              {seq.clipCount > 1 && (
                                <span className="text-gray-400"> - {seq.moments[seq.clipCount - 1].time}</span>
                              )}
                            </div>
                            <div className="text-xs text-gray-500 flex items-center gap-2">
                              <span>{seq.dateRange}</span>
                              <span>·</span>
                              <span>{seq.durationFormatted}</span>
                              {seq.clipCount > 1 && (
                                <>
                                  <span>·</span>
                                  <span>{seq.clipCount} clips</span>
                                </>
                              )}
                            </div>
                          </div>
                          {isSelected && <IconCheck size={16} className="text-blue-400 flex-shrink-0" />}
                        </button>
                      );
                    })}
                  </div>

                  {/* Actions */}
                  <div className="border-t border-gray-700 p-3 flex gap-2">
                    <label className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-gray-300 text-xs font-medium cursor-pointer transition-colors">
                      <IconPlus size={14} />
                      Add More
                      <input
                        type="file"
                        accept="video/*"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files) {
                            onAddFiles(Array.from(e.target.files));
                            setShowSequenceMenu(false);
                          }
                        }}
                      />
                    </label>
                    <button
                      onClick={() => {
                        onClear();
                        setShowSequenceMenu(false);
                      }}
                      className="flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-red-600/20 hover:bg-red-600/30 text-red-400 text-xs font-medium transition-colors"
                    >
                      <IconTrash size={14} />
                      Clear
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

        {/* Telemetry Timeline */}
        {totalDuration > 0 && (
          <TelemetryTimeline
            allSeiMessages={allSeiMessages}
            fps={fps}
            duration={totalDuration}
            currentTime={absoluteTime}
            onSeek={handleTimelineSeek}
            onDraggingChange={setIsTimelineDragging}
            clipBoundaries={sequence.momentOffsets}
            event={sequence.event}
            sequenceStartTime={sequence.startTime}
            isEditMode={isEditMode}
            isTrimming={isTrimming}
            onTrimmingChange={setIsTrimming}
            trimPoints={trimPoints}
            onTrimChange={handleTrimChange}
            onTrimPreview={handleTrimPreview}
            cameraSegments={cameraSegments}
            onCameraSegmentsChange={setCameraSegments}
            cameraTrackActive={cameraTrackActive}
            selectedAngle={selectedAngle}
            availableAngles={availableAngles}
          />
        )}
      </div>
    </div>
  );
}
