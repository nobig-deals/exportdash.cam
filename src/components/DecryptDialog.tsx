'use client';

import { useState } from 'react';
import {
  IconLock,
  IconKey,
  IconShieldLock,
  IconAlertTriangle,
  IconLoader2,
  IconExternalLink,
  IconX,
  IconEye,
  IconEyeOff,
} from '@tabler/icons-react';

interface DecryptDialogProps {
  /** How many dropped clips are encrypted. */
  fileCount: number;
  /** Token remembered on this device, if any (pre-fills the input). */
  initialToken?: string;
  onCancel: () => void;
  /**
   * Perform decryption. Should throw on failure (invalid token, CORS, etc.);
   * the dialog stays open and shows the error. `onProgress` reports the file
   * currently being decrypted and its 0..1 completion.
   */
  onDecrypt: (
    token: string,
    remember: boolean,
    onProgress: (label: string, fraction: number) => void
  ) => Promise<void>;
}

export function DecryptDialog({ fileCount, initialToken = '', onCancel, onDecrypt }: DecryptDialogProps) {
  const [token, setToken] = useState(initialToken);
  const [remember, setRemember] = useState(true);
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progressLabel, setProgressLabel] = useState('');
  const [progressFraction, setProgressFraction] = useState(0);

  const canDecrypt = token.trim().length > 0 && !busy;

  const handleDecrypt = async () => {
    if (!canDecrypt) return;
    setBusy(true);
    setError(null);
    setProgressLabel('Fetching keys from Tesla…');
    setProgressFraction(0);
    try {
      await onDecrypt(token.trim(), remember, (label, fraction) => {
        setProgressLabel(label);
        setProgressFraction(fraction);
      });
      // On success the parent unmounts this dialog.
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Decryption failed.');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-gray-950/90 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="relative w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl bg-gray-900 border border-gray-800 shadow-2xl">
        {/* Close */}
        {!busy && (
          <button
            onClick={onCancel}
            className="absolute right-4 top-4 text-gray-500 hover:text-gray-300 transition-colors"
            aria-label="Cancel"
          >
            <IconX size={20} />
          </button>
        )}

        <div className="p-6">
          {/* Header */}
          <div className="flex items-start gap-3 mb-4">
            <div className="w-11 h-11 rounded-xl bg-amber-500/15 flex items-center justify-center flex-shrink-0">
              <IconLock size={22} className="text-amber-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">
                {fileCount === 1 ? 'Encrypted clip detected' : `${fileCount} encrypted clips detected`}
              </h2>
              <p className="text-sm text-gray-400 mt-0.5">
                Recent Tesla firmware (2026.20+) encrypts dashcam recordings on the USB drive. To
                play them here, they need to be decrypted first.
              </p>
            </div>
          </div>

          {/* How it works / how to get token */}
          <div className="rounded-xl bg-gray-800/50 border border-gray-700/60 p-4 mb-4">
            <div className="flex items-center gap-2 mb-2">
              <IconKey size={16} className="text-blue-400" />
              <span className="text-sm font-medium text-gray-200">Get your Tesla dashcam token</span>
            </div>
            <ol className="text-sm text-gray-400 space-y-1.5 list-decimal list-inside">
              <li>
                Open{' '}
                <a
                  href="https://dashcam.tesla.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-0.5"
                >
                  dashcam.tesla.com <IconExternalLink size={13} />
                </a>{' '}
                and sign in with your Tesla account.
              </li>
              <li>
                Open your browser&apos;s DevTools (<span className="font-mono text-xs text-gray-300">F12</span>) →{' '}
                <span className="text-gray-300">Network</span> tab.
              </li>
              <li>Drag any encrypted clip onto that page so it makes a request.</li>
              <li>
                Click a request to <span className="font-mono text-xs text-gray-300">/api/1/</span> → in{' '}
                <span className="text-gray-300">Headers</span>, copy the value after{' '}
                <span className="font-mono text-xs text-gray-300">Authorization: Bearer</span>.
              </li>
            </ol>
          </div>

          {/* Token input */}
          <label className="block text-sm font-medium text-gray-300 mb-1.5">Tesla token</label>
          <div className="relative mb-3">
            <input
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              disabled={busy}
              placeholder="Paste your Bearer token…"
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-lg bg-gray-950 border border-gray-700 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 outline-none text-sm text-gray-100 font-mono px-3 py-2.5 pr-10 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => setShowToken((v) => !v)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300"
              aria-label={showToken ? 'Hide token' : 'Show token'}
            >
              {showToken ? <IconEyeOff size={18} /> : <IconEye size={18} />}
            </button>
          </div>

          {/* Remember */}
          <label className="flex items-center gap-2 mb-4 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              disabled={busy}
              className="w-4 h-4 rounded border-gray-600 bg-gray-950 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm text-gray-300">Remember this token on this device</span>
          </label>

          {/* Security info */}
          <div className="rounded-xl bg-emerald-500/5 border border-emerald-500/20 p-4 mb-4">
            <div className="flex items-center gap-2 mb-2">
              <IconShieldLock size={16} className="text-emerald-400" />
              <span className="text-sm font-medium text-emerald-300">Your privacy &amp; security</span>
            </div>
            <ul className="text-xs text-gray-400 space-y-1.5">
              <li className="flex gap-2">
                <span className="text-emerald-500">•</span>
                <span>
                  Your video never leaves your device. Decryption happens entirely in your browser.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-emerald-500">•</span>
                <span>
                  Only per-file identifiers are sent to Tesla to retrieve the decryption keys — never
                  the footage itself.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-amber-500">•</span>
                <span>
                  Your token grants access to your Tesla dashcam account — treat it like a password.
                  It&apos;s stored only {remember ? 'in this browser (localStorage)' : 'in memory for this session'} and
                  is sent only to Tesla.
                </span>
              </li>
              <li className="flex gap-2">
                <span className="text-amber-500">•</span>
                <span>Tokens expire periodically; grab a fresh one if decryption fails.</span>
              </li>
            </ul>
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-xl bg-red-500/10 border border-red-500/30 p-3 mb-4 flex gap-2">
              <IconAlertTriangle size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-red-300">{error}</p>
            </div>
          )}

          {/* Progress */}
          {busy && (
            <div className="mb-4">
              <div className="flex items-center gap-2 text-sm text-gray-300 mb-2">
                <IconLoader2 size={16} className="animate-spin text-blue-400" />
                <span className="truncate">{progressLabel}</span>
              </div>
              <div className="h-1.5 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-blue-600 to-blue-400 rounded-full transition-all duration-200"
                  style={{ width: `${Math.round(progressFraction * 100)}%` }}
                />
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={onCancel}
              disabled={busy}
              className="flex-1 px-4 py-2.5 rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800 transition-colors disabled:opacity-50 text-sm font-medium"
            >
              Cancel
            </button>
            <button
              onClick={handleDecrypt}
              disabled={!canDecrypt}
              className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-sm font-medium inline-flex items-center justify-center gap-2"
            >
              {busy ? (
                <>
                  <IconLoader2 size={16} className="animate-spin" /> Decrypting…
                </>
              ) : (
                <>
                  <IconLock size={16} /> Decrypt {fileCount === 1 ? 'clip' : `${fileCount} clips`}
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
