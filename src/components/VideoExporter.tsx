'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { IconDownload, IconPlayerStop, IconLoader2, IconCheck, IconAlertTriangle, IconRefresh } from '@tabler/icons-react';
import { SeiData, SeiWithFrameIndex } from '@/lib/dashcam-mp4';
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { VideoSequence, TrimPoints, CameraSegment, formatDuration, LayoutCameraConfig, DEFAULT_LAYOUT_CONFIG, ANGLE_LABELS, FormatType, getFormatPreset, PortraitLayoutType, PortraitCameraConfig, getPortraitLayout, DEFAULT_PORTRAIT_CAMERA_CONFIG, AlignPosition, PortraitAlignConfig, DEFAULT_PORTRAIT_ALIGN_CONFIG } from '@/types/video';
import { Tooltip } from './Tooltip';

type LayoutType = 'single' | 'pip' | 'triple' | 'all';

// Gap between cells of the all-cameras grid, scaled to the export width
const getAllGridGap = (width: number) => Math.max(2, Math.round(width / 480));

const LAYOUT_LABELS: Record<LayoutType, string> = {
  single: 'Single',
  pip: 'PiP',
  triple: 'Triple',
  all: 'All 6',
};

// One-line summary of what an export renders, e.g. "All 6 · Original · 0:12–0:45"
function describeExport({
  layout,
  format,
  portraitLayout,
  selectedAngle,
  cameraSegments,
  trimPoints,
  totalDuration,
}: {
  layout: LayoutType;
  format: FormatType;
  portraitLayout: PortraitLayoutType;
  selectedAngle: string;
  cameraSegments: CameraSegment[];
  trimPoints?: TrimPoints | null;
  totalDuration: number;
}): string {
  const preset = getFormatPreset(format);
  const isPortrait = preset.aspectRatio > 0 && preset.aspectRatio < 1;

  let layoutLabel: string;
  if (isPortrait) {
    layoutLabel = getPortraitLayout(portraitLayout).label;
  } else if (layout === 'single') {
    // Single exports one camera, or follows the custom camera track
    const angles = new Set(cameraSegments.map(s => s.angle));
    const angle = cameraSegments[0]?.angle ?? selectedAngle;
    layoutLabel = angles.size > 1 ? 'Camera track' : `${ANGLE_LABELS[angle] || angle} camera`;
  } else {
    layoutLabel = LAYOUT_LABELS[layout];
  }

  const parts = [layoutLabel, preset.label];
  const inPoint = trimPoints?.inPoint ?? 0;
  const outPoint = trimPoints?.outPoint ?? totalDuration;
  if (inPoint > 0 || outPoint < totalDuration) {
    parts.push(`${formatDuration(inPoint)}–${formatDuration(outPoint)}`);
  }
  return parts.join(' · ');
}

interface VideoExporterProps {
  sequence: VideoSequence;
  selectedAngle: string;
  allSeiMessages: SeiWithFrameIndex[];
  fps: number;
  speedUnit: 'mph' | 'kmh';
  filename?: string;
  trimPoints?: TrimPoints | null;
  cameraSegments?: CameraSegment[];
  showTelemetry?: boolean;
  showDateTime?: boolean;
  showMap?: boolean;
  layout?: LayoutType;
  layoutConfig?: LayoutCameraConfig;
  format?: FormatType;
  portraitLayout?: PortraitLayoutType;
  portraitCameraConfig?: PortraitCameraConfig;
  portraitAlignConfig?: PortraitAlignConfig;
}

// Map tile cache
const tileCache = new Map<string, HTMLImageElement>();

// Telemetry icon cache
interface TelemetryIcons {
  wheel: HTMLImageElement | null;
  leftPedal: HTMLImageElement | null;
  rightPedal: HTMLImageElement | null;
  blinker: HTMLImageElement | null;
}

// Load an image with promise
async function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// Load all telemetry icons
async function loadTelemetryIcons(): Promise<TelemetryIcons> {
  const [wheel, leftPedal, rightPedal, blinker] = await Promise.all([
    loadImage('/wheel.svg'),
    loadImage('/left-pedal.png'),
    loadImage('/right-pedal.png'),
    loadImage('/blinker.svg'),
  ]);
  return { wheel, leftPedal, rightPedal, blinker };
}

// Convert lat/lng to tile coordinates
function latLngToTile(lat: number, lng: number, zoom: number): { x: number; y: number } {
  const x = Math.floor(((lng + 180) / 360) * Math.pow(2, zoom));
  const y = Math.floor(
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) *
      Math.pow(2, zoom)
  );
  return { x, y };
}

// Get pixel position within tile
function latLngToPixelOffset(lat: number, lng: number, zoom: number): { px: number; py: number } {
  const scale = Math.pow(2, zoom) * 256;
  const px = ((lng + 180) / 360) * scale;
  const py =
    ((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * scale;
  return { px: px % 256, py: py % 256 };
}

// Load map tile with caching
async function loadMapTile(x: number, y: number, zoom: number): Promise<HTMLImageElement | null> {
  const key = `${zoom}/${x}/${y}`;
  if (tileCache.has(key)) {
    return tileCache.get(key)!;
  }

  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      tileCache.set(key, img);
      resolve(img);
    };
    img.onerror = () => resolve(null);
    img.src = `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
  });
}

export function VideoExporter({
  sequence,
  selectedAngle,
  allSeiMessages,
  fps,
  speedUnit,
  filename = 'tesla-cam-export',
  trimPoints,
  cameraSegments = [],
  showTelemetry = true,
  showDateTime = true,
  showMap = true,
  layout = 'single',
  layoutConfig = DEFAULT_LAYOUT_CONFIG,
  format = 'original',
  portraitLayout = 'p-1-2',
  portraitCameraConfig = DEFAULT_PORTRAIT_CAMERA_CONFIG,
  portraitAlignConfig = DEFAULT_PORTRAIT_ALIGN_CONFIG,
}: VideoExporterProps) {
  const [isExporting, setIsExporting] = useState(false);
  const [isComplete, setIsComplete] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState('');
  const [exportUrl, setExportUrl] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSummary, setExportSummary] = useState('');
  const abortRef = useRef(false);

  // Cleanup
  useEffect(() => {
    return () => {
      if (exportUrl) URL.revokeObjectURL(exportUrl);
    };
  }, [exportUrl]);

  // Get SEI data for a specific time with GPS interpolation between sparse messages
  const getSeiForTime = useCallback(
    (time: number): SeiData | null => {
      if (allSeiMessages.length === 0) return null;

      const frameIndex = Math.floor(time * fps);

      // Binary search for last SEI message at or before this frame
      let left = 0;
      let right = allSeiMessages.length - 1;

      while (left < right) {
        const mid = Math.floor((left + right + 1) / 2);
        if (allSeiMessages[mid].frameIndex <= frameIndex) {
          left = mid;
        } else {
          right = mid - 1;
        }
      }

      const before = allSeiMessages[left];
      if (!before) return null;

      // Interpolate GPS between bracketing messages for smoother map tracking
      const after = allSeiMessages[left + 1];
      if (after && before.sei.latitude_deg && before.sei.longitude_deg &&
          after.sei.latitude_deg && after.sei.longitude_deg) {
        const span = after.frameIndex - before.frameIndex;
        if (span > 0) {
          const t = Math.min(1, Math.max(0, (frameIndex - before.frameIndex) / span));
          const lat = before.sei.latitude_deg + (after.sei.latitude_deg - before.sei.latitude_deg) * t;
          const lng = before.sei.longitude_deg + (after.sei.longitude_deg - before.sei.longitude_deg) * t;
          // Shortest-arc heading interpolation (handles 359°→1° wraparound)
          let dHeading = (after.sei.heading_deg || 0) - (before.sei.heading_deg || 0);
          if (dHeading > 180) dHeading -= 360;
          if (dHeading < -180) dHeading += 360;
          const heading = (before.sei.heading_deg || 0) + dHeading * t;
          return { ...before.sei, latitude_deg: lat, longitude_deg: lng, heading_deg: heading };
        }
      }

      return before.sei;
    },
    [allSeiMessages, fps]
  );

  // Get camera angle for a specific time based on camera segments
  const getAngleForTime = useCallback(
    (time: number): string => {
      if (cameraSegments.length === 0) return selectedAngle;

      for (const segment of cameraSegments) {
        if (time >= segment.startTime && time < segment.endTime) {
          return segment.angle;
        }
      }

      // Fallback to last segment's angle or selected angle
      return cameraSegments[cameraSegments.length - 1]?.angle || selectedAngle;
    },
    [cameraSegments, selectedAngle]
  );

  // Draw telemetry overlay on canvas - matches TelemetryCard.tsx layout
  const drawTelemetry = (
    ctx: CanvasRenderingContext2D,
    seiData: SeiData | null,
    width: number,
    height: number,
    icons: TelemetryIcons
  ) => {
    if (!seiData) return;

    // Portrait formats use smaller reference so overlays stay proportional to width
    const isPortrait = height > width;
    const scale = isPortrait
      ? Math.min(width / 540, height / 960)
      : Math.min(width / 1280, height / 720);
    const padding = 12 * scale;
    const circleSize = 28 * scale;
    const circleGap = 5 * scale;
    const columnWidth = circleSize;
    const blinkerWidth = 20 * scale;
    const speedWidth = 60 * scale;
    const gap = 10 * scale;

    // Calculate total width
    const boxWidth = columnWidth + gap + blinkerWidth + gap + speedWidth + gap + blinkerWidth + gap + columnWidth + padding * 2;
    const boxHeight = circleSize * 2 + circleGap + padding * 2;

    // Position at TOP CENTER
    const x = (width - boxWidth) / 2;
    const y = 12 * scale;

    // Draw background
    ctx.fillStyle = 'rgba(225, 225, 225, 0.85)';
    ctx.beginPath();
    ctx.roundRect(x, y, boxWidth, boxHeight, 12 * scale);
    ctx.fill();

    // Calculate positions
    let posX = x + padding;
    const topCircleY = y + padding + circleSize / 2;
    const bottomCircleY = y + padding + circleSize + circleGap + circleSize / 2;
    const centerY = y + boxHeight / 2;
    const iconSize = 16 * scale;

    // === Left Column: Gear + Brake ===
    // Gear circle
    ctx.fillStyle = '#a4a4a4';
    ctx.beginPath();
    ctx.arc(posX + circleSize / 2, topCircleY, circleSize / 2, 0, Math.PI * 2);
    ctx.fill();
    const gearLetter = ['P', 'D', 'R', 'N'][seiData.gear_state ?? 0] || 'P';
    ctx.fillStyle = '#006deb';
    ctx.font = `bold ${16 * scale}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(gearLetter, posX + circleSize / 2, topCircleY);

    // Brake circle with pedal icon
    ctx.fillStyle = seiData.brake_applied ? '#ff4444' : '#a4a4a4';
    ctx.beginPath();
    ctx.arc(posX + circleSize / 2, bottomCircleY, circleSize / 2, 0, Math.PI * 2);
    ctx.fill();
    if (icons.leftPedal) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.drawImage(
        icons.leftPedal,
        posX + circleSize / 2 - iconSize / 2,
        bottomCircleY - iconSize / 2,
        iconSize,
        iconSize
      );
      ctx.restore();
    }

    posX += columnWidth + gap;

    // === Left Blinker ===
    if (icons.blinker) {
      ctx.save();
      ctx.globalAlpha = seiData.blinker_on_left ? 1 : 0.3;
      ctx.drawImage(
        icons.blinker,
        posX,
        centerY - blinkerWidth / 2,
        blinkerWidth,
        blinkerWidth
      );
      ctx.restore();
    } else {
      ctx.fillStyle = seiData.blinker_on_left ? '#22c55e' : 'rgba(100, 100, 100, 0.3)';
      ctx.beginPath();
      ctx.moveTo(posX, centerY);
      ctx.lineTo(posX + blinkerWidth, centerY - 10 * scale);
      ctx.lineTo(posX + blinkerWidth, centerY + 10 * scale);
      ctx.closePath();
      ctx.fill();
    }

    posX += blinkerWidth + gap;

    // === Speed Display ===
    const speed = seiData.vehicle_speed_mps
      ? speedUnit === 'mph'
        ? Math.round(seiData.vehicle_speed_mps * 2.23694)
        : Math.round(seiData.vehicle_speed_mps * 3.6)
      : 0;

    ctx.fillStyle = '#333';
    ctx.font = `600 ${32 * scale}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(speed), posX + speedWidth / 2, centerY - 8 * scale);

    ctx.fillStyle = '#666';
    ctx.font = `600 ${12 * scale}px -apple-system, BlinkMacSystemFont, sans-serif`;
    ctx.fillText(speedUnit.toUpperCase(), posX + speedWidth / 2, centerY + 18 * scale);

    posX += speedWidth + gap;

    // === Right Blinker (rotated 180°) ===
    if (icons.blinker) {
      ctx.save();
      ctx.globalAlpha = seiData.blinker_on_right ? 1 : 0.3;
      ctx.translate(posX + blinkerWidth / 2, centerY);
      ctx.rotate(Math.PI);
      ctx.drawImage(
        icons.blinker,
        -blinkerWidth / 2,
        -blinkerWidth / 2,
        blinkerWidth,
        blinkerWidth
      );
      ctx.restore();
    } else {
      ctx.fillStyle = seiData.blinker_on_right ? '#22c55e' : 'rgba(100, 100, 100, 0.3)';
      ctx.beginPath();
      ctx.moveTo(posX + blinkerWidth, centerY);
      ctx.lineTo(posX, centerY - 10 * scale);
      ctx.lineTo(posX, centerY + 10 * scale);
      ctx.closePath();
      ctx.fill();
    }

    posX += blinkerWidth + gap;

    // === Right Column: Steering + Accelerator ===
    // Steering circle with wheel icon (blue when autopilot active)
    const isAutopilotActive = (seiData.autopilot_state ?? 0) > 0;
    ctx.fillStyle = isAutopilotActive ? '#006deb' : '#a4a4a4';
    ctx.beginPath();
    ctx.arc(posX + circleSize / 2, topCircleY, circleSize / 2, 0, Math.PI * 2);
    ctx.fill();

    const steeringAngle = seiData.steering_wheel_angle || 0;
    if (icons.wheel) {
      ctx.save();
      ctx.translate(posX + circleSize / 2, topCircleY);
      ctx.rotate((steeringAngle * Math.PI) / 180);
      ctx.globalAlpha = 0.5;
      ctx.drawImage(icons.wheel, -iconSize / 2, -iconSize / 2, iconSize, iconSize);
      ctx.restore();
    } else {
      ctx.save();
      ctx.translate(posX + circleSize / 2, topCircleY);
      ctx.rotate((steeringAngle * Math.PI) / 180);
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 2 * scale;
      ctx.beginPath();
      ctx.arc(0, 0, 8 * scale, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -8 * scale);
      ctx.lineTo(0, 8 * scale);
      ctx.stroke();
      ctx.restore();
    }

    // Accelerator circle with fill and pedal icon
    const rawAccel = seiData.accelerator_pedal_position || 0;
    const accelPercent = Math.min(100, rawAccel > 1 ? rawAccel : rawAccel * 100);

    ctx.fillStyle = '#a4a4a4';
    ctx.beginPath();
    ctx.arc(posX + circleSize / 2, bottomCircleY, circleSize / 2, 0, Math.PI * 2);
    ctx.fill();

    if (accelPercent > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(posX + circleSize / 2, bottomCircleY, circleSize / 2, 0, Math.PI * 2);
      ctx.clip();
      const fillHeight = (accelPercent / 100) * circleSize;
      const gradient = ctx.createLinearGradient(0, bottomCircleY + circleSize / 2, 0, bottomCircleY - circleSize / 2);
      gradient.addColorStop(0, '#4caf50');
      gradient.addColorStop(1, '#8bc34a');
      ctx.fillStyle = gradient;
      ctx.fillRect(posX, bottomCircleY + circleSize / 2 - fillHeight, circleSize, fillHeight);
      ctx.restore();
    }

    if (icons.rightPedal) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.drawImage(
        icons.rightPedal,
        posX + circleSize / 2 - iconSize / 2,
        bottomCircleY - iconSize / 2,
        iconSize,
        iconSize
      );
      ctx.restore();
    }

    // === Autopilot label ===
    if (isAutopilotActive) {
      const autopilotLabels: Record<number, string> = { 1: 'Self Driving', 2: 'Autosteer', 3: 'TACC' };
      const label = autopilotLabels[seiData.autopilot_state ?? 0] || '';
      if (label) {
        ctx.font = `600 ${11 * scale}px -apple-system, BlinkMacSystemFont, sans-serif`;
        const labelWidth = ctx.measureText(label).width + 24 * scale;
        const labelX = (width - labelWidth) / 2;
        const labelY = y + boxHeight - 1;

        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.beginPath();
        ctx.roundRect(labelX, labelY, labelWidth, 20 * scale, [0, 0, 8 * scale, 8 * scale]);
        ctx.fill();

        ctx.fillStyle = '#006deb';
        ctx.textAlign = 'center';
        ctx.fillText(label, width / 2, labelY + 12 * scale);
      }
    }
  };

  // Draw date/time overlay
  const drawDateTime = (
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    date: string,
    time: string,
    telemetryVisible: boolean,
    isAutopilotActive: boolean
  ) => {
    const isPortrait = height > width;
    const scale = isPortrait
      ? Math.min(width / 720, height / 1280)
      : Math.min(width / 1280, height / 720);
    const padding = 12 * scale;

    // Format the date/time string
    const dateTimeStr = `${date}  ${time}`;

    ctx.font = `600 ${14 * scale}px -apple-system, BlinkMacSystemFont, sans-serif`;
    const textWidth = ctx.measureText(dateTimeStr).width;
    const boxWidth = textWidth + padding * 2;
    const boxHeight = 28 * scale;

    // Position: if telemetry is visible, position below it; otherwise top center
    const x = (width - boxWidth) / 2;
    let y: number;

    if (telemetryVisible) {
      // Calculate telemetry box height (same logic as in drawTelemetry)
      const circleSize = 28 * scale;
      const circleGap = 5 * scale;
      const telemetryBoxHeight = circleSize * 2 + circleGap + padding * 2;
      const telemetryY = 12 * scale;
      let telemetryBottom = telemetryY + telemetryBoxHeight;
      if (isAutopilotActive) {
        // Autopilot label in drawTelemetry starts at (y + boxHeight - 1) with height 20*scale
        telemetryBottom = telemetryY + telemetryBoxHeight - 1 + 20 * scale;
      }
      // Position just below telemetry (or autopilot label) with a small gap
      y = telemetryBottom + 8 * scale;
    } else {
      // Position at top center
      y = 12 * scale;
    }

    // Draw background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.beginPath();
    ctx.roundRect(x, y, boxWidth, boxHeight, 6 * scale);
    ctx.fill();

    // Draw text
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(dateTimeStr, width / 2, y + boxHeight / 2);
  };

  // Draw mini map with actual map tiles
  const drawMiniMap = async (
    ctx: CanvasRenderingContext2D,
    seiData: SeiData | null,
    width: number,
    height: number,
    position: 'top-right' | 'bottom-right' | { x: number; y: number; size: number } = 'bottom-right'
  ) => {
    if (!seiData?.latitude_deg || !seiData?.longitude_deg) return;
    if (seiData.latitude_deg === 0 && seiData.longitude_deg === 0) return;

    const isPortraitMap = height > width;
    const scale = isPortraitMap
      ? Math.min(width / 540, height / 960)
      : Math.min(width / 1280, height / 720);
    const mapSize = typeof position === 'object' ? position.size : 160 * scale;
    const padding = 12 * scale;
    const x = typeof position === 'object' ? position.x : width - mapSize - padding;
    const y = typeof position === 'object' ? position.y : position === 'top-right' ? padding : height - mapSize - padding;

    const lat = seiData.latitude_deg;
    const lng = seiData.longitude_deg;
    const zoom = 17;

    // Get tile coordinates
    const tile = latLngToTile(lat, lng, zoom);
    const offset = latLngToPixelOffset(lat, lng, zoom);

    // Draw map background
    ctx.fillStyle = '#1e293b';
    ctx.beginPath();
    ctx.roundRect(x, y, mapSize, mapSize, 8 * scale);
    ctx.fill();

    // Clip to rounded rectangle
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, mapSize, mapSize, 8 * scale);
    ctx.clip();

    // Load and draw tiles (3x3 grid around center)
    const tileSize = 256;
    const centerX = x + mapSize / 2;
    const centerY = y + mapSize / 2;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const tileImg = await loadMapTile(tile.x + dx, tile.y + dy, zoom);
        if (tileImg) {
          const tileX = centerX - offset.px + dx * tileSize;
          const tileY = centerY - offset.py + dy * tileSize;
          ctx.drawImage(tileImg, tileX, tileY, tileSize, tileSize);
        }
      }
    }

    ctx.restore();

    // Draw car marker in center
    const heading = seiData.heading_deg || 0;
    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate((heading * Math.PI) / 180);

    ctx.fillStyle = '#3B82F6';
    ctx.strokeStyle = '#1E40AF';
    ctx.lineWidth = 2 * scale;
    ctx.beginPath();
    ctx.moveTo(0, -14 * scale);
    ctx.lineTo(-10 * scale, 10 * scale);
    ctx.lineTo(0, 5 * scale);
    ctx.lineTo(10 * scale, 10 * scale);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.restore();

    // Coordinates overlay at bottom
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    const coordBoxY = y + mapSize - 20 * scale;
    ctx.beginPath();
    ctx.roundRect(x, coordBoxY, mapSize, 20 * scale, [0, 0, 8 * scale, 8 * scale]);
    ctx.fill();

    const coordStr = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    ctx.fillStyle = '#94a3b8';
    ctx.font = `${10 * scale}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(coordStr, x + mapSize / 2, coordBoxY + 10 * scale);
  };

  const startExport = useCallback(async () => {
    if (!sequence || sequence.moments.length === 0) {
      alert('No video sequence to export');
      return;
    }

    if (typeof VideoEncoder === 'undefined') {
      alert('Your browser does not support video encoding. Please use Chrome or Edge.');
      return;
    }

    // Snapshot what this export renders, so the dialog can show it
    setExportSummary(describeExport({
      layout,
      format,
      portraitLayout,
      selectedAngle,
      cameraSegments,
      trimPoints,
      totalDuration: sequence.totalDuration,
    }));
    setIsExporting(true);
    setIsComplete(false);
    setExportError(null);
    setProgress(0);
    setExportUrl(null);
    abortRef.current = false;

    // Create temporary video elements for loading clips
    const tempVideo = document.createElement('video');
    tempVideo.muted = true;
    tempVideo.playsInline = true;
    let currentBlobUrl: string | null = null;

    // Extra video elements for multi-angle layouts (pip/triple)
    const extraVideos: Record<string, { el: HTMLVideoElement; blobUrl: string | null; loadedClipIdx: number }> = {};

    const createExtraVideo = (angle: string) => {
      const el = document.createElement('video');
      el.muted = true;
      el.playsInline = true;
      extraVideos[angle] = { el, blobUrl: null, loadedClipIdx: -1 };
      return extraVideos[angle];
    };

    // Helper to load a video file into a specific video element
    const loadVideoInto = (videoEl: HTMLVideoElement, file: File, prevUrl: string | null): Promise<string> => {
      return new Promise((resolve, reject) => {
        if (prevUrl) URL.revokeObjectURL(prevUrl);
        const url = URL.createObjectURL(file);
        videoEl.src = url;
        videoEl.onloadedmetadata = () => resolve(url);
        videoEl.onerror = () => reject(new Error(`Failed to load ${file.name}`));
      });
    };

    // Helper to load a video file (main video)
    const loadVideo = async (file: File): Promise<void> => {
      currentBlobUrl = await loadVideoInto(tempVideo, file, currentBlobUrl);
    };

    // Helper to seek a video element
    const seekVideoEl = (videoEl: HTMLVideoElement, time: number): Promise<void> => {
      return new Promise((resolve) => {
        const onSeeked = () => {
          videoEl.removeEventListener('seeked', onSeeked);
          resolve();
        };
        videoEl.addEventListener('seeked', onSeeked);
        videoEl.currentTime = time;
      });
    };

    // Helper to seek main video
    const seekVideo = (time: number) => seekVideoEl(tempVideo, time);

    try {
      // Get first clip to determine dimensions
      const firstMoment = sequence.moments[0];
      const firstVideo = firstMoment.videos.find(v => v.angle === selectedAngle) || firstMoment.videos[0];
      await loadVideo(firstVideo.file);

      const srcWidth = tempVideo.videoWidth || 1280;
      const srcHeight = tempVideo.videoHeight || 720;

      const maxDimension = 1920;
      const formatPreset = getFormatPreset(format);
      const isPortraitFormat = formatPreset.aspectRatio > 0 && formatPreset.aspectRatio < 1;

      // Determine export layout angles from config
      const tripleAngles = [...layoutConfig.triple.cameras];
      // Portrait formats only use bottom 3 corners
      const pipCorners = isPortraitFormat ? layoutConfig.pip.corners.slice(0, 3) : layoutConfig.pip.corners;
      const pipAngles = pipCorners.filter(
        a => a !== selectedAngle && a !== 'none' && a !== 'map'
      );
      // All-cameras grid: 2 rows of 3, same order as the player
      const allRows = [layoutConfig.all.topRow, layoutConfig.all.bottomRow];
      const allAngles = Array.from(new Set(allRows.flat()));

      let width: number;
      let height: number;

      if (format !== 'original' && formatPreset.exportWidth > 0) {
        // Use format's target resolution
        width = formatPreset.exportWidth;
        height = formatPreset.exportHeight;
      } else if (layout === 'triple') {
        // Load a side video to get its dimensions
        const pillarVideo = sequence.moments[0].videos.find(v => v.angle === tripleAngles[0]);
        let pillarW = srcWidth;
        let pillarH = srcHeight;
        if (pillarVideo) {
          const pv = document.createElement('video');
          pv.muted = true;
          const pvUrl = URL.createObjectURL(pillarVideo.file);
          await new Promise<void>((resolve) => {
            pv.onloadedmetadata = () => { pillarW = pv.videoWidth; pillarH = pv.videoHeight; resolve(); };
            pv.onerror = () => resolve();
            pv.src = pvUrl;
          });
          URL.revokeObjectURL(pvUrl);
        }
        // 3 videos side by side, each at same height
        const cellW = pillarW;
        const cellH = pillarH;
        width = cellW * 3;
        height = cellH;
        // Scale down if too large
        if (width > maxDimension) {
          const s = maxDimension / width;
          width = Math.floor(width * s);
          height = Math.floor(height * s);
        }
        width = width - (width % 2);
        height = height - (height % 2);
      } else if (layout === 'all') {
        // 2 rows of 3 cells at the camera aspect ratio, so no black bands between rows
        width = maxDimension;
        const gap = getAllGridGap(width);
        const cellW = (width - gap * 4) / 3;
        height = Math.round((cellW * srcHeight / srcWidth) * 2 + gap * 3);
        height = height - (height % 2);
      } else {
        width = srcWidth;
        height = srcHeight;
        if (width > maxDimension || height > maxDimension) {
          const videoScale = maxDimension / Math.max(width, height);
          width = Math.floor(width * videoScale);
          height = Math.floor(height * videoScale);
        }
        width = width - (width % 2);
        height = height - (height % 2);
      }

      const exportFps = 30;

      // Calculate export range from trim points
      const exportStart = trimPoints?.inPoint ?? 0;
      const exportEnd = trimPoints?.outPoint ?? sequence.totalDuration;
      const exportDuration = exportEnd - exportStart;
      const totalFrames = Math.floor(exportDuration * exportFps);

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d')!;

      setStatus('Loading telemetry icons...');
      const telemetryIcons = await loadTelemetryIcons();

      setStatus('Pre-loading map tiles...');

      // Pre-load map tiles for all unique positions within export range
      const uniqueTiles = new Set<string>();
      for (const msg of allSeiMessages) {
        const msgTime = msg.frameIndex / fps;
        if (msgTime >= exportStart && msgTime <= exportEnd) {
          if (msg.sei.latitude_deg && msg.sei.longitude_deg) {
            const tile = latLngToTile(msg.sei.latitude_deg, msg.sei.longitude_deg, 17);
            for (let dx = -1; dx <= 1; dx++) {
              for (let dy = -1; dy <= 1; dy++) {
                uniqueTiles.add(`17/${tile.x + dx}/${tile.y + dy}`);
              }
            }
          }
        }
      }

      // Load tiles in batches
      const tileArray = Array.from(uniqueTiles);
      for (let i = 0; i < tileArray.length; i++) {
        const [z, x, y] = tileArray[i].split('/').map(Number);
        await loadMapTile(x, y, z);
        if (i % 10 === 0) {
          setStatus(`Pre-loading map tiles... ${Math.round((i / tileArray.length) * 100)}%`);
        }
      }

      setStatus('Initializing encoder...');

      const muxer = new Muxer({
        target: new ArrayBufferTarget(),
        video: {
          codec: 'avc',
          width,
          height,
        },
        fastStart: 'in-memory',
      });

      let encoderError: Error | null = null;
      const encoder = new VideoEncoder({
        output: (chunk, meta) => {
          muxer.addVideoChunk(chunk, meta);
        },
        error: (e) => {
          console.error('Encoder error:', e);
          encoderError = e;
        },
      });

      encoder.configure({
        codec: 'avc1.640033',
        width,
        height,
        bitrate: 8_000_000,
        framerate: exportFps,
        latencyMode: 'quality',
      });

      if ((encoder.state as string) === 'closed') {
        throw new Error('Video encoder failed to initialize');
      }

      // Helper to find clip and local time for an absolute time
      const findClipForTime = (absTime: number): { clipIdx: number; localTime: number } | null => {
        for (let i = 0; i < sequence.moments.length; i++) {
          const clipStart = sequence.momentOffsets[i];
          const clipEnd = clipStart + sequence.moments[i].duration;
          if (absTime >= clipStart && absTime < clipEnd) {
            return { clipIdx: i, localTime: absTime - clipStart };
          }
        }
        // Handle edge case at the very end
        const lastIdx = sequence.moments.length - 1;
        const lastStart = sequence.momentOffsets[lastIdx];
        const lastEnd = lastStart + sequence.moments[lastIdx].duration;
        if (Math.abs(absTime - lastEnd) < 0.1) {
          return { clipIdx: lastIdx, localTime: sequence.moments[lastIdx].duration - 0.01 };
        }
        return null;
      };

      // Portrait layout metadata
      const pLayoutMeta = getPortraitLayout(portraitLayout);
      const pCameraSlots = portraitCameraConfig[portraitLayout] || DEFAULT_PORTRAIT_CAMERA_CONFIG[portraitLayout] || ['front'];
      const pAlignSlots = portraitAlignConfig[portraitLayout] || DEFAULT_PORTRAIT_ALIGN_CONFIG[portraitLayout] || [];

      // Convert AlignPosition to x/y factors (0 = start, 0.5 = center, 1 = end)
      const alignToFactors = (align: AlignPosition): { fx: number; fy: number } => {
        const parts = align.split(' ');
        const v = parts[0] || 'center'; // top, center, bottom
        const h = parts[1] || (parts[0] === 'center' ? 'center' : 'center');
        const fy = v === 'top' ? 0 : v === 'bottom' ? 1 : 0.5;
        const fx = h === 'left' ? 0 : h === 'right' ? 1 : 0.5;
        return { fx, fy };
      };

      // Prepare extra video elements for multi-angle layouts
      let layoutAngles: string[];
      if (isPortraitFormat && pLayoutMeta.slotCount > 1) {
        // Portrait multi-camera: all slots except slot 0 (main, loaded into tempVideo)
        layoutAngles = pCameraSlots.slice(1);
      } else if (layout === 'triple') {
        layoutAngles = tripleAngles;
      } else if (layout === 'pip') {
        layoutAngles = pipAngles;
      } else if (layout === 'all') {
        layoutAngles = allAngles;
      } else {
        layoutAngles = [];
      }

      for (const angle of layoutAngles) {
        if (!extraVideos[angle]) createExtraVideo(angle);
      }

      // Process frames within export range, respecting camera segments
      let frameCount = 0;
      let currentLoadedClipIdx = -1;
      let currentLoadedAngle = '';

      for (let frameIdx = 0; frameIdx < totalFrames; frameIdx++) {
        if (abortRef.current || encoderError) break;

        if ((encoder.state as string) === 'closed') {
          throw new Error('Encoder closed unexpectedly');
        }

        const absoluteTime = exportStart + (frameIdx / exportFps);

        // Get the camera angle for this time
        const frameAngle = getAngleForTime(absoluteTime);

        // Find which clip contains this time
        const clipInfo = findClipForTime(absoluteTime);
        if (!clipInfo) continue;

        const { clipIdx, localTime } = clipInfo;
        const moment = sequence.moments[clipIdx];

        setStatus(`Processing: ${formatDuration(absoluteTime - exportStart)} / ${formatDuration(exportDuration)}`);

        if (isPortraitFormat) {
          // Portrait format — generic grid-based renderer from layout metadata
          const mainSlotAngle = pCameraSlots[0] || 'front';

          // Load main video (slot 0)
          const needReload = currentLoadedClipIdx !== clipIdx || currentLoadedAngle !== mainSlotAngle;
          if (needReload) {
            const video = moment.videos.find(v => v.angle === mainSlotAngle) || moment.videos[0];
            await loadVideo(video.file);
            currentLoadedClipIdx = clipIdx;
            currentLoadedAngle = video.angle;
          }
          await seekVideo(localTime);

          // Load secondary slot videos
          for (let si = 1; si < pCameraSlots.length; si++) {
            const angle = pCameraSlots[si];
            const ev = extraVideos[angle];
            if (!ev) continue;
            const video = moment.videos.find(v => v.angle === angle);
            if (!video) continue;
            if (ev.loadedClipIdx !== clipIdx) {
              ev.blobUrl = await loadVideoInto(ev.el, video.file, ev.blobUrl);
              ev.loadedClipIdx = clipIdx;
            }
            await seekVideoEl(ev.el, localTime);
          }
          await new Promise((r) => setTimeout(r, 10));

          // Clear canvas
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, width, height);

          // Compute row heights from rowWeights
          const totalWeight = pLayoutMeta.rowWeights.reduce((a, b) => a + b, 0);
          const gap = 1; // 1px gap between rows/cols, matches CSS
          const totalRowGap = (pLayoutMeta.grid.length - 1) * gap;
          const availH = height - totalRowGap;
          let curY = 0;

          for (let rowIdx = 0; rowIdx < pLayoutMeta.grid.length; rowIdx++) {
            const row = pLayoutMeta.grid[rowIdx];
            const rowH = Math.floor(availH * pLayoutMeta.rowWeights[rowIdx] / totalWeight);
            const totalColGap = (row.length - 1) * gap;
            const cellW = Math.floor((width - totalColGap) / row.length);
            let curX = 0;

            for (let colIdx = 0; colIdx < row.length; colIdx++) {
              const slotIdx = row[colIdx];

              if (slotIdx === -1) {
                // Map slot
                const rawMapSei = getSeiForTime(absoluteTime);
                const mapSei = rawMapSei?.latitude_deg && rawMapSei?.longitude_deg
                  ? rawMapSei
                  : sequence.event?.est_lat && sequence.event?.est_lon
                    ? { ...(rawMapSei || {}), latitude_deg: sequence.event.est_lat, longitude_deg: sequence.event.est_lon } as typeof rawMapSei
                    : rawMapSei;
                if (showMap) {
                  await drawMiniMap(ctx, mapSei, width, height, { x: curX, y: curY, size: Math.min(cellW, rowH) });
                }
              } else {
                const angle = pCameraSlots[slotIdx] || 'front';
                const videoEl = slotIdx === 0 ? tempVideo : extraVideos[angle]?.el;

                if (videoEl && videoEl.videoWidth) {
                  const vw = videoEl.videoWidth;
                  const vh = videoEl.videoHeight;

                  // Center-crop (object-cover): scale to fill cell, clip overflow
                  const coverScale = Math.max(cellW / vw, rowH / vh);
                  const dw = Math.floor(vw * coverScale);
                  const dh = Math.floor(vh * coverScale);
                  // Use alignment to position the crop anchor
                  const slotAlignPos = pAlignSlots[slotIdx] || 'center';
                  const { fx, fy } = alignToFactors(slotAlignPos);
                  const dx = curX + Math.floor((cellW - dw) * fx);
                  const dy = curY + Math.floor((rowH - dh) * fy);
                  ctx.save();
                  ctx.beginPath();
                  ctx.rect(curX, curY, cellW, rowH);
                  ctx.clip();
                  ctx.drawImage(videoEl, dx, dy, dw, dh);
                  ctx.restore();
                }
              }

              curX += cellW + gap;
            }

            curY += rowH + gap;
          }

        } else if (layout === 'triple') {
          // Load and seek all 3 angles
          const cellW = Math.floor(width / 3);
          const cellH = height;

          for (let i = 0; i < tripleAngles.length; i++) {
            const angle = tripleAngles[i];
            const ev = extraVideos[angle];
            const video = moment.videos.find(v => v.angle === angle) || moment.videos[0];

            if (ev.loadedClipIdx !== clipIdx) {
              ev.blobUrl = await loadVideoInto(ev.el, video.file, ev.blobUrl);
              ev.loadedClipIdx = clipIdx;
            }
            await seekVideoEl(ev.el, localTime);
          }
          await new Promise((r) => setTimeout(r, 10));

          // Draw 3 videos side by side
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, width, height);
          for (let i = 0; i < tripleAngles.length; i++) {
            const ev = extraVideos[tripleAngles[i]];
            const srcW = ev.el.videoWidth || cellW;
            const srcH = ev.el.videoHeight || cellH;
            // Fit each video into its cell preserving aspect ratio
            const scale = Math.min(cellW / srcW, cellH / srcH);
            const dw = Math.floor(srcW * scale);
            const dh = Math.floor(srcH * scale);
            const dx = i * cellW + Math.floor((cellW - dw) / 2);
            const dy = Math.floor((cellH - dh) / 2);
            ctx.drawImage(ev.el, dx, dy, dw, dh);
          }

        } else if (layout === 'pip') {
          // Load and seek main video
          const needReload = currentLoadedClipIdx !== clipIdx || currentLoadedAngle !== frameAngle;
          if (needReload) {
            const video = moment.videos.find(v => v.angle === frameAngle) || moment.videos[0];
            await loadVideo(video.file);
            currentLoadedClipIdx = clipIdx;
            currentLoadedAngle = video.angle;
          }
          await seekVideo(localTime);

          // Load and seek PiP camera angles
          for (const angle of pipAngles) {
            const ev = extraVideos[angle];
            if (!ev) continue;
            const video = moment.videos.find(v => v.angle === angle);
            if (!video) continue;
            if (ev.loadedClipIdx !== clipIdx) {
              ev.blobUrl = await loadVideoInto(ev.el, video.file, ev.blobUrl);
              ev.loadedClipIdx = clipIdx;
            }
            await seekVideoEl(ev.el, localTime);
          }
          await new Promise((r) => setTimeout(r, 10));

          // Draw main video
          ctx.drawImage(tempVideo, 0, 0, width, height);

          // Draw PiP corners matching the 5-position layout config
          // corners: [bottom-left, bottom-center, bottom-right, top-left, top-right]
          const allCorners = layoutConfig.pip.corners;
          const pipW = Math.floor(width * 0.18);
          const pipMargin = Math.floor(width * 0.02);

          const drawPipAt = (angle: string, px: number, py: number) => {
            const ev = extraVideos[angle];
            if (!ev || !moment.videos.some(v => v.angle === angle)) return;
            const srcW = ev.el.videoWidth || 1;
            const srcH = ev.el.videoHeight || 1;
            const pipH = Math.floor(pipW * (srcH / srcW));
            ctx.drawImage(ev.el, px, py, pipW, pipH);
            ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            ctx.lineWidth = 1;
            ctx.strokeRect(px, py, pipW, pipH);
          };

          // Compute pip height for positioning (use first available pip video)
          let defaultPipH = Math.floor(pipW * 0.75); // fallback 4:3
          for (const angle of pipAngles) {
            const ev = extraVideos[angle];
            if (ev?.el.videoWidth) {
              defaultPipH = Math.floor(pipW * (ev.el.videoHeight / ev.el.videoWidth));
              break;
            }
          }

          // Bottom-left [0]
          if (allCorners[0] !== 'none' && allCorners[0] !== 'map' && allCorners[0] !== selectedAngle) {
            drawPipAt(allCorners[0], pipMargin, height - defaultPipH - pipMargin);
          }
          // Bottom-center [1]
          if (allCorners[1] !== 'none' && allCorners[1] !== 'map' && allCorners[1] !== selectedAngle) {
            drawPipAt(allCorners[1], Math.floor((width - pipW) / 2), height - defaultPipH - pipMargin);
          }
          // Bottom-right [2]
          if (allCorners[2] !== 'none' && allCorners[2] !== 'map' && allCorners[2] !== selectedAngle) {
            drawPipAt(allCorners[2], width - pipW - pipMargin, height - defaultPipH - pipMargin);
          }
          // Top-left [3]
          if (allCorners[3] !== 'none' && allCorners[3] !== 'map' && allCorners[3] !== selectedAngle) {
            drawPipAt(allCorners[3], pipMargin, pipMargin);
          }
          // Top-right [4]
          if (allCorners[4] !== 'none' && allCorners[4] !== 'map' && allCorners[4] !== selectedAngle) {
            drawPipAt(allCorners[4], width - pipW - pipMargin, pipMargin);
          }

          // Draw map at corners configured as 'map'
          // corner positions: [bottom-left, bottom-center, bottom-right, top-left, top-right]
          const mapCornerPositions = [
            { x: pipMargin, y: height - pipW - pipMargin },                         // bottom-left
            { x: Math.floor((width - pipW) / 2), y: height - pipW - pipMargin },    // bottom-center
            { x: width - pipW - pipMargin, y: height - pipW - pipMargin },           // bottom-right
            { x: pipMargin, y: pipMargin },                                          // top-left
            { x: width - pipW - pipMargin, y: pipMargin },                           // top-right
          ];
          const rawPipSei = getSeiForTime(absoluteTime);
          const pipMapSeiData = rawPipSei?.latitude_deg && rawPipSei?.longitude_deg
            ? rawPipSei
            : sequence.event?.est_lat && sequence.event?.est_lon
              ? { ...(rawPipSei || {}), latitude_deg: sequence.event.est_lat, longitude_deg: sequence.event.est_lon } as typeof rawPipSei
              : rawPipSei;
          for (let ci = 0; ci < allCorners.length; ci++) {
            if (allCorners[ci] === 'map') {
              const mp = mapCornerPositions[ci];
              await drawMiniMap(ctx, pipMapSeiData, width, height, { x: mp.x, y: mp.y, size: pipW });
            }
          }

        } else if (layout === 'all') {
          // Load and seek every camera in the grid
          for (const angle of allAngles) {
            const ev = extraVideos[angle];
            const video = moment.videos.find(v => v.angle === angle);
            if (!ev || !video) continue;
            if (ev.loadedClipIdx !== clipIdx) {
              ev.blobUrl = await loadVideoInto(ev.el, video.file, ev.blobUrl);
              ev.loadedClipIdx = clipIdx;
            }
            await seekVideoEl(ev.el, localTime);
          }
          await new Promise((r) => setTimeout(r, 10));

          // Draw 2 rows of 3 with a small gap, matching the player grid
          ctx.fillStyle = '#000';
          ctx.fillRect(0, 0, width, height);
          const gap = getAllGridGap(width);
          const cellW = Math.floor((width - gap * 4) / 3);
          const cellH = Math.floor((height - gap * 3) / 2);

          for (let rowIdx = 0; rowIdx < allRows.length; rowIdx++) {
            for (let colIdx = 0; colIdx < allRows[rowIdx].length; colIdx++) {
              const angle = allRows[rowIdx][colIdx];
              const cx = gap + colIdx * (cellW + gap);
              const cy = gap + rowIdx * (cellH + gap);
              const ev = extraVideos[angle];
              const hasVideo = ev && ev.loadedClipIdx === clipIdx && ev.el.videoWidth > 0
                && moment.videos.some(v => v.angle === angle);

              if (hasVideo) {
                // Fit each video into its cell preserving aspect ratio
                const srcW = ev.el.videoWidth;
                const srcH = ev.el.videoHeight;
                const scale = Math.min(cellW / srcW, cellH / srcH);
                const dw = Math.floor(srcW * scale);
                const dh = Math.floor(srcH * scale);
                ctx.drawImage(ev.el, cx + Math.floor((cellW - dw) / 2), cy + Math.floor((cellH - dh) / 2), dw, dh);
              } else {
                // Camera missing from this clip - placeholder like the player
                ctx.fillStyle = '#111827';
                ctx.fillRect(cx, cy, cellW, cellH);
                ctx.fillStyle = '#4b5563';
                ctx.font = `${Math.round(cellH * 0.06)}px system-ui, sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                ctx.fillText(ANGLE_LABELS[angle] || angle, cx + cellW / 2, cy + cellH / 2);
                ctx.textAlign = 'left';
                ctx.textBaseline = 'alphabetic';
              }
            }
          }

        } else {
          // Single layout - export single angle
          const needReload = currentLoadedClipIdx !== clipIdx || currentLoadedAngle !== frameAngle;
          if (needReload) {
            const video = moment.videos.find(v => v.angle === frameAngle) || moment.videos[0];
            await loadVideo(video.file);
            currentLoadedClipIdx = clipIdx;
            currentLoadedAngle = video.angle;
          }
          await seekVideo(localTime);
          await new Promise((r) => setTimeout(r, 10));

          ctx.drawImage(tempVideo, 0, 0, width, height);
        }

        // Get SEI data for this absolute time, with event.json GPS fallback
        const rawSeiData = getSeiForTime(absoluteTime);
        const seiData = rawSeiData?.latitude_deg && rawSeiData?.longitude_deg
          ? rawSeiData
          : sequence.event?.est_lat && sequence.event?.est_lon
            ? { ...(rawSeiData || {}), latitude_deg: sequence.event.est_lat, longitude_deg: sequence.event.est_lon } as typeof rawSeiData
            : rawSeiData;

        // Draw overlays based on toggle states
        const overlayW = width;
        const overlayH = height;
        if (showTelemetry) {
          drawTelemetry(ctx, seiData, overlayW, overlayH, telemetryIcons);
        }
        if (showDateTime) {
          const realTime = new Date(moment.timestamp.getTime() + localTime * 1000);
          const dynamicDate = realTime.toISOString().split('T')[0];
          const dynamicTime = realTime.toTimeString().split(' ')[0];
          const autopilotState = seiData?.autopilot_state ?? 0;
          const isAutopilotActive = showTelemetry && [1, 2, 3].includes(autopilotState);
          drawDateTime(ctx, overlayW, overlayH, dynamicDate, dynamicTime, showTelemetry, isAutopilotActive);
        }
        if (showMap && !(isPortraitFormat && pLayoutMeta.hasMap) && !(layout === 'pip' && layoutConfig.pip.corners.includes('map'))) {
          await drawMiniMap(ctx, seiData, overlayW, overlayH, layout === 'pip' ? 'top-right' : 'bottom-right');
        }

        // Frame timestamp is relative to export start (0-based for exported video)
        const exportedTime = absoluteTime - exportStart;
        const frame = new VideoFrame(canvas, {
          timestamp: exportedTime * 1_000_000,
          duration: (1 / exportFps) * 1_000_000,
        });

        encoder.encode(frame, { keyFrame: frameCount % 30 === 0 });
        frame.close();

        frameCount++;
        setProgress(Math.round((frameCount / totalFrames) * 90));
      }

      // Cleanup extra video elements
      for (const angle of Object.keys(extraVideos)) {
        const ev = extraVideos[angle];
        if (ev.blobUrl) URL.revokeObjectURL(ev.blobUrl);
      }

      if (encoderError) {
        throw encoderError;
      }

      if (abortRef.current) {
        if ((encoder.state as string) !== 'closed') {
          encoder.close();
        }
        setIsExporting(false);
        return;
      }

      setStatus('Finalizing...');

      if ((encoder.state as string) !== 'closed') {
        await encoder.flush();
        encoder.close();
      }
      muxer.finalize();

      const { buffer } = muxer.target;
      const blob = new Blob([buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);

      setExportUrl(url);
      setProgress(100);
      setStatus('Export complete!');
      setIsComplete(true);
      // Keep isExporting true to show the dialog with download button

    } catch (err) {
      console.error('Export error:', err);
      setIsExporting(false);
      // Keep the dialog open with the reason, unless the user cancelled
      if (!abortRef.current) {
        setExportError(err instanceof Error ? err.message : 'Unknown error');
      }
    } finally {
      // Cleanup
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl);
      }
      tempVideo.src = '';
    }
  }, [sequence, selectedAngle, allSeiMessages, fps, speedUnit, getSeiForTime, getAngleForTime, cameraSegments, trimPoints, showTelemetry, showDateTime, showMap, layout, layoutConfig, format, portraitLayout, portraitCameraConfig, portraitAlignConfig]);

  const stopExport = useCallback(() => {
    abortRef.current = true;
    setIsExporting(false);
    setIsComplete(false);
  }, []);

  const closeDialog = useCallback(() => {
    setIsExporting(false);
    setIsComplete(false);
    setExportError(null);
    setProgress(0);
    setStatus('');
  }, []);

  const downloadExport = useCallback(() => {
    if (!exportUrl) return;

    const a = document.createElement('a');
    a.href = exportUrl;
    a.download = `${filename}-${Date.now()}.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [exportUrl, filename]);

  return (
    <>
      <Tooltip content="Export to MP4" position="top">
        <button
          onClick={startExport}
          disabled={isExporting}
          className="flex items-center gap-1 px-2 py-1.5 rounded text-xs font-medium bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        >
          <IconDownload size={14} />
          <span>Export</span>
        </button>
      </Tooltip>

      {(isExporting || isComplete || exportError !== null) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
          <div className="bg-gray-900 rounded-2xl p-8 max-w-md w-full mx-4 shadow-2xl border border-gray-700">
            <div className="text-center">
              {/* Icon - spinning loader, success check or error */}
              <div className="mb-6">
                {exportError !== null ? (
                  <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center mx-auto">
                    <IconAlertTriangle size={36} className="text-red-500" />
                  </div>
                ) : isComplete ? (
                  <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center mx-auto">
                    <IconCheck size={40} className="text-green-500" />
                  </div>
                ) : (
                  <IconLoader2 size={48} className="animate-spin text-blue-500 mx-auto" />
                )}
              </div>

              <h3 className="text-xl font-semibold text-white mb-2">
                {exportError !== null ? 'Export Failed' : isComplete ? 'Export Complete!' : 'Exporting Video'}
              </h3>
              {exportSummary && (
                <p className="text-xs text-gray-500 mb-3">{exportSummary}</p>
              )}
              {exportError !== null ? (
                <p className="text-red-400 mb-6 break-words">{exportError}</p>
              ) : (
                <p className="text-gray-400 mb-6">{status}</p>
              )}

              {/* Progress bar - only show while exporting */}
              {!isComplete && exportError === null && (
                <>
                  <div className="w-full bg-gray-700 rounded-full h-3 mb-4 overflow-hidden">
                    <div
                      className="bg-blue-500 h-full rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                  <p className="text-2xl font-bold text-white mb-6">{Math.round(progress)}%</p>
                </>
              )}

              {/* Action buttons */}
              <div className="flex flex-col gap-3">
                {exportError !== null ? (
                  <>
                    <button
                      onClick={startExport}
                      className="flex items-center gap-2 justify-center w-full px-6 py-3 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 transition-all"
                    >
                      <IconRefresh size={18} />
                      Retry
                    </button>
                    <button
                      onClick={closeDialog}
                      className="px-6 py-2.5 rounded-lg text-sm font-medium bg-gray-700 text-gray-300 hover:bg-gray-600 transition-all"
                    >
                      Close
                    </button>
                  </>
                ) : isComplete ? (
                  <>
                    <button
                      onClick={downloadExport}
                      className="flex items-center gap-2 justify-center w-full px-6 py-3 rounded-lg text-sm font-medium bg-green-600 text-white hover:bg-green-500 transition-all"
                    >
                      <IconDownload size={18} />
                      Download MP4
                    </button>
                    <button
                      onClick={closeDialog}
                      className="px-6 py-2.5 rounded-lg text-sm font-medium bg-gray-700 text-gray-300 hover:bg-gray-600 transition-all"
                    >
                      Close
                    </button>
                  </>
                ) : (
                  <button
                    onClick={stopExport}
                    className="flex items-center gap-2 mx-auto px-6 py-2.5 rounded-lg text-sm font-medium bg-red-600 text-white hover:bg-red-500 transition-all"
                  >
                    <IconPlayerStop size={18} />
                    Cancel Export
                  </button>
                )}
              </div>

              {/* CTA - only show during export, not on success or failure */}
              {!isComplete && exportError === null && (
                <>
                  <a
                    href="https://nobig.deals"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-6 flex items-center gap-3 p-3 rounded-xl bg-gray-800/50 border border-gray-700 hover:border-gray-600 hover:bg-gray-800 transition-all"
                  >
                    <svg className="w-8 h-8 flex-shrink-0" viewBox="0 0 84 88" fill="none">
                      <path d="M33.241 68.7528C32.255 68.051 31.1554 67.5977 29.9415 67.3912C30.7378 67.129 31.4931 66.8013 32.2071 66.4057C33.6242 65.6425 34.7347 64.5737 35.5391 63.2C36.3816 61.8258 36.8029 60.1845 36.8029 58.2762C36.8029 56.3679 36.3054 54.5359 35.3096 53.0094C34.3134 51.4445 32.8392 50.2231 30.8862 49.3455C28.9712 48.4295 26.5965 47.9717 23.7628 47.9717H0V87.9315H24.5097C27.2671 87.9315 29.6224 87.4738 31.5754 86.5574C33.567 85.6414 35.0797 84.363 36.1136 82.7217C37.1861 81.0809 37.7225 79.2105 37.7225 77.1115C37.7225 75.3938 37.3203 73.81 36.5159 72.3594C35.7114 70.8709 34.6196 69.6688 33.241 68.7528ZM4.75917 54.4361H8.11589V54.4409L22.6134 54.4409C24.4898 54.4409 25.945 54.8802 26.9789 55.7577C28.0513 56.6358 28.5877 57.8758 28.5877 59.4791C28.5877 61.0823 28.0513 62.3608 26.9789 63.2004C25.945 64.04 24.4898 64.4598 22.6134 64.4598L8.04169 64.4598V59.4758C8.04169 59.0261 7.9983 58.5768 7.90019 58.1376C7.57785 56.6935 6.77222 55.6624 4.75876 55.6624L4.75917 54.4361ZM27.8984 80.0311C26.8264 80.9471 25.3133 81.4049 23.3602 81.4049H8.04169V75.6844C8.04169 75.2346 7.9983 74.7857 7.90059 74.3465C7.57826 72.9025 6.77222 71.8709 4.75917 71.8709V70.645H8.04169V70.6418L23.1879 70.6418C25.141 70.6418 26.6922 71.1384 27.8408 72.1307C28.9899 73.0847 29.5644 74.4205 29.5644 76.1381C29.5644 77.8557 29.0093 79.1152 27.8984 80.0311Z" fill="#EEE9E8"/>
                      <path d="M73.724 2.54189C70.6632 0.847296 67.2141 0 63.3757 0C59.5373 0 56.1372 0.847296 53.0278 2.54189C49.9184 4.23648 47.4411 6.63291 45.5947 9.73158C43.7973 12.7818 42.8984 16.4126 42.8984 20.6248C42.8984 24.837 43.773 28.4436 45.5217 31.5908C47.3191 34.689 49.7242 37.0859 52.7363 38.7804C55.7966 40.475 59.2218 41.3223 63.0112 41.3223C66.8005 41.3223 70.347 40.475 73.505 38.7804C76.6631 37.0859 79.1647 34.6894 81.0111 31.5908C82.9058 28.444 83.8533 24.7886 83.8533 20.6248C83.8533 16.4611 82.9301 12.7818 81.0841 9.73158C79.2867 6.63291 76.8334 4.23648 73.7244 2.54189H73.724ZM73.5054 28.1769C72.3398 30.162 70.8092 31.6627 68.9145 32.6793C67.0681 33.6474 65.1005 34.1314 63.0116 34.1314C60.9227 34.1314 58.9794 33.6474 57.182 32.6793C55.4329 31.6627 54.024 30.1616 52.9552 28.1769C51.8865 26.1433 51.3521 23.6261 51.3521 20.6244C51.3521 17.6227 51.9108 15.057 53.0282 13.0719C54.1456 11.0868 55.6028 9.61036 57.4006 8.64185C59.1979 7.67374 61.1417 7.18929 63.2305 7.18929C65.3194 7.18929 67.2627 7.67334 69.0601 8.64185C70.9065 9.60996 72.4123 11.0868 73.5784 13.0719C74.7441 15.057 75.3275 17.5742 75.3275 20.6244C75.3275 23.6746 74.7202 26.1437 73.5054 28.1769Z" fill="#EEE9E8"/>
                      <path d="M28.6122 2.07802C26.143 0.775354 23.3349 0.124023 20.1882 0.124023C18.5088 0.124023 16.9012 0.353929 15.3657 0.812931C12.7291 1.7269 10.3029 3.1839 9.5374 5.76014H8.28658V5.33265C8.28415 5.33588 8.28172 5.33871 8.27888 5.34194V0.775354H0V40.6508H8.27847V18.3613C8.27847 15.9006 8.69001 13.8505 9.51307 12.21C10.3844 10.5696 11.5707 9.33922 13.0713 8.519C14.5723 7.69877 16.3392 7.28866 18.3726 7.28866C21.3741 7.28866 23.7946 8.2297 25.6342 10.111C27.4737 11.9441 28.3941 14.6945 28.3941 18.3609V40.6504H36.6V17.1309C36.6 13.4161 35.8734 10.3041 34.4211 7.79534C33.017 5.23851 31.0806 3.3326 28.6118 2.07802H28.6122Z" fill="#EEE9E8"/>
                      <path d="M73.9775 50.4019C70.8288 48.7562 67.1035 47.9336 62.8025 47.9336H46.1484V88.0001H62.8025C67.1035 88.0001 70.8283 87.1779 73.9775 85.5322C77.1643 83.8865 79.6222 81.5713 81.3502 78.5865C83.1167 75.6018 83.9998 72.0809 83.9998 68.0246C83.9998 63.9684 83.1167 60.4285 81.3502 57.4054C79.6222 54.3823 77.1647 52.0472 73.9775 50.4019ZM72.3066 77.7255C70.041 80.0217 66.7771 81.1697 62.5146 81.1697H54.2124V59.7658C54.2124 59.3149 54.1691 58.8644 54.0705 58.4244C53.747 56.9767 52.9389 55.9427 50.921 55.9427V54.7136H54.2124V54.7075H62.5146C66.7771 54.7075 70.041 55.8938 72.3066 58.2664C74.6108 60.639 75.7631 63.892 75.7631 68.0251C75.7631 72.1581 74.6108 75.3909 72.3066 77.7255Z" fill="#EEE9E8"/>
                    </svg>
                    <div className="text-left">
                      <p className="text-xs text-gray-400">Got an idea? Looking for an AI-native team?</p>
                      <p className="text-sm text-gray-300 font-medium">we are nobig.deals ready to help you →</p>
                    </div>
                  </a>
                  <div className="flex items-center gap-3 mt-4 mb-3">
                    <div className="flex-1 h-px bg-gray-700" />
                    <span className="text-sm text-gray-500">or</span>
                    <div className="flex-1 h-px bg-gray-700" />
                  </div>
                  <a
                    href="https://buymeacoffee.com/nobigdeals"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block hover:opacity-90 transition-opacity"
                  >
                    <img
                      src="/bmc-button.png"
                      alt="Buy me a coffee"
                      className="w-full rounded-xl"
                    />
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
