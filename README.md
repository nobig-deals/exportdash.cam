# ExportDash

> Tesla dashcam viewer with seamless playback, live telemetry overlays, and video export.

**[Live Demo → exportdash.cam](https://exportdash.cam)**

![ExportDash Screenshot](public/screenshot.png)

**[How it works (full walkthrough) →](https://www.youtube.com/watch?v=6MzdHHmzrME)**

## Features

- **Seamless Playback** — Consecutive 1-minute Tesla clips automatically merged into continuous video
- **Live Telemetry Overlay** — Speed, GPS coordinates, steering angle, and G-forces displayed in real-time
- **All 6 Camera Angles** — Front, rear, left/right repeaters, and pillar cameras with flexible layouts
- **Interactive Map** — Live GPS tracking synced with video playback
- **Event Timeline** — Visual timeline showing brake, gas, turn signals, and steering events
- **Video Export** — Export clips with telemetry burned into the video
- **Encrypted Clip Support** — Decrypt Tesla 2026.20+ encrypted recordings in-browser using your Tesla account token
- **100% Client-Side** — All processing happens in your browser, no uploads required

## Deploy

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.app/new/template?template=https://github.com/nobig-deals/exportdash.cam)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/nobig-deals/exportdash.cam)
[![Deploy to Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy/?template=https://github.com/nobig-deals/exportdash.cam)

## Quick Start

```bash
# Clone the repo
git clone https://github.com/nobig-deals/exportdash.cam.git
cd exportdash.cam

# Install dependencies
npm install

# Start dev server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and drop your TeslaCam folder.

### Docker

```bash
# Build image
docker build -t exportdash .

# Run container
docker run -p 8080:80 exportdash
```

Open [http://localhost:8080](http://localhost:8080)

### Docker Compose

```bash
docker compose up
```

Open [http://localhost:8080](http://localhost:8080)

## How It Works

Tesla dashcam videos contain embedded SEI (Supplemental Enhancement Information) metadata with telemetry data:

- Vehicle speed
- GPS coordinates & heading
- Steering wheel angle
- Accelerator & brake pedal state
- Turn signal status
- G-force readings

ExportDash extracts this metadata using [Tesla's official protobuf schema](https://github.com/teslamotors/dashcam) and displays it as an overlay synchronized with video playback.

### Sequence Detection

Tesla records 1-minute clips continuously. ExportDash automatically detects consecutive clips and merges them:

```
Clip 1: 10:30:00 (60s) ─┐
Clip 2: 10:31:00 (60s)  ├─→ Single 5-minute sequence
Clip 3: 10:32:00 (60s)  │
Clip 4: 10:33:00 (60s)  │
Clip 5: 10:34:00 (60s) ─┘

Clip 6: 10:45:00 (60s) ─→ New sequence (12min gap)
```

## Encrypted Clips (firmware 2026.20+)

Recent Tesla firmware encrypts dashcam and Sentry recordings on the USB drive.
When you drop encrypted clips, ExportDash detects them and offers to decrypt
them in your browser:

1. Sign in at [dashcam.tesla.com](https://dashcam.tesla.com) and grab your
   dashcam token from DevTools → Network → any `/api/1/` request →
   `Authorization: Bearer …`.
2. Paste it into the prompt. ExportDash fetches the per-file decryption keys from
   Tesla and decrypts the video locally.

**How it stays private:**

- Your video **never leaves your device** — decryption runs entirely in the
  browser using the native WebCrypto AES engine.
- Only per-file identifiers and ownership metadata (never footage) are sent to
  Tesla to retrieve the decryption keys — exactly what Tesla's own web viewer
  sends.
- Your token is stored only in your browser (localStorage, opt-in "remember")
  and is sent only to Tesla. Treat it like a password; it expires periodically.

**Why a proxy:** browsers can't call `dashcam.tesla.com` directly from another
origin (CORS). The key request is routed same-origin through a thin reverse
proxy that forwards only to Tesla — the Next.js dev server handles this locally
(`next.config.ts`), a Cloudflare Pages Function handles it on exportdash.cam
(`functions/tesla-decrypt/[[path]].ts`), and nginx handles it in the Docker image
(`nginx.conf`). Point it elsewhere with `NEXT_PUBLIC_TESLA_KEY_URL` if needed.
The proxy adds no credentials of its own; it only relays your authenticated
request to Tesla. Note that this means your bearer token transits the proxy host
on its way to Tesla — it is never logged or stored there, but if you'd rather it
never left your machine, run the Docker image yourself and use that instance.

## Tech Stack

- **Framework:** Next.js 15 with App Router
- **Styling:** Tailwind CSS
- **Video:** Native HTML5 video with WebCodecs for export
- **Maps:** Leaflet with OpenStreetMap
- **Protobuf:** protobufjs for SEI metadata decoding

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Space` | Play / Pause |
| `←` `→` | Seek ±5 seconds |
| `[` `]` | Previous / Next clip |
| `1` `2` `3` `4` | Layout: Single / PiP / Triple / All |
| `T` | Toggle telemetry overlay |
| `M` | Toggle map |
| `D` | Toggle date/time overlay |
| `E` | Toggle edit mode (trim) |
| `U` | Toggle mph / km/h |
| `F` | Fullscreen |

## Project Structure

```
src/
├── app/
│   └── page.tsx          # Main app component
├── components/
│   ├── VideoPlayer.tsx   # Multi-camera player with controls
│   ├── TelemetryCard.tsx # Speed/telemetry overlay
│   ├── TelemetryTimeline.tsx # Event timeline visualization
│   ├── MapView.tsx       # GPS map overlay
│   ├── VideoExporter.tsx # WebCodecs-based export
│   ├── DropZone.tsx      # File/folder drop handling
│   ├── DecryptDialog.tsx # Encrypted-clip token prompt & decrypt progress
│   └── LoadingScreen.tsx # Processing progress UI
├── hooks/
│   └── useSeiData.ts     # SEI extraction & time sync
├── lib/
│   ├── dashcam-mp4.ts    # MP4 parsing & SEI extraction
│   ├── tesla-crypto.ts   # MD5 + AES-128-CBC primitives (verified vs test vectors)
│   ├── tesla-decrypt.ts  # Encrypted container parsing, key fetch & decryption
│   └── sequence-detector.ts # Clip merging logic
└── types/
    └── video.ts          # TypeScript definitions
```

## Credits

- [Tesla Dashcam](https://github.com/teslamotors/dashcam) — Official SEI metadata protobuf schema
- [ViewDash.cam](https://viewdash.cam/) ([source](https://github.com/pixeye33/viewdashcam)) — Original inspiration

## License

MIT
