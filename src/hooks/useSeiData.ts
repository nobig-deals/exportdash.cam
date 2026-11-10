'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import protobuf from 'protobufjs';
import { DashcamMP4, SeiData, SeiWithFrameIndex, SeiMetadataType } from '@/lib/dashcam-mp4';
import { VideoSequence } from '@/types/video';

interface UseSeiDataResult {
  seiData: SeiData | null;
  isLoading: boolean;
  error: string | null;
  allSeiMessages: SeiWithFrameIndex[];
  fps: number;
}

/**
 * Extended SEI message that includes the absolute frame index across the sequence
 */
interface SequenceSeiMessage extends SeiWithFrameIndex {
  momentIndex: number;      // Which moment this SEI came from
  absoluteFrameIndex: number;  // Frame index relative to sequence start
}

/**
 * Hook to extract and merge SEI data across all clips in a sequence.
 *
 * For single-clip sequences, this behaves like the old hook.
 * For multi-clip sequences, it:
 * 1. Extracts SEI from all clips in parallel
 * 2. Adjusts frame indices to be sequence-relative
 * 3. Merges all messages into a single sorted array
 * 4. Uses binary search with absolute time
 */
export function useSeiData(
  sequence: VideoSequence | null,
  currentMomentIndex: number,
  absoluteTime: number
): UseSeiDataResult {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allSeiMessages, setAllSeiMessages] = useState<SequenceSeiMessage[]>([]);
  const [fps, setFps] = useState(30);

  const seiMetadataRef = useRef<SeiMetadataType | null>(null);
  const lastSequenceKeyRef = useRef<string | null>(null);

  // Load protobuf schema and extract SEI messages when sequence changes
  useEffect(() => {
    if (!sequence) {
      setAllSeiMessages([]);
      setError(null);
      lastSequenceKeyRef.current = null;
      return;
    }

    // Skip if we already processed this sequence with the same clips
    // ("Add More" can extend a sequence without changing its id)
    const sequenceKey = `${sequence.id}:${sequence.moments.map(m => m.id).join(',')}`;
    if (lastSequenceKeyRef.current === sequenceKey) {
      return;
    }

    const extractAllSei = async () => {
      setIsLoading(true);
      setError(null);

      try {
        // Load protobuf schema if not already loaded
        if (!seiMetadataRef.current) {
          console.log('[SEI] Loading protobuf schema...');
          const response = await fetch('/dashcam.proto');
          const protoText = await response.text();
          const root = protobuf.parse(protoText, { keepCase: true }).root;
          seiMetadataRef.current = root.lookupType('SeiMetadata') as unknown as SeiMetadataType;
          console.log('[SEI] Protobuf schema loaded successfully');
        }

        // Extract SEI from all moments in the sequence
        const allMessages: SequenceSeiMessage[] = [];
        let sequenceFps = 30;
        let cumulativeFrameOffset = 0;

        console.log(`[SEI] Processing ${sequence.moments.length} moments in sequence`);

        for (let momentIdx = 0; momentIdx < sequence.moments.length; momentIdx++) {
          const moment = sequence.moments[momentIdx];

          // Find the front video (preferred) or first available video
          const frontVideo = moment.videos.find(v => v.angle === 'front');
          const videoFile = frontVideo?.file || moment.videos[0]?.file;

          if (!videoFile) {
            console.warn(`[SEI] No video file found for moment ${momentIdx}`);
            cumulativeFrameOffset += Math.round(moment.duration * sequenceFps);
            continue;
          }

          try {
            console.log(`[SEI] Processing moment ${momentIdx}: ${videoFile.name}`);
            const arrayBuffer = await videoFile.arrayBuffer();
            const mp4 = new DashcamMP4(arrayBuffer);

            // Get FPS from first valid video
            if (momentIdx === 0) {
              try {
                sequenceFps = mp4.getFps();
                console.log(`[SEI] Sequence FPS: ${sequenceFps}`);
              } catch (e) {
                console.warn('[SEI] Could not get FPS, using default 30');
              }
            }

            // Extract SEI messages
            const messages = mp4.extractSeiMessagesWithFrameIndex(seiMetadataRef.current!);
            console.log(`[SEI] Extracted ${messages.length} messages from moment ${momentIdx}`);

            // Add to merged list with adjusted frame indices
            for (const msg of messages) {
              allMessages.push({
                ...msg,
                momentIndex: momentIdx,
                absoluteFrameIndex: cumulativeFrameOffset + msg.frameIndex,
              });
            }

            // Update cumulative offset for next moment
            const momentFrames = Math.round(moment.duration * sequenceFps);
            cumulativeFrameOffset += momentFrames;

          } catch (err) {
            console.error(`[SEI] Error processing moment ${momentIdx}:`, err);
            // Continue with other moments even if one fails
            cumulativeFrameOffset += Math.round(moment.duration * sequenceFps);
          }
        }

        // Sort by absolute frame index (should already be sorted, but just in case)
        allMessages.sort((a, b) => a.absoluteFrameIndex - b.absoluteFrameIndex);

        console.log(`[SEI] Total messages across sequence: ${allMessages.length}`);

        // --- DEBUG: Dump frame data summary ---
        if (allMessages.length > 0) {
          const sample = allMessages[0].sei;
          const allKeys = Object.keys(sample) as (keyof SeiData)[];
          console.log('[DEBUG] First frame SEI keys:', allKeys);
          console.log('[DEBUG] First frame SEI data:', JSON.parse(JSON.stringify(sample)));

          // Show which fields are populated across all messages
          const fieldStats: Record<string, { present: number; sample: unknown }> = {};
          for (const key of allKeys) {
            const present = allMessages.filter(m => m.sei[key] !== undefined && m.sei[key] !== null).length;
            fieldStats[key] = { present, sample: sample[key] };
          }
          console.table(fieldStats);

          // Log first 5 frames for inspection
          console.log('[DEBUG] First 5 frames:', allMessages.slice(0, 5).map(m => ({
            frameIndex: m.frameIndex,
            absoluteFrameIndex: m.absoluteFrameIndex,
            momentIndex: m.momentIndex,
            ...JSON.parse(JSON.stringify(m.sei)),
          })));

          // Log GPS availability
          const gpsFrames = allMessages.filter(m => m.sei.latitude_deg && m.sei.longitude_deg);
          console.log(`[DEBUG] GPS data available in ${gpsFrames.length}/${allMessages.length} frames`);
          if (gpsFrames.length > 0) {
            console.log('[DEBUG] First GPS point:', {
              lat: gpsFrames[0].sei.latitude_deg,
              lng: gpsFrames[0].sei.longitude_deg,
              heading: gpsFrames[0].sei.heading_deg,
            });
          }
        }
        // --- END DEBUG ---

        setAllSeiMessages(allMessages);
        setFps(sequenceFps);
        lastSequenceKeyRef.current = sequenceKey;

        if (allMessages.length === 0) {
          setError('No Tesla metadata found in this video. Make sure this is a Tesla dashcam recording.');
        }
      } catch (err) {
        console.error('[SEI] Error extracting SEI:', err);
        setError(err instanceof Error ? err.message : 'Failed to extract metadata');
      } finally {
        setIsLoading(false);
      }
    };

    extractAllSei();
  }, [sequence?.id, sequence?.clipCount]);

  // Find SEI data for current absolute time with GPS interpolation
  const getSeiForTime = useCallback(
    (time: number): SeiData | null => {
      if (allSeiMessages.length === 0) return null;

      const absoluteFrameIndex = Math.floor(time * fps);

      // Binary search for last SEI message at or before this frame
      let left = 0;
      let right = allSeiMessages.length - 1;

      while (left < right) {
        const mid = Math.floor((left + right + 1) / 2);
        if (allSeiMessages[mid].absoluteFrameIndex <= absoluteFrameIndex) {
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
        const span = after.absoluteFrameIndex - before.absoluteFrameIndex;
        if (span > 0) {
          const t = Math.min(1, Math.max(0, (absoluteFrameIndex - before.absoluteFrameIndex) / span));
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

  const seiData = useMemo(() => {
    const data = getSeiForTime(absoluteTime);
    if (data && Math.round(absoluteTime * 10) % 50 === 0) {
      // Log every ~5 seconds to avoid spam
      console.log(`[DEBUG] Frame @ ${absoluteTime.toFixed(2)}s:`, JSON.parse(JSON.stringify(data)));
    }
    return data;
  }, [getSeiForTime, absoluteTime]);

  // Convert back to the standard format for consumers
  const normalizedMessages = useMemo((): SeiWithFrameIndex[] => {
    return allSeiMessages.map(msg => ({
      frameIndex: msg.absoluteFrameIndex,
      sei: msg.sei,
    }));
  }, [allSeiMessages]);

  return {
    seiData,
    isLoading,
    error,
    allSeiMessages: normalizedMessages,
    fps,
  };
}
