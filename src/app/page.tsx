'use client';

import { useState, useCallback } from 'react';
import { DropZone } from '@/components/DropZone';
import { VideoPlayer } from '@/components/VideoPlayer';
import { LoadingScreen } from '@/components/LoadingScreen';
import { DecryptDialog } from '@/components/DecryptDialog';
import { VideoSequence, ProcessingProgress } from '@/types/video';
import { processFilesToMoments, detectSequences } from '@/lib/sequence-detector';
import {
  isEncryptedTeslaFile,
  parseTeslaHeader,
  fetchDecryptKeys,
  decryptTeslaFile,
  loadStoredToken,
  saveStoredToken,
  clearStoredToken,
  KeyFetchError,
} from '@/lib/tesla-decrypt';

export default function Home() {
  const [sequences, setSequences] = useState<VideoSequence[]>([]);
  const [selectedSequence, setSelectedSequence] = useState<VideoSequence | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState<ProcessingProgress>({
    stage: 'scanning',
    current: 0,
    total: 0,
  });
  // Encrypted clips awaiting a token before they can be decrypted.
  const [pendingDecrypt, setPendingDecrypt] = useState<{ encrypted: File[]; plain: File[] } | null>(
    null
  );

  // Run the normal processing pipeline on a set of plain (decrypted) MP4 files.
  const runPipeline = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    setIsProcessing(true);
    setProcessingProgress({
      stage: 'scanning',
      current: 0,
      total: files.length,
      message: 'Scanning files...',
    });

    try {
      const { moments, events } = await processFilesToMoments(files, setProcessingProgress);
      const detectedSequences = detectSequences(moments, events);
      setSequences(detectedSequences);
      if (detectedSequences.length > 0) {
        setSelectedSequence(detectedSequences[0]);
      }
    } catch (error) {
      console.error('Error processing videos:', error);
      setProcessingProgress({
        stage: 'error',
        current: 0,
        total: files.length,
        message: 'Error processing videos',
      });
    } finally {
      setIsProcessing(false);
    }
  }, []);

  const handleFilesAdded = useCallback(
    async (newFiles: File[]) => {
      if (newFiles.length === 0) return;

      // Split off any Tesla-encrypted clips; they need a key before playback.
      const encrypted: File[] = [];
      const plain: File[] = [];
      for (const file of newFiles) {
        if (file.name.toLowerCase().endsWith('.mp4') && (await isEncryptedTeslaFile(file))) {
          encrypted.push(file);
        } else {
          plain.push(file);
        }
      }

      if (encrypted.length > 0) {
        // Prompt for the Tesla token; decryption continues in handleDecrypt.
        setPendingDecrypt({ encrypted, plain });
        return;
      }

      await runPipeline(newFiles);
    },
    [runPipeline]
  );

  // Called by the decrypt dialog: fetch keys, decrypt every encrypted clip in
  // the browser, then hand the resulting plain MP4s to the normal pipeline.
  const handleDecrypt = useCallback(
    async (
      token: string,
      remember: boolean,
      onProgress: (label: string, fraction: number) => void
    ) => {
      if (!pendingDecrypt) return;
      const { encrypted, plain } = pendingDecrypt;

      const buffers = await Promise.all(
        encrypted.map(async (f) => new Uint8Array(await f.arrayBuffer()))
      );
      const headers = buffers.map(parseTeslaHeader);

      onProgress('Fetching keys from Tesla…', 0);
      const keys = await fetchDecryptKeys(headers, token, (done, total) => {
        if (total > 1) onProgress(`Fetching keys from Tesla… (batch ${done}/${total})`, 0);
      });

      const decryptedFiles: File[] = [];
      for (let i = 0; i < encrypted.length; i++) {
        const key = keys.get(headers[i].id);
        if (!key) {
          throw new KeyFetchError(
            `Tesla didn't return a key for "${encrypted[i].name}". The token may lack access to this vehicle.`
          );
        }
        const label = `Decrypting ${encrypted[i].name} (${i + 1}/${encrypted.length})…`;
        const blob = await decryptTeslaFile(buffers[i], key, (frac) => onProgress(label, frac));
        decryptedFiles.push(new File([blob], encrypted[i].name, { type: 'video/mp4' }));
      }

      // Persist or forget the token per the user's choice.
      if (remember) saveStoredToken(token);
      else clearStoredToken();

      // Success: close the dialog and process the decrypted clips + any plain ones.
      setPendingDecrypt(null);
      void runPipeline([...plain, ...decryptedFiles]);
    },
    [pendingDecrypt, runPipeline]
  );

  const handleClear = useCallback(() => {
    setSequences([]);
    setSelectedSequence(null);
  }, []);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      {/* Loading Screen */}
      {isProcessing && <LoadingScreen progress={processingProgress} />}

      {/* Decrypt prompt for encrypted Tesla clips */}
      {pendingDecrypt && (
        <DecryptDialog
          fileCount={pendingDecrypt.encrypted.length}
          initialToken={loadStoredToken() ?? ''}
          onCancel={() => {
            // Skip decryption, but still play any plain clips dropped alongside.
            const plain = pendingDecrypt.plain;
            setPendingDecrypt(null);
            if (plain.length > 0) void runPipeline(plain);
          }}
          onDecrypt={handleDecrypt}
        />
      )}

      {/* Main Content - Full width, no header */}
      <main className="p-4">
        {sequences.length === 0 ? (
          /* Empty State */
          <div className="max-w-4xl mx-auto">
            <DropZone onFilesAdded={handleFilesAdded} hasVideos={false} />

            {/* Features */}
            <div className="mt-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Privacy First */}
              <div className="bg-gray-900/50 rounded-xl p-5 border border-gray-800">
                <div className="w-10 h-10 rounded-lg bg-emerald-600/20 flex items-center justify-center mb-3">
                  <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <h3 className="font-semibold mb-1">100% Private</h3>
                <p className="text-sm text-gray-500">Everything runs in your browser. No uploads, no servers, no tracking.</p>
              </div>

              {/* Seamless Playback */}
              <div className="bg-gray-900/50 rounded-xl p-5 border border-gray-800 relative overflow-hidden">
                <img
                  src="/features/playback.png"
                  alt=""
                  className="absolute -right-2 top-1 w-28 rotate-6 opacity-100 pointer-events-none rounded-lg shadow-lg"
                />
                <div className="relative z-10">
                  <div className="w-10 h-10 rounded-lg bg-blue-600/20 flex items-center justify-center mb-3">
                    <svg className="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h3 className="font-semibold mb-1">Seamless Playback</h3>
                  <p className="text-sm text-gray-500">Consecutive clips merged into continuous video</p>
                </div>
              </div>

              {/* Live Telemetry */}
              <div className="bg-gray-900/50 rounded-xl p-5 border border-gray-800 relative overflow-hidden">
                <img
                  src="/features/telemetry.png"
                  alt=""
                  className="absolute -right-2 top-1 w-28 rotate-6 opacity-100 pointer-events-none rounded-lg shadow-lg"
                />
                <div className="relative z-10">
                  <div className="w-10 h-10 rounded-lg bg-yellow-600/20 flex items-center justify-center mb-3">
                    <svg className="w-5 h-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  </div>
                  <h3 className="font-semibold mb-1">Live Telemetry</h3>
                  <p className="text-sm text-gray-500">Speed, GPS, steering angle, and G-forces overlaid in real-time</p>
                </div>
              </div>

              {/* All 6 Cameras */}
              <div className="bg-gray-900/50 rounded-xl p-5 border border-gray-800 relative overflow-hidden">
                <img
                  src="/features/cameras.png"
                  alt=""
                  className="absolute -right-4 -top-1 w-32 rotate-6 opacity-100 pointer-events-none rounded-lg shadow-lg"
                />
                <div className="relative z-10">
                  <div className="w-10 h-10 rounded-lg bg-purple-600/20 flex items-center justify-center mb-3">
                    <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
                    </svg>
                  </div>
                  <h3 className="font-semibold mb-1">All 6 Cameras</h3>
                  <p className="text-sm text-gray-500">Front, rear, repeaters, and pillars with flexible layouts</p>
                </div>
              </div>

              {/* Interactive Map */}
              <div className="bg-gray-900/50 rounded-xl p-5 border border-gray-800 relative overflow-hidden">
                <img
                  src="/features/map.png"
                  alt=""
                  className="absolute -right-4 -top-2 w-24 rotate-6 opacity-100 pointer-events-none rounded-lg shadow-lg"
                />
                <div className="relative z-10">
                  <div className="w-10 h-10 rounded-lg bg-green-600/20 flex items-center justify-center mb-3">
                    <svg className="w-5 h-5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <h3 className="font-semibold mb-1">Interactive Map</h3>
                  <p className="text-sm text-gray-500">Live GPS tracking synced with video playback</p>
                </div>
              </div>

              {/* Event Timeline */}
              <div className="bg-gray-900/50 rounded-xl p-5 border border-gray-800 relative overflow-hidden">
                <img
                  src="/features/timeline.png"
                  alt=""
                  className="absolute -right-6 top-1 w-28 rotate-6 opacity-100 pointer-events-none rounded-lg shadow-lg"
                />
                <div className="relative z-10">
                  <div className="w-10 h-10 rounded-lg bg-orange-600/20 flex items-center justify-center mb-3">
                    <svg className="w-5 h-5 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                  </div>
                  <h3 className="font-semibold mb-1">Event Timeline</h3>
                  <p className="text-sm text-gray-500">Visual timeline showing brake, gas, blinkers, and steering</p>
                </div>
              </div>

              {/* Video Editor */}
              <div className="bg-gray-900/50 rounded-xl p-5 border border-gray-800 relative overflow-hidden">
                <img
                  src="/features/trim.png"
                  alt=""
                  className="absolute -right-2 top-1 w-28 rotate-6 opacity-100 pointer-events-none rounded-lg shadow-lg"
                />
                <div className="relative z-10">
                  <div className="w-10 h-10 rounded-lg bg-yellow-600/20 flex items-center justify-center mb-3">
                    <svg className="w-5 h-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.121 14.121L19 19m-7-7l7-7m-7 7l-2.879 2.879M12 12L9.121 9.121m0 5.758a3 3 0 10-4.243 4.243 3 3 0 004.243-4.243zm0-5.758a3 3 0 10-4.243-4.243 3 3 0 004.243 4.243z" />
                    </svg>
                  </div>
                  <h3 className="font-semibold mb-1">Video Editor</h3>
                  <p className="text-sm text-gray-500">Trim with in/out points and switch cameras at any time</p>
                </div>
              </div>

              {/* Camera Track */}
              <div className="bg-gray-900/50 rounded-xl p-5 border border-gray-800 relative overflow-hidden">
                <img
                  src="/features/camera-track.png"
                  alt=""
                  className="absolute -right-4 -top-1 w-32 rotate-6 opacity-100 pointer-events-none rounded-lg shadow-lg"
                />
                <div className="relative z-10">
                  <div className="w-10 h-10 rounded-lg bg-purple-600/20 flex items-center justify-center mb-3">
                    <svg className="w-5 h-5 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <h3 className="font-semibold mb-1">Camera Track</h3>
                  <p className="text-sm text-gray-500">Define which camera to show at each moment in the timeline</p>
                </div>
              </div>

              {/* Video Export */}
              <div className="bg-gray-900/50 rounded-xl p-5 border border-gray-800">
                <div className="w-10 h-10 rounded-lg bg-red-600/20 flex items-center justify-center mb-3">
                  <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                </div>
                <h3 className="font-semibold mb-1">Video Export</h3>
                <p className="text-sm text-gray-500">Export trimmed clips with overlays and camera switches</p>
              </div>

            </div>

            {/* Credits */}
            <div className="mt-16 pt-8 border-t border-gray-800 text-center">
              <p className="text-xs text-gray-600">
                MIT licensed ·{' '}
                <a
                  href="https://github.com/nobig-deals/exportdash.cam"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-500 hover:text-gray-400 underline underline-offset-2"
                >
                  Open Source on GitHub
                </a>
                {' '}· 100% built with{' '}
                <a
                  href="https://claude.ai/code"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-500 hover:text-gray-400 relative pl-5"
                >
                  <svg className="w-3.5 h-3.5 absolute left-0 top-[2px]" viewBox="0 0 248 248" fill="none">
                    <path d="M52.4285 162.873L98.7844 136.879L99.5485 134.602L98.7844 133.334H96.4921L88.7237 132.862L62.2346 132.153L39.3113 131.207L17.0249 130.026L11.4214 128.844L6.2 121.873L6.7094 118.447L11.4214 115.257L18.171 115.847L33.0711 116.911L55.485 118.447L71.6586 119.392L95.728 121.873H99.5485L100.058 120.337L98.7844 119.392L97.7656 118.447L74.5877 102.732L49.4995 86.1905L36.3823 76.62L29.3779 71.7757L25.8121 67.2858L24.2839 57.3608L30.6515 50.2716L39.3113 50.8623L41.4763 51.4531L50.2636 58.1879L68.9842 72.7209L93.4357 90.6804L97.0015 93.6343L98.4374 92.6652L98.6571 91.9801L97.0015 89.2625L83.757 65.2772L69.621 40.8192L63.2534 30.6579L61.5978 24.632C60.9565 22.1032 60.579 20.0111 60.579 17.4246L67.8381 7.49965L71.9133 6.19995L81.7193 7.49965L85.7946 11.0443L91.9074 24.9865L101.714 46.8451L116.996 76.62L121.453 85.4816L123.873 93.6343L124.764 96.1155H126.292V94.6976L127.566 77.9197L129.858 57.3608L132.15 30.8942L132.915 23.4505L136.608 14.4708L143.994 9.62643L149.725 12.344L154.437 19.0788L153.8 23.4505L150.998 41.6463L145.522 70.1215L141.957 89.2625H143.994L146.414 86.7813L156.093 74.0206L172.266 53.698L179.398 45.6635L187.803 36.802L193.152 32.5484H203.34L210.726 43.6549L207.415 55.1159L196.972 68.3492L188.312 79.5739L175.896 96.2095L168.191 109.585L168.882 110.689L170.738 110.53L198.755 104.504L213.91 101.787L231.994 98.7149L240.144 102.496L241.036 106.395L237.852 114.311L218.495 119.037L195.826 123.645L162.07 131.592L161.696 131.893L162.137 132.547L177.36 133.925L183.855 134.279H199.774L229.447 136.524L237.215 141.605L241.8 147.867L241.036 152.711L229.065 158.737L213.019 154.956L175.45 145.977L162.587 142.787H160.805V143.85L171.502 154.366L191.242 172.089L215.82 195.011L217.094 200.682L213.91 205.172L210.599 204.699L188.949 188.394L180.544 181.069L161.696 165.118H160.422V166.772L164.752 173.152L187.803 207.771L188.949 218.405L187.294 221.832L181.308 223.959L174.813 222.777L161.187 203.754L147.305 182.486L136.098 163.345L134.745 164.2L128.075 235.42L125.019 239.082L117.887 241.8L111.902 237.31L108.718 229.984L111.902 215.452L115.722 196.547L118.779 181.541L121.58 162.873L123.291 156.636L123.14 156.219L121.773 156.449L107.699 175.752L86.304 204.699L69.3663 222.777L65.291 224.431L58.2867 220.768L58.9235 214.27L62.8713 208.48L86.304 178.705L100.44 160.155L109.551 149.507L109.462 147.967L108.959 147.924L46.6977 188.512L35.6182 189.93L30.7788 185.44L31.4156 178.115L33.7079 175.752L52.4285 162.873Z" fill="#D97757"/>
                  </svg>
                  Claude Code
                </a>
              </p>
              <p className="mt-2 text-xs text-gray-600">
                Uses{' '}
                <a
                  href="https://github.com/teslamotors/dashcam"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-500 hover:text-gray-400 underline underline-offset-2"
                >
                  Tesla&apos;s SEI metadata spec
                </a>
                {' '}· Inspired by{' '}
                <a
                  href="https://viewdash.cam/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-500 hover:text-gray-400 underline underline-offset-2"
                >
                  ViewDash.cam
                </a>
              </p>

              {/* CTA */}
              <p className="mt-6 text-xs text-gray-600">
                Got an idea? Looking for a skilled AI-native team?{' '}
                <a
                  href="https://nobig.deals"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-gray-400 hover:text-gray-300 underline underline-offset-2"
                >
                  Drop us a message →
                </a>
              </p>
            </div>
          </div>
        ) : (
          /* Full-width Video Player with integrated controls */
          <VideoPlayer
            sequences={sequences}
            selectedSequence={selectedSequence}
            onSelectSequence={setSelectedSequence}
            onClear={handleClear}
            onAddFiles={handleFilesAdded}
          />
        )}
      </main>
    </div>
  );
}
