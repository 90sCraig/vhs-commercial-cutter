# Changelog

## 0.5.0

**Choose your keyboard layout.** Settings now offers Default or VideoReDo, and the hint line under the segment list updates to match. If you came from VideoReDo, its navigation works the way you expect: single frames on the up and down arrows, larger jumps on left and right with Shift and Ctrl as multipliers, two-minute jumps on Page Up and Page Down, and F3 and F4 to mark in and out.

Split, merge and save/skip keep the same keys in both layouts. VideoReDo uses those letters for other things, but they're the keys you reach for most here, so they stay put.

**Tab steps through the cut list**, Shift+Tab goes back. On a tape with eighty segments, reviewing them from the keyboard instead of clicking each one is the difference between a minute and ten.

## 0.4.0

**Save cut points as text.** A new button in Export writes the in and out points without encoding anything, so it's instant even on a long tape. You get a CSV with frame numbers, timecodes and durations, plus an AviSynth `Trim()` chain ready to paste. Frame numbers are absolute positions in your source, accurate to about ±2 frames. It follows your commercials-or-show selection, so both directions come from the same button. Useful if you'd rather cut in another editor, or hand the cut list to a script.

**Detection settings are remembered**, and there's a strength picker. Strict, Balanced, Sensitive and Aggressive set the two thresholds to sensible starting points; touching a slider switches it to Custom. Everything survives a restart instead of resetting each session.

**Threshold calibration, marked experimental.** Turn on *Show experimental features* in Settings and a Calibrate button appears in Detect. It samples 20 minutes of the tape at five sensitivities and keeps the highest one still finding real breaks — about 45 seconds. This exists because there is no universally right setting: two tapes from the same collection and deck wanted noticeably different values, and the shipped default was blind on one of them. It's flagged experimental because it's only been checked against those two tapes.

**Help text is now optional.** Every control's explanatory line can be hidden with a switch in the top bar, off by default for a tighter panel. Tooltips and the Guide are unaffected. Min commercial gap and the colour balance sliders gained explanations they were missing.

**Colour sliders collapse when Correct color is off**, rather than sitting there greyed out.

**Quality presets renamed.** They used to be named after delivery formats — Blu-ray, DVD — which promised something the setting doesn't control, since resolution always follows your source. They now state file size against Archive: 100, 75, 45, 30 and 15 percent, measured on a real capture. As compression rises, tape grain gets smoothed away, which is the trade actually being made.

## 0.3.1

**Preview these effects works again.** The button failed with "Error opening input file undefined" every time it was pressed. The preview request sent the file path under the wrong name, so FFmpeg was handed nothing at all. This had been broken since before 0.2.0, so it never worked in any released build.

**New icon.**

## 0.3.0

**Detection is roughly 8× faster.** It now scans the small preview copy instead of your original capture. Black frames and silence read the same at low resolution, so the result is identical — on a two-hour 1080p capture stored on a network drive, a scan that took 6 minutes 53 seconds now takes 53 seconds, finding exactly the same breaks. Export still always uses your full-quality original. There's a switch in Settings if you'd rather scan the original.

**Detection strength presets.** A single control at the top of the Detect card with four starting points: Strict for a clean tape with crisp fades, Balanced for most tapes, Sensitive for a worn tape with grainy black, and Aggressive as a last resort that will over-split. Moving any slider by hand switches it to Custom. If it missed breaks, go up a step; if it found too many, go down.

**Detection settings are remembered.** Thresholds and your preset choice survive a restart instead of resetting every session.

**Scene-change rate per clip.** Each segment in the list now shows how many times a minute it cuts. Commercials cut faster than programmes — on a test tape, ads ran at 27 cuts per minute against about 10 for the show — which makes it a useful second opinion when you're deciding whether the detector got a clip right. It's shown for you to read; it doesn't change what gets saved.

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
