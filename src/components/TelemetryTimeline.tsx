'use client';

import { useMemo, useRef, useCallback, useEffect, useState } from 'react';
import { SeiWithFrameIndex } from '@/lib/dashcam-mp4';
import { TrimPoints, CameraSegment, ANGLE_COLORS, ANGLE_LABELS, TeslaEvent } from '@/types/video';
import { Tooltip } from './Tooltip';

interface TelemetryTimelineProps {
  allSeiMessages: SeiWithFrameIndex[];
  fps: number;
  duration: number;
  currentTime: number;
  onSeek: (time: number) => void;
  onDraggingChange?: (isDragging: boolean) => void;
  clipBoundaries?: number[];  // Offset times where each clip starts (for multi-clip sequences)
  event?: TeslaEvent;
  sequenceStartTime?: Date;
  // Edit mode props
  isEditMode?: boolean;
  isTrimming?: boolean;  // When true, show full timeline for trimming
  onTrimmingChange?: (isTrimming: boolean) => void;
  trimPoints?: TrimPoints | null;
  onTrimChange?: (trimPoints: TrimPoints) => void;
  onTrimPreview?: (time: number | null) => void;
  cameraSegments?: CameraSegment[];
  onCameraSegmentsChange?: (segments: CameraSegment[]) => void;
  cameraTrackActive?: boolean;  // False when the current layout/format ignores the camera track
  selectedAngle?: string;
  availableAngles?: string[];  // For drag-drop palette
}

interface EventSegment {
  startTime: number;
  endTime: number;
  intensity?: number; // 0-1 for continuous values like gas
}

interface TrackData {
  id: string;
  label: string;
  color: string;
  segments: EventSegment[];
}

export function TelemetryTimeline({
  allSeiMessages,
  fps,
  duration,
  currentTime,
  onSeek,
  onDraggingChange,
  clipBoundaries = [],
  event,
  sequenceStartTime,
  isEditMode = false,
  isTrimming = false,
  onTrimmingChange,
  trimPoints,
  onTrimChange,
  onTrimPreview,
  cameraSegments = [],
  onCameraSegmentsChange,
  cameraTrackActive = true,
  selectedAngle,
  availableAngles = [],
}: TelemetryTimelineProps) {
  // Process telemetry data into timeline tracks
  const tracks = useMemo((): TrackData[] => {
    if (allSeiMessages.length === 0 || fps <= 0) return [];

    const frameToTime = (frameIndex: number) => frameIndex / fps;
    const frameDuration = 1 / fps;

    // Helper to build segments from boolean events
    const buildBooleanSegments = (
      predicate: (sei: SeiWithFrameIndex) => boolean
    ): EventSegment[] => {
      const segments: EventSegment[] = [];
      let currentSegment: EventSegment | null = null;

      for (const msg of allSeiMessages) {
        const time = frameToTime(msg.frameIndex);
        const isActive = predicate(msg);

        if (isActive && !currentSegment) {
          currentSegment = { startTime: time, endTime: time + frameDuration };
        } else if (isActive && currentSegment) {
          currentSegment.endTime = time + frameDuration;
        } else if (!isActive && currentSegment) {
          segments.push(currentSegment);
          currentSegment = null;
        }
      }

      if (currentSegment) {
        segments.push(currentSegment);
      }

      return segments;
    };

    // Helper to build segments with intensity for continuous values
    const buildIntensitySegments = (
      getValue: (sei: SeiWithFrameIndex) => number,
      threshold: number = 0.05
    ): EventSegment[] => {
      const segments: EventSegment[] = [];
      let currentSegment: EventSegment | null = null;

      for (const msg of allSeiMessages) {
        const time = frameToTime(msg.frameIndex);
        const value = getValue(msg);
        const isActive = value > threshold;

        if (isActive && !currentSegment) {
          currentSegment = { startTime: time, endTime: time + frameDuration, intensity: value };
        } else if (isActive && currentSegment) {
          currentSegment.endTime = time + frameDuration;
          // Update intensity to max seen in this segment
          currentSegment.intensity = Math.max(currentSegment.intensity || 0, value);
        } else if (!isActive && currentSegment) {
          segments.push(currentSegment);
          currentSegment = null;
        }
      }

      if (currentSegment) {
        segments.push(currentSegment);
      }

      return segments;
    };

    // Build all tracks
    return [
      {
        id: 'gas',
        label: 'Gas',
        color: '#22c55e', // green
        segments: buildIntensitySegments((msg) => {
          const val = msg.sei.accelerator_pedal_position || 0;
          return val > 1 ? val / 100 : val; // Normalize to 0-1
        }),
      },
      {
        id: 'brake',
        label: 'Brake',
        color: '#ef4444', // red
        segments: buildBooleanSegments((msg) => msg.sei.brake_applied === true),
      },
      {
        id: 'left-blinker',
        label: 'Left',
        color: '#f59e0b', // amber
        segments: buildBooleanSegments((msg) => msg.sei.blinker_on_left === true),
      },
      {
        id: 'right-blinker',
        label: 'Right',
        color: '#f59e0b', // amber
        segments: buildBooleanSegments((msg) => msg.sei.blinker_on_right === true),
      },
      {
        id: 'steering',
        label: 'Steer',
        color: '#3b82f6', // blue
        segments: buildIntensitySegments((msg) => {
          const angle = Math.abs(msg.sei.steering_wheel_angle || 0);
          return Math.min(1, angle / 180); // Normalize to 0-1 (180° = full)
        }, 0.1),
      },
    ];
  }, [allSeiMessages, fps]);

  // Dragging/scrubbing state
  const timelineRef = useRef<HTMLDivElement>(null);
  const cameraTrackRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [draggingTrimHandle, setDraggingTrimHandle] = useState<'in' | 'out' | null>(null);
  const [draggingSegmentBoundary, setDraggingSegmentBoundary] = useState<number | null>(null);
  const [draggingAngle, setDraggingAngle] = useState<string | null>(null); // For drag-drop from palette
  const [dragPosition, setDragPosition] = useState<{ x: number; y: number } | null>(null); // Mouse position for drag ghost

  // Calculate event position in absolute time
  const eventAbsoluteTime = useMemo(() => {
    if (!event || !sequenceStartTime) return null;
    const offsetSeconds = (event.timestamp.getTime() - sequenceStartTime.getTime()) / 1000;
    if (offsetSeconds < 0 || offsetSeconds > duration) return null;
    return offsetSeconds;
  }, [event, sequenceStartTime, duration]);

  const [showEventTooltip, setShowEventTooltip] = useState(false);

  // Notify parent when dragging state changes
  useEffect(() => {
    onDraggingChange?.(isDragging || draggingTrimHandle !== null || draggingSegmentBoundary !== null);
  }, [isDragging, draggingTrimHandle, draggingSegmentBoundary, onDraggingChange]);

  // Calculate view bounds based on trim state
  const viewStart = isTrimming ? 0 : (trimPoints?.inPoint ?? 0);
  const viewEnd = isTrimming ? duration : (trimPoints?.outPoint ?? duration);
  const viewDuration = viewEnd - viewStart;

  // Calculate time from mouse position (view-aware)
  const getTimeFromEvent = useCallback((clientX: number): number => {
    if (!timelineRef.current) return 0;
    const rect = timelineRef.current.getBoundingClientRect();
    const x = clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, x / rect.width));
    return viewStart + (percentage * viewDuration);
  }, [viewStart, viewDuration]);

  // Handle mouse down - start dragging
  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
    const time = getTimeFromEvent(e.clientX);
    onSeek(time);
  }, [getTimeFromEvent, onSeek]);

  // Handle touch start - start dragging
  const handleTouchStart = useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    setIsDragging(true);
    const time = getTimeFromEvent(e.touches[0].clientX);
    onSeek(time);
  }, [getTimeFromEvent, onSeek]);

  // Handle mouse/touch move while dragging (playhead, trim handles, or segment boundaries)
  useEffect(() => {
    if (!isDragging && !draggingTrimHandle && draggingSegmentBoundary === null) return;

    const handleMouseMove = (e: MouseEvent) => {
      const time = getTimeFromEvent(e.clientX);

      if (draggingTrimHandle && trimPoints && onTrimChange) {
        let previewTime: number;
        if (draggingTrimHandle === 'in') {
          // In point can't go past out point - 1 second
          const newInPoint = Math.max(0, Math.min(time, trimPoints.outPoint - 1));
          onTrimChange({ ...trimPoints, inPoint: newInPoint });
          previewTime = newInPoint;
        } else {
          // Out point can't go before in point + 1 second
          const newOutPoint = Math.min(duration, Math.max(time, trimPoints.inPoint + 1));
          onTrimChange({ ...trimPoints, outPoint: newOutPoint });
          previewTime = newOutPoint;
        }
        // Preview video at the trim position
        onTrimPreview?.(previewTime);
      } else if (draggingSegmentBoundary !== null && onCameraSegmentsChange) {
        // Dragging a segment boundary - adjust the start time of this segment (and end time of previous)
        const segIdx = draggingSegmentBoundary;
        if (segIdx > 0 && segIdx < cameraSegments.length) {
          const prevSeg = cameraSegments[segIdx - 1];
          const currSeg = cameraSegments[segIdx];
          // Boundary can't go before previous segment's start + 0.5s or after current segment's end - 0.5s
          const minTime = prevSeg.startTime + 0.5;
          const maxTime = currSeg.endTime - 0.5;
          const newBoundary = Math.max(minTime, Math.min(maxTime, time));

          const newSegments = cameraSegments.map((seg, idx) => {
            if (idx === segIdx - 1) {
              return { ...seg, endTime: newBoundary };
            } else if (idx === segIdx) {
              return { ...seg, startTime: newBoundary };
            }
            return seg;
          });
          onCameraSegmentsChange(newSegments);
          onTrimPreview?.(newBoundary);
        }
      } else if (isDragging) {
        onSeek(time);
      }
    };

    const handleTouchMove = (e: TouchEvent) => {
      const time = getTimeFromEvent(e.touches[0].clientX);

      if (draggingTrimHandle && trimPoints && onTrimChange) {
        let previewTime: number;
        if (draggingTrimHandle === 'in') {
          const newInPoint = Math.max(0, Math.min(time, trimPoints.outPoint - 1));
          onTrimChange({ ...trimPoints, inPoint: newInPoint });
          previewTime = newInPoint;
        } else {
          const newOutPoint = Math.min(duration, Math.max(time, trimPoints.inPoint + 1));
          onTrimChange({ ...trimPoints, outPoint: newOutPoint });
          previewTime = newOutPoint;
        }
        onTrimPreview?.(previewTime);
      } else if (draggingSegmentBoundary !== null && onCameraSegmentsChange) {
        const segIdx = draggingSegmentBoundary;
        if (segIdx > 0 && segIdx < cameraSegments.length) {
          const prevSeg = cameraSegments[segIdx - 1];
          const currSeg = cameraSegments[segIdx];
          const minTime = prevSeg.startTime + 0.5;
          const maxTime = currSeg.endTime - 0.5;
          const newBoundary = Math.max(minTime, Math.min(maxTime, time));

          const newSegments = cameraSegments.map((seg, idx) => {
            if (idx === segIdx - 1) {
              return { ...seg, endTime: newBoundary };
            } else if (idx === segIdx) {
              return { ...seg, startTime: newBoundary };
            }
            return seg;
          });
          onCameraSegmentsChange(newSegments);
          onTrimPreview?.(newBoundary);
        }
      } else if (isDragging) {
        onSeek(time);
      }
    };

    const handleEnd = () => {
      setIsDragging(false);
      setDraggingTrimHandle(null);
      setDraggingSegmentBoundary(null);
      // Clear preview when done dragging
      onTrimPreview?.(null);
    };

    // Listen on document to catch events outside the component
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleTouchMove);
    document.addEventListener('touchend', handleEnd);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleEnd);
    };
  }, [isDragging, draggingTrimHandle, draggingSegmentBoundary, getTimeFromEvent, onSeek, trimPoints, onTrimChange, onTrimPreview, duration, cameraSegments, onCameraSegmentsChange]);

  // Handle trim handle mouse down
  const handleTrimHandleMouseDown = useCallback((handle: 'in' | 'out') => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingTrimHandle(handle);
  }, []);

  
  // Handle segment boundary drag start
  const handleSegmentBoundaryMouseDown = useCallback((segmentIndex: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDraggingSegmentBoundary(segmentIndex);
  }, []);

  // Handle segment boundary double-click to remove
  const handleSegmentBoundaryDoubleClick = useCallback((segmentIndex: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!onCameraSegmentsChange || segmentIndex <= 0 || segmentIndex >= cameraSegments.length) return;

    // Merge this segment with the previous one (remove the boundary)
    const newSegments = cameraSegments.filter((_, idx) => idx !== segmentIndex).map((seg, idx, arr) => {
      // Extend the previous segment to cover the removed one's time
      if (idx === segmentIndex - 1) {
        const removedSeg = cameraSegments[segmentIndex];
        return { ...seg, endTime: removedSeg.endTime };
      }
      return seg;
    });
    onCameraSegmentsChange(newSegments);
  }, [cameraSegments, onCameraSegmentsChange]);

  // Handle segment click to change its angle
  const handleSegmentClick = useCallback((segmentIndex: number, newAngle: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!onCameraSegmentsChange) return;

    const newSegments = cameraSegments.map((seg, idx) => {
      if (idx === segmentIndex) {
        return { ...seg, angle: newAngle };
      }
      return seg;
    });

    // Merge adjacent segments with the same angle
    const merged: CameraSegment[] = [];
    for (const seg of newSegments) {
      const last = merged[merged.length - 1];
      if (last && last.angle === seg.angle && Math.abs(last.endTime - seg.startTime) < 0.1) {
        last.endTime = seg.endTime;
      } else {
        merged.push({ ...seg });
      }
    }
    onCameraSegmentsChange(merged);
  }, [cameraSegments, onCameraSegmentsChange]);

  // Handle drag start from angle palette
  const handleAngleDragStart = useCallback((angle: string, e: React.MouseEvent) => {
    setDraggingAngle(angle);
    setDragPosition({ x: e.clientX, y: e.clientY });
  }, []);

  // Handle drop on camera track
  const handleCameraTrackDrop = useCallback((e: React.MouseEvent) => {
    if (!draggingAngle || !cameraTrackRef.current || !onCameraSegmentsChange || !trimPoints) return;

    const rect = cameraTrackRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, x / rect.width));

    // Calculate time relative to trimmed portion
    const trimStart = trimPoints.inPoint;
    const trimEnd = trimPoints.outPoint;
    const trimDuration = trimEnd - trimStart;
    const dropTime = trimStart + (percentage * trimDuration);

    // Find which segment was dropped on and split it
    const segIdx = cameraSegments.findIndex(
      seg => dropTime >= seg.startTime && dropTime < seg.endTime
    );

    if (segIdx === -1) {
      setDraggingAngle(null);
      return;
    }

    const clickedSegment = cameraSegments[segIdx];

    // If dropping near the start, just change the segment's angle
    if (Math.abs(dropTime - clickedSegment.startTime) < 0.5) {
      const newSegments = cameraSegments.map((seg, idx) =>
        idx === segIdx ? { ...seg, angle: draggingAngle } : seg
      );
      onCameraSegmentsChange(newSegments);
    } else {
      // Split the segment
      const newSegments = [...cameraSegments];
      newSegments.splice(segIdx, 1,
        { startTime: clickedSegment.startTime, endTime: dropTime, angle: clickedSegment.angle },
        { startTime: dropTime, endTime: clickedSegment.endTime, angle: draggingAngle }
      );

      // Merge adjacent segments with same angle
      const merged: CameraSegment[] = [];
      for (const seg of newSegments) {
        const last = merged[merged.length - 1];
        if (last && last.angle === seg.angle && Math.abs(last.endTime - seg.startTime) < 0.1) {
          last.endTime = seg.endTime;
        } else {
          merged.push({ ...seg });
        }
      }
      onCameraSegmentsChange(merged);
    }

    setDraggingAngle(null);
  }, [draggingAngle, cameraSegments, onCameraSegmentsChange, trimPoints]);

  // Track mouse movement and cancel drag on mouse up
  useEffect(() => {
    if (!draggingAngle) return;

    const handleMouseMove = (e: MouseEvent) => {
      setDragPosition({ x: e.clientX, y: e.clientY });
    };

    const handleMouseUp = () => {
      setDraggingAngle(null);
      setDragPosition(null);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [draggingAngle]);

  if (duration <= 0) {
    return null;
  }

  // Format time as m:ss
  const formatTimeShort = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  // Calculate trim values (viewStart/viewEnd/viewDuration already calculated above for getTimeFromEvent)
  const trimStart = trimPoints?.inPoint ?? 0;
  const trimEnd = trimPoints?.outPoint ?? duration;
  const trimmedDuration = trimEnd - trimStart;
  const isTrimmed = trimStart > 0 || trimEnd < duration;

  // Calculate positions relative to current view
  const timeToPosition = (time: number) => ((time - viewStart) / viewDuration) * 100;
  const playheadPosition = timeToPosition(Math.max(viewStart, Math.min(viewEnd, currentTime)));

  // Trim handle positions (relative to full timeline, only when trimming)
  const inPointPosition = trimPoints ? (trimPoints.inPoint / duration) * 100 : 0;
  const outPointPosition = trimPoints ? (trimPoints.outPoint / duration) * 100 : 100;

  // Generate time markers
  const timeMarkers = useMemo(() => {
    const markers: number[] = [];
    const interval = viewDuration > 120 ? 30 : 15;
    for (let t = viewStart; t <= viewEnd; t += interval) {
      markers.push(t);
    }
    if (markers[markers.length - 1] !== viewEnd) {
      markers.push(viewEnd);
    }
    return markers;
  }, [viewStart, viewEnd, viewDuration]);

  // Filter camera segments to current view
  const visibleCameraSegments = useMemo(() => {
    // When trimming, show full timeline; when not trimming, show trimmed portion
    const rangeStart = isTrimming ? 0 : trimStart;
    const rangeEnd = isTrimming ? duration : trimEnd;

    return cameraSegments
      .filter(seg => seg.endTime > rangeStart && seg.startTime < rangeEnd)
      .map(seg => ({
        ...seg,
        startTime: Math.max(seg.startTime, rangeStart),
        endTime: Math.min(seg.endTime, rangeEnd),
      }));
  }, [cameraSegments, isTrimming, trimStart, trimEnd, duration]);

  // Greyed out and locked when the current layout/format ignores the camera track
  const cameraTrackLock = cameraTrackActive ? '' : 'opacity-40 grayscale pointer-events-none select-none';

  return (
    <div className="bg-gray-800/50 rounded-xl p-3 space-y-2">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xs text-gray-400 font-medium">
            {isTrimming ? 'Trim Video' : 'Timeline'}
          </span>

          {/* Trim info badge */}
          {isEditMode && !isTrimming && isTrimmed && (
            <span className="text-[10px] bg-yellow-500/20 text-yellow-400 px-2 py-0.5 rounded font-medium">
              {formatTimeShort(trimStart)} → {formatTimeShort(trimEnd)} ({formatTimeShort(trimmedDuration)})
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Trim button / Done button */}
          {isEditMode && (
            isTrimming ? (
              <button
                onClick={() => onTrimmingChange?.(false)}
                className="px-3 py-1 text-xs font-medium bg-yellow-500 text-black rounded-lg hover:bg-yellow-400 transition-colors"
              >
                Done
              </button>
            ) : (
              <button
                onClick={() => onTrimmingChange?.(true)}
                className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors ${
                  isTrimmed
                    ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {isTrimmed ? 'Edit Trim' : 'Trim'}
              </button>
            )
          )}

          {/* Track legend */}
          {event && (
            <div className="flex items-center gap-1">
              <div className="w-2 h-2 rotate-45 bg-orange-500" />
              <span className="text-[10px] text-orange-400 font-medium">{event.reasonLabel}</span>
            </div>
          )}
          {tracks.map((track) => (
            <div key={track.id} className="flex items-center gap-1">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: track.color }} />
              <span className="text-[10px] text-gray-500">{track.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Trim mode instructions */}
      {isTrimming && (
        <div className="text-[10px] text-yellow-400">
          Drag the yellow handles to set start and end points, then click Done
        </div>
      )}

      {/* Main Timeline */}
      <div
        ref={timelineRef}
        className={`relative select-none min-h-[60px] rounded bg-gray-700/30 ${isDragging || draggingTrimHandle ? 'cursor-grabbing' : 'cursor-pointer'}`}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
      >
        {/* Clip boundary markers */}
        {clipBoundaries.length > 1 && clipBoundaries.slice(1).map((boundary, idx) => {
          if (boundary < viewStart || boundary > viewEnd) return null;
          return (
            <div
              key={`clip-${idx}`}
              className="absolute top-0 bottom-0 w-0.5 z-[2] pointer-events-none"
              style={{
                left: `${timeToPosition(boundary)}%`,
                background: 'repeating-linear-gradient(to bottom, #3b82f6 0, #3b82f6 4px, transparent 4px, transparent 8px)',
              }}
              title={`Clip ${idx + 2} start`}
            />
          );
        })}

        {/* Event marker */}
        {eventAbsoluteTime !== null && eventAbsoluteTime >= viewStart && eventAbsoluteTime <= viewEnd && (
          <div
            className="absolute top-0 bottom-0 z-[6] group"
            style={{ left: `${timeToPosition(eventAbsoluteTime)}%` }}
            onMouseEnter={() => setShowEventTooltip(true)}
            onMouseLeave={() => setShowEventTooltip(false)}
          >
            {/* Vertical line */}
            <div className="absolute top-0 bottom-0 w-0.5 bg-orange-500 -translate-x-1/2 pointer-events-none" />
            {/* Diamond marker */}
            <div className="absolute -top-2 left-1/2 -translate-x-1/2 w-4 h-4 pointer-events-auto cursor-default">
              <div className="w-3 h-3 bg-orange-500 rotate-45 transform mx-auto border border-orange-300 shadow-lg shadow-orange-500/30" />
            </div>
            {/* Tooltip */}
            {showEventTooltip && event && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 pointer-events-none z-[20]">
                <div className="bg-gray-900 border border-orange-500/40 rounded-lg px-3 py-2 text-xs shadow-xl whitespace-nowrap">
                  <div className="font-semibold text-orange-400">{event.reasonLabel}</div>
                  {(event.city || event.street) && (
                    <div className="text-gray-400 mt-0.5">
                      {[event.street, event.city].filter(Boolean).join(', ')}
                    </div>
                  )}
                  <div className="text-gray-500 mt-0.5 text-[10px]">
                    {event.timestamp.toLocaleTimeString()}
                  </div>
                </div>
                <div className="absolute top-full left-1/2 -translate-x-1/2 w-2 h-2 bg-gray-900 border-r border-b border-orange-500/40 rotate-45 -mt-1" />
              </div>
            )}
          </div>
        )}

        {/* Time interval lines */}
        {timeMarkers.slice(1, -1).map((time) => (
          <div
            key={time}
            className="absolute top-0 bottom-0 w-px bg-gray-600/50 z-[1] pointer-events-none"
            style={{ left: `${timeToPosition(time)}%` }}
          />
        ))}

        {/* Telemetry tracks */}
        {tracks.map((track) => (
          <div
            key={track.id}
            className="relative h-3 bg-gray-700/50 rounded-sm mb-0.5 overflow-hidden"
            title={track.label}
          >
            {track.segments.map((segment, idx) => {
              if (segment.endTime < viewStart || segment.startTime > viewEnd) return null;
              const segStart = Math.max(segment.startTime, viewStart);
              const segEnd = Math.min(segment.endTime, viewEnd);
              const left = timeToPosition(segStart);
              const width = ((segEnd - segStart) / viewDuration) * 100;
              const opacity = segment.intensity !== undefined ? 0.4 + segment.intensity * 0.6 : 0.9;

              return (
                <div
                  key={idx}
                  className="absolute top-0 bottom-0 rounded-sm"
                  style={{
                    left: `${left}%`,
                    width: `${Math.max(width, 0.5)}%`,
                    backgroundColor: track.color,
                    opacity,
                  }}
                />
              );
            })}
          </div>
        ))}

        {/* === TRIM UI (only when trimming) === */}
        {isTrimming && trimPoints && (
          <>
            {/* Dimmed regions */}
            <div
              className="absolute top-0 bottom-0 bg-black/50 z-[3] pointer-events-none"
              style={{ left: 0, width: `${inPointPosition}%` }}
            />
            <div
              className="absolute top-0 bottom-0 bg-black/50 z-[3] pointer-events-none"
              style={{ left: `${outPointPosition}%`, width: `${100 - outPointPosition}%` }}
            />

            {/* Yellow frame */}
            <div
              className="absolute top-0 h-1 bg-yellow-500 z-[14] pointer-events-none"
              style={{ left: `${inPointPosition}%`, width: `${outPointPosition - inPointPosition}%` }}
            />
            <div
              className="absolute bottom-0 h-1 bg-yellow-500 z-[14] pointer-events-none"
              style={{ left: `${inPointPosition}%`, width: `${outPointPosition - inPointPosition}%` }}
            />

            {/* In handle */}
            <div
              className={`absolute top-0 bottom-0 w-4 bg-yellow-500 z-[15] cursor-ew-resize rounded-l-md ${
                draggingTrimHandle === 'in' ? 'bg-yellow-400 w-5 shadow-lg shadow-yellow-500/50' : 'hover:bg-yellow-400'
              }`}
              style={{ left: `${inPointPosition}%`, transform: 'translateX(-100%)' }}
              onMouseDown={handleTrimHandleMouseDown('in')}
              title={`In: ${formatTimeShort(trimPoints.inPoint)}`}
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <svg className="w-3 h-3 text-black/70" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M10 17l5-5-5-5v10z" />
                </svg>
              </div>
            </div>

            {/* Out handle */}
            <div
              className={`absolute top-0 bottom-0 w-4 bg-yellow-500 z-[15] cursor-ew-resize rounded-r-md ${
                draggingTrimHandle === 'out' ? 'bg-yellow-400 w-5 shadow-lg shadow-yellow-500/50' : 'hover:bg-yellow-400'
              }`}
              style={{ left: `${outPointPosition}%` }}
              onMouseDown={handleTrimHandleMouseDown('out')}
              title={`Out: ${formatTimeShort(trimPoints.outPoint)}`}
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <svg className="w-3 h-3 text-black/70" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M14 7l-5 5 5 5V7z" />
                </svg>
              </div>
            </div>
          </>
        )}

        {/* Playhead */}
        <div
          className={`absolute top-0 bottom-0 w-0.5 bg-white shadow-lg z-[16] pointer-events-none ${
            isDragging ? 'w-1' : ''
          }`}
          style={{ left: `${playheadPosition}%` }}
        >
          <div className={`absolute -top-1 left-1/2 -translate-x-1/2 bg-white rounded-full ${
            isDragging ? 'w-3 h-3 -top-1.5' : 'w-2 h-2'
          }`} />
        </div>
      </div>

      {/* Time legend */}
      <div className="relative h-4">
        {timeMarkers.map((time, idx) => {
          const position = timeToPosition(time);
          const isFirst = idx === 0;
          const isLast = idx === timeMarkers.length - 1;

          return (
            <div
              key={time}
              className="absolute flex flex-col items-center pointer-events-none"
              style={{
                left: `${position}%`,
                transform: isFirst ? 'translateX(0)' : isLast ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              <div className="w-px h-1.5 bg-gray-600" />
              <span className="text-[9px] text-gray-500 tabular-nums">{formatTimeShort(time)}</span>
            </div>
          );
        })}
      </div>

      {/* === CAMERA TRACK (always visible, inactive outside Single/PiP landscape) === */}
      {cameraSegments.length > 0 && (
        <div className="border-t border-gray-700 pt-3 mt-1">
          <div className="flex items-center justify-between mb-2">
            <span className={`text-xs font-medium ${cameraTrackActive ? 'text-purple-400' : 'text-gray-500'}`}>Camera Track</span>
            <span className="text-[10px] text-gray-500">
              {cameraTrackActive && cameraSegments.length > 1 ? 'Drag boundaries • Double-click to remove' : ''}
            </span>
          </div>

          {/* Angle palette with drag instruction */}
          <div className={`flex items-center gap-2 mb-2 ${cameraTrackLock}`} aria-disabled={!cameraTrackActive}>
            <div className="flex items-center gap-1">
              {availableAngles.map((angle) => (
                <div
                  key={angle}
                  className={`px-2 py-1.5 rounded text-[10px] font-medium select-none transition-all shadow-sm ${
                    draggingAngle === angle
                      ? 'opacity-50 scale-95 cursor-grabbing'
                      : 'cursor-grab hover:scale-105 hover:shadow-md active:scale-95'
                  }`}
                  style={{
                    backgroundColor: ANGLE_COLORS[angle] || '#6B7280',
                    color: 'white',
                    boxShadow: draggingAngle === angle ? 'none' : '0 2px 4px rgba(0,0,0,0.3)'
                  }}
                  onMouseDown={cameraTrackActive ? (e) => handleAngleDragStart(angle, e) : undefined}
                  title={`Drag ${ANGLE_LABELS[angle] || angle} to timeline`}
                >
                  {ANGLE_LABELS[angle] || angle}
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1 text-[10px] text-gray-500">
              <svg className="w-4 h-4 text-purple-400 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 13l-5 5m0 0l-5-5m5 5V6" />
              </svg>
              <span>drag to track</span>
            </div>
          </div>

          {/* Camera track - drop zone */}
          <div
            ref={cameraTrackRef}
            className={`relative h-10 bg-gray-700/30 rounded-lg overflow-visible border-2 border-dashed transition-all ${
              draggingAngle
                ? 'border-purple-500 bg-purple-500/10'
                : 'border-gray-600/50'
            } ${cameraTrackLock}`}
            aria-disabled={!cameraTrackActive}
            onMouseUp={cameraTrackActive && draggingAngle ? handleCameraTrackDrop : undefined}
          >
            {visibleCameraSegments.map((segment, idx) => {
              const left = timeToPosition(segment.startTime);
              const width = ((segment.endTime - segment.startTime) / viewDuration) * 100;

              return (
                <div
                  key={idx}
                  className="absolute top-1 bottom-1 flex items-center justify-center rounded transition-all hover:brightness-110"
                  style={{
                    left: `${left}%`,
                    width: `${Math.max(width, 1)}%`,
                    backgroundColor: ANGLE_COLORS[segment.angle] || '#6B7280',
                  }}
                  title={ANGLE_LABELS[segment.angle]}
                >
                  {width > 8 && (
                    <span className="text-[10px] text-white/90 font-medium truncate px-1 pointer-events-none">
                      {ANGLE_LABELS[segment.angle] || segment.angle}
                    </span>
                  )}
                </div>
              );
            })}

            {/* Segment boundaries - draggable */}
            {cameraSegments.slice(1).map((segment, idx) => {
              if (segment.startTime <= trimStart || segment.startTime >= trimEnd) return null;
              const position = timeToPosition(segment.startTime);

              return (
                <div
                  key={`boundary-${idx}`}
                  className={`absolute top-0 bottom-0 w-4 cursor-ew-resize z-[5] group ${
                    draggingSegmentBoundary === idx + 1 ? 'z-[10]' : ''
                  }`}
                  style={{ left: `${position}%`, transform: 'translateX(-50%)' }}
                  onMouseDown={cameraTrackActive ? handleSegmentBoundaryMouseDown(idx + 1) : undefined}
                  onDoubleClick={cameraTrackActive ? handleSegmentBoundaryDoubleClick(idx + 1) : undefined}
                  title="Drag to adjust • Double-click to remove"
                >
                  <div className={`absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-1 ${
                    draggingSegmentBoundary === idx + 1 ? 'bg-white w-1.5 shadow-lg' : 'bg-white/60 group-hover:bg-white'
                  }`} />
                  <div className={`absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rounded-full border-2 border-white shadow ${
                    draggingSegmentBoundary === idx + 1 ? 'bg-purple-500 scale-110' : 'bg-gray-600 group-hover:bg-purple-500'
                  }`} />
                  <div className={`absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-3 rounded-full border-2 border-white shadow ${
                    draggingSegmentBoundary === idx + 1 ? 'bg-purple-500 scale-110' : 'bg-gray-600 group-hover:bg-purple-500'
                  }`} />
                </div>
              );
            })}

            {/* Drop indicator when dragging */}
            {draggingAngle && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none bg-purple-500/20 rounded-lg">
                <div className="flex items-center gap-2 text-sm text-purple-300 bg-black/60 px-3 py-1.5 rounded-full">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m0 0l-4-4m4 4l4-4" />
                  </svg>
                  Drop {ANGLE_LABELS[draggingAngle] || draggingAngle} here
                </div>
              </div>
            )}
          </div>

          {/* Playback hint, or why the track is locked */}
          <div className="text-[10px] text-gray-500 mt-1.5">
            {cameraTrackActive
              ? 'Press play to preview camera switches'
              : 'Camera track applies to Single and PiP layouts in landscape formats'}
          </div>
        </div>
      )}

      {/* Drag ghost - floating badge that follows cursor */}
      {draggingAngle && dragPosition && (
        <div
          className="fixed pointer-events-none z-[1000] px-3 py-1.5 rounded text-xs font-medium shadow-lg transform -translate-x-1/2 -translate-y-1/2"
          style={{
            left: dragPosition.x,
            top: dragPosition.y,
            backgroundColor: ANGLE_COLORS[draggingAngle] || '#6B7280',
            color: 'white',
            boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
          }}
        >
          {ANGLE_LABELS[draggingAngle] || draggingAngle}
        </div>
      )}
    </div>
  );
}
