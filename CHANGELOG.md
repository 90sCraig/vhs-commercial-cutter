# Changelog

## 0.3.0

**Detection is roughly 8× faster.** It now scans the small preview copy instead of your original capture. Black frames and silence read the same at low resolution, so the result is identical — on a two-hour 1080p capture stored on a network drive, a scan that took 6 minutes 53 seconds now takes 53 seconds, finding exactly the same breaks. Export still always uses your full-quality original. There's a switch in Settings if you'd rather scan the original.

**Detection strength presets.** A single control at the top of the Detect card with four starting points: Strict for a clean tape with crisp fades, Balanced for most tapes, Sensitive for a worn tape with grainy black, and Aggressive as a last resort that will over-split. Moving any slider by hand switches it to Custom. If it missed breaks, go up a step; if it found too many, go down.

**Detection settings are remembered.** Thresholds and your preset choice survive a restart instead of resetting every session.

**Scene-change rate per clip.** Each segment in the list now shows how many times a second it cuts. Commercials cut faster than programmes — on a test tape, ads ran at 27 cuts per minute against about 10 for the show — which makes it a useful second opinion when you're deciding whether the detector got a clip right. It's shown for you to read; it doesn't change what gets saved.

**Timeline fixes.**

- Boundary handles no longer crowd together when zoomed out on a tape with many breaks, where they stopped looking like handles and started looking like yellow clips of their own. Zoom in and they return.
- Clicking a clip on the timeline now scrolls the list below to that clip.
- The save/skip tag looks clickable now, because it always was.

## 0.2.1

**Preview building can be cancelled.** It was the last long-running job with no way to stop it, which stung on a two-hour tape. The player falls back to your original file.

## 0.2.0

**Renamed to VHS Commercial Cutter**, with a new icon.

**Detection and export can be stopped mid-run** with an Abort button, rather than leaving you to wait or kill the app.

**The encoder is chosen for you on first launch.** It tries NVIDIA, Intel and AMD hardware encoding in turn and keeps the fastest that works, instead of defaulting everyone to CPU.

**Long exports are safer to walk away from.** They keep the machine awake, stage working files beside your output instead of quietly filling the Windows drive, check there's room before starting rather than dying an hour in, and fall back to CPU if a hardware encoder gives out partway through.

**Simplified export.** Vertical/social reframing, the fill options, and the resolution and frame-rate pickers are gone. Resolution and frame rate now always match your source. Frame is either the source shape or 4:3, which centre-crops — on a 4:3 picture inside a 16:9 frame that removes exactly the black pillars and keeps all the picture.

**Playback pauses when a job starts**, instead of competing with it for the same disk.

## 0.1.0

First release. Commercial detection via black-frame and audio-silence correlation, a timeline with zoom, minimap and manual clip editing, preview proxies with an LRU cache, VHS clean-up (denoise, sharpen, colour, audio drift), CPU/GPU encoding, and bundled FFmpeg.
