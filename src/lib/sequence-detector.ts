/**
 * Sequence Detector
 *
 * Detects consecutive Tesla dashcam clips and merges them into sequences
 * for seamless playback. A sequence is formed when clips have timestamps
 * within a specified gap threshold (typically 65 seconds for 60-second clips).
 */

import {
  VideoMoment,
  VideoSequence,
  CameraVideo,
  ProcessingProgress,
  TeslaEvent,
  parseAngle,
  parseTimestamp,
  formatDuration,
  formatFileSize,
  getReasonLabel,
  ANGLE_LABELS,
  ANGLE_ORDER,
  formatLocalDate,
} from '@/types/video';

/** Gap threshold in seconds - clips within this gap are considered consecutive */
const SEQUENCE_GAP_THRESHOLD_SECONDS = 65;

/** Get video duration using HTMLVideoElement */
async function getVideoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';

    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(video.duration && isFinite(video.duration) ? video.duration : 60);
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(60); // Default to 60 seconds if metadata fails
    };

    video.src = url;
  });
}

/** Parse an event.json file into a TeslaEvent */
async function parseEventJson(file: File): Promise<TeslaEvent | null> {
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.timestamp || !data.reason) return null;

    // Parse timestamp: "2026-02-07T17:36:02" (local time, no timezone)
    const ts = new Date(data.timestamp);
    if (isNaN(ts.getTime())) return null;

    return {
      timestamp: ts,
      city: data.city || undefined,
      street: data.street || undefined,
      est_lat: data.est_lat ? parseFloat(data.est_lat) : undefined,
      est_lon: data.est_lon ? parseFloat(data.est_lon) : undefined,
      reason: data.reason,
      reasonLabel: getReasonLabel(data.reason),
      camera: data.camera || undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Process raw video files into VideoMoments grouped by timestamp.
 * Also parses any event.json files found alongside the videos.
 */
export async function processFilesToMoments(
  files: File[],
  onProgress?: (progress: ProcessingProgress) => void
): Promise<{ moments: VideoMoment[]; events: TeslaEvent[] }> {
  // Separate JSON files from MP4 files
  const videoFiles: File[] = [];
  const jsonFiles: File[] = [];
  for (const file of files) {
    if (file.name.toLowerCase() === 'event.json') {
      jsonFiles.push(file);
    } else {
      videoFiles.push(file);
    }
  }

  // Parse event.json files
  const events: TeslaEvent[] = [];
  for (const jsonFile of jsonFiles) {
    const event = await parseEventJson(jsonFile);
    if (event) events.push(event);
  }

  // Group video files by timestamp
  const groups: Record<string, { file: File; angle: string | null; timestamp: Date | null }[]> = {};

  onProgress?.({
    stage: 'scanning',
    current: 0,
    total: videoFiles.length,
    message: 'Scanning files...',
  });

  for (const file of videoFiles) {
    const timestamp = parseTimestamp(file.name);
    const key = timestamp
      ? timestamp.toISOString()
      : file.name; // Fallback for non-standard names

    if (!groups[key]) groups[key] = [];
    groups[key].push({
      file,
      angle: parseAngle(file.name),
      timestamp,
    });
  }

  // Convert groups to VideoMoments with duration metadata
  const moments: VideoMoment[] = [];
  const groupEntries = Object.entries(groups);
  let processedCount = 0;

  for (const [, groupFiles] of groupEntries) {
    // Get a valid timestamp from any file in the group
    const validTimestamp = groupFiles.find(f => f.timestamp)?.timestamp;
    if (!validTimestamp) continue;

    // Process each video file in the group
    const videos: CameraVideo[] = await Promise.all(
      groupFiles.map(async ({ file, angle }) => {
        processedCount++;
        onProgress?.({
          stage: 'metadata',
          current: processedCount,
          total: videoFiles.length,
          message: `Processing ${file.name}...`,
        });

        const duration = await getVideoDuration(file);

        return {
          file,
          angle: angle || 'unknown',
          angleLabel: angle ? ANGLE_LABELS[angle] : 'Unknown',
          duration,
          durationFormatted: formatDuration(duration),
          size: formatFileSize(file.size),
        };
      })
    );

    // Sort videos by angle order
    videos.sort((a, b) => {
      const aIdx = ANGLE_ORDER.indexOf(a.angle);
      const bIdx = ANGLE_ORDER.indexOf(b.angle);
      return (aIdx === -1 ? 99 : aIdx) - (bIdx === -1 ? 99 : bIdx);
    });

    // Use front camera duration, or first available
    const frontVideo = videos.find(v => v.angle === 'front');
    const momentDuration = frontVideo?.duration || videos[0]?.duration || 60;

    const date = formatLocalDate(validTimestamp);
    const time = validTimestamp.toTimeString().split(' ')[0];

    moments.push({
      id: validTimestamp.toISOString(),
      timestamp: validTimestamp,
      date,
      time,
      dateTime: `${date} ${time}`,
      videos,
      duration: momentDuration,
    });
  }

  // Sort moments chronologically
  moments.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  onProgress?.({
    stage: 'ready',
    current: videoFiles.length,
    total: videoFiles.length,
    message: 'Ready',
  });

  return { moments, events };
}

/**
 * Detect consecutive moments and merge them into sequences
 *
 * Example:
 * - Clip 1: 10:30:00 (60s duration)
 * - Clip 2: 10:31:00 (60s duration) ← 0s gap after Clip 1 ends, merge
 * - Clip 3: 10:32:00 (60s duration) ← 0s gap after Clip 2 ends, merge
 * - Clip 4: 10:45:00 (60s duration) ← 12min gap, new sequence
 */
export function detectSequences(moments: VideoMoment[], events: TeslaEvent[] = []): VideoSequence[] {
  if (moments.length === 0) return [];

  const sequences: VideoSequence[] = [];
  let currentSequenceMoments: VideoMoment[] = [moments[0]];

  for (let i = 1; i < moments.length; i++) {
    const prevMoment = currentSequenceMoments[currentSequenceMoments.length - 1];
    const currentMoment = moments[i];

    // Calculate gap: current start - (previous start + previous duration)
    const prevEndTime = prevMoment.timestamp.getTime() + prevMoment.duration * 1000;
    const currentStartTime = currentMoment.timestamp.getTime();
    const gapMs = currentStartTime - prevEndTime;

    // If gap is within threshold, add to current sequence
    if (gapMs <= SEQUENCE_GAP_THRESHOLD_SECONDS * 1000) {
      currentSequenceMoments.push(currentMoment);
    } else {
      // Gap too large, finalize current sequence and start new one
      sequences.push(createSequence(currentSequenceMoments));
      currentSequenceMoments = [currentMoment];
    }
  }

  // Don't forget the last sequence
  if (currentSequenceMoments.length > 0) {
    sequences.push(createSequence(currentSequenceMoments));
  }

  // Match events to sequences by timestamp overlap
  for (const event of events) {
    const eventTime = event.timestamp.getTime();
    for (const seq of sequences) {
      const seqStart = seq.startTime.getTime();
      const seqEnd = seq.endTime.getTime();
      if (eventTime >= seqStart && eventTime <= seqEnd) {
        seq.event = event;
        break;
      }
    }
  }

  return sequences;
}

/**
 * Create a VideoSequence from a list of consecutive moments
 */
function createSequence(moments: VideoMoment[]): VideoSequence {
  const startTime = moments[0].timestamp;
  const lastMoment = moments[moments.length - 1];
  const endTime = new Date(lastMoment.timestamp.getTime() + lastMoment.duration * 1000);

  // Calculate total duration and moment offsets
  let totalDuration = 0;
  const momentOffsets: number[] = [];

  for (const moment of moments) {
    momentOffsets.push(totalDuration);
    totalDuration += moment.duration;
  }

  // Format time range
  const startTimeStr = moments[0].time;
  const endTimeStr = endTime.toTimeString().split(' ')[0];
  const timeRange = `${startTimeStr} - ${endTimeStr}`;

  // Format date range (usually just one date)
  const dates = new Set(moments.map(m => m.date));
  const dateRange = dates.size === 1
    ? moments[0].date
    : `${moments[0].date} - ${lastMoment.date}`;

  return {
    id: `seq-${startTime.toISOString()}`,
    moments,
    startTime,
    endTime,
    totalDuration,
    clipCount: moments.length,
    dateRange,
    timeRange,
    durationFormatted: formatDuration(totalDuration),
    momentOffsets,
  };
}

/**
 * Given an absolute time within a sequence, find the moment index and local time
 *
 * Example (3 clips of 60s each):
 * - Absolute 0-60s   → Moment 0, local 0-60s
 * - Absolute 60-120s → Moment 1, local 0-60s
 * - Absolute 120-180s → Moment 2, local 0-60s
 */
export function findMomentForTime(
  sequence: VideoSequence,
  absoluteTime: number
): { momentIndex: number; localTime: number } {
  // Binary search for the moment containing this time
  const { momentOffsets, moments } = sequence;

  let left = 0;
  let right = moments.length - 1;

  while (left < right) {
    const mid = Math.floor((left + right + 1) / 2);
    if (momentOffsets[mid] <= absoluteTime) {
      left = mid;
    } else {
      right = mid - 1;
    }
  }

  const momentIndex = left;
  const localTime = absoluteTime - momentOffsets[momentIndex];

  return { momentIndex, localTime };
}

/**
 * Convert a moment index and local time to absolute sequence time
 */
export function toAbsoluteTime(
  sequence: VideoSequence,
  momentIndex: number,
  localTime: number
): number {
  if (momentIndex < 0 || momentIndex >= sequence.moments.length) {
    return 0;
  }
  return sequence.momentOffsets[momentIndex] + localTime;
}
