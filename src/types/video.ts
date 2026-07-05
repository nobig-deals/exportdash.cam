/**
 * Video Types for Tesla Dashcam Viewer
 *
 * Data hierarchy:
 * - VideoMoment: One timestamp (all camera angles at that moment)
 * - VideoSequence: Consecutive moments merged for seamless playback
 */

/** A single camera angle video file */
export interface CameraVideo {
  file: File;
  angle: string;           // e.g., 'front', 'back', 'left_repeater'
  angleLabel: string;      // Human-readable label
  duration: number;        // Duration in seconds
  durationFormatted: string | null;  // e.g., "1:00"
  size: string;            // Human-readable size
}

/** One timestamp - all camera angles at a specific moment */
export interface VideoMoment {
  id: string;              // Unique identifier (timestamp-based)
  timestamp: Date;         // Actual timestamp from filename
  date: string;            // Date string (YYYY-MM-DD)
  time: string;            // Time string (HH:MM:SS)
  dateTime: string;        // Combined date/time for sorting
  videos: CameraVideo[];   // All camera angles for this moment
  duration: number;        // Duration in seconds (from front camera)
}

/** Processing progress state */
export interface ProcessingProgress {
  stage: 'scanning' | 'decrypting' | 'metadata' | 'ready' | 'error';
  current: number;         // Current file being processed
  total: number;           // Total files to process
  message?: string;        // Optional status message
}

/** A sequence of consecutive moments for seamless playback */
export interface VideoSequence {
  id: string;                    // Unique identifier
  moments: VideoMoment[];        // All moments in chronological order
  startTime: Date;               // Start timestamp
  endTime: Date;                 // End timestamp
  totalDuration: number;         // Total duration in seconds
  clipCount: number;             // Number of clips/moments

  // Computed properties for display
  dateRange: string;             // e.g., "2024-01-15"
  timeRange: string;             // e.g., "10:30:00 - 10:35:00"
  durationFormatted: string;     // e.g., "5:00"

  // Playback mapping: cumulative durations for seeking
  momentOffsets: number[];       // Start time offset for each moment

  // Optional event data from event.json
  event?: TeslaEvent;
}

/** Tesla event data from event.json */
export interface TeslaEvent {
  timestamp: Date;
  city?: string;
  street?: string;
  est_lat?: number;
  est_lon?: number;
  reason: string;
  reasonLabel: string;
  camera?: string;
}

/** Human-readable labels for Tesla event reasons */
export const REASON_LABELS: Record<string, string> = {
  user_interaction_dashcam_multifunction_selected: 'Manual Save',
  user_interaction_dashcam_icon_tapped: 'Manual Save',
  user_interaction_honk: 'Honk Save',
  sentry_aware_object_detection: 'Sentry: Object Detected',
  sentry_aware_accel: 'Sentry: Acceleration',
  sentry_aware_intrusion: 'Sentry: Intrusion',
  sentry_aware_proximity: 'Sentry: Proximity',
  sentry_ion: 'Sentry Mode',
  sentry_ioff: 'Sentry Off',
  dashcam_clip_request: 'Dashcam Clip',
  emergency_braking: 'Emergency Braking',
  forward_collision_warning: 'Forward Collision Warning',
  auto_emergency_braking: 'Auto Emergency Braking',
  ap_forward_collision: 'Autopilot: Forward Collision',
};

/** Get human-readable label for an event reason */
export function getReasonLabel(reason: string): string {
  return REASON_LABELS[reason] || reason.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Angle constants and utilities */
export const ANGLE_LABELS: Record<string, string> = {
  front: 'Front',
  back: 'Rear',
  left_repeater: 'Left',
  right_repeater: 'Right',
  left_pillar: 'L Pillar',
  right_pillar: 'R Pillar',
};

export const ANGLE_ORDER = ['front', 'left_repeater', 'right_repeater', 'back', 'left_pillar', 'right_pillar'];

/** Camera layout configuration for multi-camera views */
export interface LayoutCameraConfig {
  pip: { corners: [string, string, string, string, string] }; // bottom-left, bottom-center, bottom-right, top-left, top-right
  triple: { cameras: [string, string, string] };               // left, center, right
  all: { topRow: [string, string, string]; bottomRow: [string, string, string] };
}

/** Special PiP corner values (besides camera angles) */
export const PIP_SPECIAL_OPTIONS = ['none', 'map'] as const;

export const DEFAULT_LAYOUT_CONFIG: LayoutCameraConfig = {
  pip: { corners: ['left_repeater', 'none', 'right_repeater', 'back', 'map'] },
  triple: { cameras: ['left_pillar', 'front', 'right_pillar'] },
  all: {
    topRow: ['left_repeater', 'left_pillar', 'front'],
    bottomRow: ['right_repeater', 'right_pillar', 'back'],
  },
};

const LAYOUT_CONFIG_KEY = 'tesla-cam-layout-config';

export function loadLayoutConfig(): LayoutCameraConfig {
  try {
    const stored = localStorage.getItem(LAYOUT_CONFIG_KEY);
    if (!stored) return { ...DEFAULT_LAYOUT_CONFIG };
    const parsed = JSON.parse(stored);
    // Merge with defaults to handle missing/corrupt fields
    return {
      pip: { corners: parsed?.pip?.corners?.length === 5 ? parsed.pip.corners : [...DEFAULT_LAYOUT_CONFIG.pip.corners] },
      triple: { cameras: parsed?.triple?.cameras?.length === 3 ? parsed.triple.cameras : [...DEFAULT_LAYOUT_CONFIG.triple.cameras] },
      all: {
        topRow: parsed?.all?.topRow?.length === 3 ? parsed.all.topRow : [...DEFAULT_LAYOUT_CONFIG.all.topRow],
        bottomRow: parsed?.all?.bottomRow?.length === 3 ? parsed.all.bottomRow : [...DEFAULT_LAYOUT_CONFIG.all.bottomRow],
      },
    };
  } catch {
    return { ...DEFAULT_LAYOUT_CONFIG };
  }
}

export function saveLayoutConfig(config: LayoutCameraConfig): void {
  try {
    localStorage.setItem(LAYOUT_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Silently fail if localStorage is full or unavailable
  }
}

/** Trim points for video export */
export interface TrimPoints {
  inPoint: number;   // Start time in seconds
  outPoint: number;  // End time in seconds
}

/** Camera angle segment for multi-angle exports */
export interface CameraSegment {
  startTime: number;
  endTime: number;
  angle: string;     // 'front', 'back', etc.
}

/** Colors for camera angle visualization in timeline */
export const ANGLE_COLORS: Record<string, string> = {
  front: '#3B82F6',      // blue
  back: '#8B5CF6',       // purple
  left_repeater: '#22C55E',  // green
  right_repeater: '#F59E0B', // amber
  left_pillar: '#06B6D4',    // cyan
  right_pillar: '#EC4899',   // pink
};

/** Social media format presets for export */
export type FormatType = 'original' | 'tiktok' | 'instagram' | 'instagram-story' | 'twitter' | 'youtube-shorts';

export interface SafeZone {
  label: string;
  /** Percentage positions (0-1 range) relative to container */
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface FormatPreset {
  id: FormatType;
  label: string;
  shortLabel: string;
  aspectRatio: number;  // width / height, 0 = use source
  exportWidth: number;  // 0 = use source
  exportHeight: number;
  safeZones: SafeZone[];
}

export const FORMAT_PRESETS: FormatPreset[] = [
  {
    id: 'original',
    label: 'Original',
    shortLabel: 'Orig',
    aspectRatio: 0,
    exportWidth: 0,
    exportHeight: 0,
    safeZones: [],
  },
  {
    id: 'tiktok',
    label: 'TikTok / Reels',
    shortLabel: 'TikTok',
    aspectRatio: 9 / 16,
    exportWidth: 1080,
    exportHeight: 1920,
    safeZones: [
      { label: 'Username & Caption', top: 0.7, left: 0.02, width: 0.7, height: 0.22 },
      { label: 'Actions', top: 0.3, left: 0.85, width: 0.13, height: 0.55 },
    ],
  },
  {
    id: 'instagram',
    label: 'Instagram Post',
    shortLabel: 'Insta',
    aspectRatio: 4 / 5,
    exportWidth: 1080,
    exportHeight: 1350,
    safeZones: [
      { label: 'Caption', top: 0.88, left: 0.02, width: 0.96, height: 0.1 },
    ],
  },
  {
    id: 'instagram-story',
    label: 'Instagram Story',
    shortLabel: 'Story',
    aspectRatio: 9 / 16,
    exportWidth: 1080,
    exportHeight: 1920,
    safeZones: [
      { label: 'Username', top: 0.02, left: 0.02, width: 0.5, height: 0.06 },
      { label: 'Reply & Send', top: 0.92, left: 0.02, width: 0.96, height: 0.06 },
    ],
  },
  {
    id: 'twitter',
    label: 'X (Twitter)',
    shortLabel: 'X',
    aspectRatio: 16 / 9,
    exportWidth: 1280,
    exportHeight: 720,
    safeZones: [],
  },
  {
    id: 'youtube-shorts',
    label: 'YouTube Shorts',
    shortLabel: 'Shorts',
    aspectRatio: 9 / 16,
    exportWidth: 1080,
    exportHeight: 1920,
    safeZones: [
      { label: 'Title & Channel', top: 0.78, left: 0.02, width: 0.78, height: 0.14 },
      { label: 'Actions', top: 0.35, left: 0.87, width: 0.11, height: 0.45 },
    ],
  },
];

export function getFormatPreset(id: FormatType): FormatPreset {
  return FORMAT_PRESETS.find(f => f.id === id) || FORMAT_PRESETS[0];
}

/** Portrait layout types for social media formats */
export type PortraitLayoutType = 'p-single' | 'p-split' | 'p-1-2' | 'p-grid' | 'p-1-2-1' | 'p-six' | 'p-six-map';

export interface PortraitLayoutMeta {
  id: PortraitLayoutType;
  label: string;
  description: string;
  slotCount: number;
  hasMap: boolean;
  /** Row arrays of slot indices; -1 = map placeholder */
  grid: number[][];
  /** Flex weight for each row */
  rowWeights: number[];
}

export const PORTRAIT_LAYOUTS: PortraitLayoutMeta[] = [
  {
    id: 'p-single',
    label: 'Single',
    description: 'Full frame',
    slotCount: 1,
    hasMap: false,
    grid: [[0]],
    rowWeights: [1],
  },
  {
    id: 'p-split',
    label: 'Split',
    description: 'Two cameras stacked',
    slotCount: 2,
    hasMap: false,
    grid: [[0], [1]],
    rowWeights: [1, 1],
  },
  {
    id: 'p-1-2',
    label: '1 + 2',
    description: 'Main top, two below',
    slotCount: 3,
    hasMap: false,
    grid: [[0], [1, 2]],
    rowWeights: [3, 2],
  },
  {
    id: 'p-grid',
    label: 'Grid',
    description: '2×2 grid',
    slotCount: 4,
    hasMap: false,
    grid: [[0, 1], [2, 3]],
    rowWeights: [1, 1],
  },
  {
    id: 'p-1-2-1',
    label: '1+2+1',
    description: 'Top, two middle, bottom',
    slotCount: 4,
    hasMap: false,
    grid: [[0], [1, 2], [3]],
    rowWeights: [2, 1, 2],
  },
  {
    id: 'p-six',
    label: 'All 6',
    description: '2×3 grid',
    slotCount: 6,
    hasMap: false,
    grid: [[0, 1], [2, 3], [4, 5]],
    rowWeights: [1, 1, 1],
  },
  {
    id: 'p-six-map',
    label: '6 + Map',
    description: '5 cameras + map',
    slotCount: 5,
    hasMap: true,
    grid: [[0, 1], [2, 3], [4, -1]],
    rowWeights: [1, 1, 1],
  },
];

export function getPortraitLayout(id: PortraitLayoutType): PortraitLayoutMeta {
  return PORTRAIT_LAYOUTS.find(l => l.id === id) || PORTRAIT_LAYOUTS[2]; // default to p-1-2
}

/** Portrait camera configuration — maps layout ID to array of camera angles per slot */
export type PortraitCameraConfig = Record<string, string[]>;

export const DEFAULT_PORTRAIT_CAMERA_CONFIG: PortraitCameraConfig = {
  'p-single': ['front'],
  'p-split': ['front', 'back'],
  'p-1-2': ['front', 'left_repeater', 'right_repeater'],
  'p-grid': ['front', 'back', 'left_repeater', 'right_repeater'],
  'p-1-2-1': ['front', 'left_repeater', 'right_repeater', 'back'],
  'p-six': ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar', 'right_pillar'],
  'p-six-map': ['front', 'back', 'left_repeater', 'right_repeater', 'left_pillar'],
};

const PORTRAIT_LAYOUT_KEY = 'tesla-cam-portrait-layout';
const PORTRAIT_CAMERA_CONFIG_KEY = 'tesla-cam-portrait-camera-config';

export function loadPortraitLayout(): PortraitLayoutType {
  try {
    const stored = localStorage.getItem(PORTRAIT_LAYOUT_KEY);
    if (stored && PORTRAIT_LAYOUTS.some(l => l.id === stored)) {
      return stored as PortraitLayoutType;
    }
    return 'p-1-2';
  } catch {
    return 'p-1-2';
  }
}

export function savePortraitLayout(layout: PortraitLayoutType): void {
  try {
    localStorage.setItem(PORTRAIT_LAYOUT_KEY, layout);
  } catch {
    // Silently fail
  }
}

export function loadPortraitCameraConfig(): PortraitCameraConfig {
  try {
    const stored = localStorage.getItem(PORTRAIT_CAMERA_CONFIG_KEY);
    if (!stored) return { ...DEFAULT_PORTRAIT_CAMERA_CONFIG };
    const parsed = JSON.parse(stored);
    // Merge with defaults — only keep entries that have correct slot count
    const result: PortraitCameraConfig = {};
    for (const layout of PORTRAIT_LAYOUTS) {
      const storedSlots = parsed?.[layout.id];
      if (Array.isArray(storedSlots) && storedSlots.length === layout.slotCount) {
        result[layout.id] = storedSlots;
      } else {
        result[layout.id] = [...(DEFAULT_PORTRAIT_CAMERA_CONFIG[layout.id] || [])];
      }
    }
    return result;
  } catch {
    return { ...DEFAULT_PORTRAIT_CAMERA_CONFIG };
  }
}

export function savePortraitCameraConfig(config: PortraitCameraConfig): void {
  try {
    localStorage.setItem(PORTRAIT_CAMERA_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Silently fail
  }
}

/** Alignment position for object-cover crop anchor (3×3 grid) */
export type AlignPosition =
  | 'top left' | 'top center' | 'top right'
  | 'center left' | 'center' | 'center right'
  | 'bottom left' | 'bottom center' | 'bottom right';

/** Maps layout ID to array of alignment positions per slot */
export type PortraitAlignConfig = Record<string, AlignPosition[]>;

export const DEFAULT_PORTRAIT_ALIGN_CONFIG: PortraitAlignConfig = {
  'p-single': ['center'],
  'p-split': ['center', 'center'],
  'p-1-2': ['center', 'center', 'center'],
  'p-grid': ['center', 'center', 'center', 'center'],
  'p-1-2-1': ['center', 'center', 'center', 'center'],
  'p-six': ['center', 'center', 'center', 'center', 'center', 'center'],
  'p-six-map': ['center', 'center', 'center', 'center', 'center'],
};

const PORTRAIT_ALIGN_CONFIG_KEY = 'tesla-cam-portrait-align-config';

export function loadPortraitAlignConfig(): PortraitAlignConfig {
  try {
    const stored = localStorage.getItem(PORTRAIT_ALIGN_CONFIG_KEY);
    if (!stored) return { ...DEFAULT_PORTRAIT_ALIGN_CONFIG };
    const parsed = JSON.parse(stored);
    const result: PortraitAlignConfig = {};
    for (const layout of PORTRAIT_LAYOUTS) {
      const storedSlots = parsed?.[layout.id];
      if (Array.isArray(storedSlots) && storedSlots.length === layout.slotCount) {
        result[layout.id] = storedSlots;
      } else {
        result[layout.id] = [...(DEFAULT_PORTRAIT_ALIGN_CONFIG[layout.id] || [])];
      }
    }
    return result;
  } catch {
    return { ...DEFAULT_PORTRAIT_ALIGN_CONFIG };
  }
}

export function savePortraitAlignConfig(config: PortraitAlignConfig): void {
  try {
    localStorage.setItem(PORTRAIT_ALIGN_CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Silently fail
  }
}

/** Parse camera angle from filename */
export function parseAngle(filename: string): string | null {
  const lower = filename.toLowerCase();
  for (const angle of ANGLE_ORDER) {
    if (lower.includes(angle)) return angle;
  }
  return null;
}

/** Parse timestamp from Tesla dashcam filename */
export function parseTimestamp(filename: string): Date | null {
  // Tesla format: YYYY-MM-DD_HH-MM-SS-...
  const match = filename.match(/(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  return new Date(
    parseInt(year),
    parseInt(month) - 1,  // Month is 0-indexed
    parseInt(day),
    parseInt(hour),
    parseInt(minute),
    parseInt(second)
  );
}

/** Format duration in seconds to MM:SS */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/** Format file size to human-readable string */
export function formatFileSize(bytes: number): string {
  const sizeInMB = bytes / (1024 * 1024);
  return sizeInMB >= 1
    ? `${sizeInMB.toFixed(1)} MB`
    : `${(bytes / 1024).toFixed(0)} KB`;
}
