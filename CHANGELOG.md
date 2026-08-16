# Changelog

## 0.7.1

**Drag the split between the player and the segment list.** On a tape with eighty segments the old fixed height showed about four at a time. Grab the handle above the list and pull. Double-click it to go back to the default, and the size is remembered.

**Exports on a graphics card are no longer several times larger than they should be.** The quality presets are defined as x264 CRF values, and the same number was being handed straight to NVIDIA's encoder, where it means something quite different. The result was files 2.2 to 2.8 times bigger than the CPU encoder produced at the same setting, for no visible gain: measured against the source, the extra bytes bought 0.0008 of SSIM. Anyone whose encoder was picked automatically on first run has been getting those sizes, which also made every file-size figure in the app wrong for them. Now mapped from a measured ladder. Exports will be noticeably smaller and quicker to write.

**If exports feel slower than they used to**, it is the torn frame repair, which costs about 39 percent and switches itself on for tapes that need it. Turn it off in Restore when a tape does not.

## 0.7.0

**The old color preview was wrong, and had been since it was added.** It multiplied brightness where the export adds it. At a brightness of 0.20 the player showed 154 where your export produced 176, so anyone who set their color by eye against the preview got something different in the finished file. If you have tapes you corrected that way, they are worth a second look.

**The restoration controls are live now.** Drag a slider and the picture changes, instead of waiting on a six second render to see anything. Brightness, contrast, saturation, gamma and RGB balance all update as you move them, and this time the math was measured against the encoder rather than guessed at. Across ten colors and five settings it sits within about three levels out of 255 of what will actually export, which is far below what an eye can pick out. Gamma is the loosest of them at the extremes, so the panel says color "tracks closely" rather than promising an exact match.

**Denoise and sharpen preview too, roughly.** They are marked as approximations because that is what they are. Both work in pixels, and playback uses the small preview copy rather than your full size original, so their strength is scaled for the difference. The real denoise also filters across time, which nothing running live can do. Use Preview for the exact result before committing to a long export.

**Audio drift previews in one direction.** Pushing audio later works live. Pulling it earlier would mean holding the video back, which is not possible during playback, so a negative setting now says so instead of looking like a broken slider.

## 0.6.1

**Preview building is about two and a half times faster, by using the graphics card less.** That is the opposite of what you would expect, so here are the numbers. Building a preview copy with NVIDIA hardware decoding ran at 8x realtime; the same job on the CPU ran at 20.6x. It is not the cost of copying frames back from the card either, because keeping the whole pipeline on the GPU measured 8.3x, no better. The hardware decoder is simply slower than the CPU for this kind of footage. On a four hour capture that is roughly thirty minutes down to eleven.

**Preview copies are also about three times smaller**, because the quality number meant something different to the hardware encoder than it did to the CPU one. A four hour tape now caches at around 1 GB instead of 3.6 GB, so the default 8 GB cache holds seven tapes rather than two. Existing preview copies are rebuilt once, the first time you reopen each tape.

**Detection got faster for the same reason.** It is a decode only pass feeding filters that run on the CPU, with no hardware encoder on the other end, so hardware decoding was pure overhead: 1.1 seconds against 4.2 on the same scan. Graphics card encoding still handles export, where it is paired with a hardware encoder and earns its keep.

**The Restore panel is organized into three groups** now that there is more in it: Repair, Picture, and Sound, in the order they are applied to the video. Color balance sits visibly inside Correct color rather than looking like a control of its own, and the Guide covers Normalize loudness, which it had never mentioned.

## 0.6.0

**Repairs torn frames.** Some capture devices lose sync a few times a second and write a frame split across two positions, with a band of corrupted data between them. On screen this reads as a stutter, which sends you looking for a frame rate problem that isn't there: the timestamps are perfectly even, and every filter aimed at cadence or brightness leaves it untouched. A new switch in Restore rebuilds those frames from the ones either side. On a four hour capture it took 14 broken frames per 500 down to none, while barely touching the good ones. It adds about a third to encode time.

**Tapes are checked for tearing when you open them.** The check samples three windows of the preview copy and takes about a second. If it finds tearing it says so in the Restore panel and switches the repair on, because this is not a defect anyone spots by eye and goes looking for a setting to fix. A clean tape shows nothing and costs nothing. Measured against two captures: one tear a second on the affected one, and no false positives at all on the clean one.

**Cuts per minute is no longer wrong on torn tapes.** A torn frame differs so much from both its neighbors that scene detection counted it as a cut. On an affected tape that read 36 cuts per minute against 6 once repaired, which made the commercials-cut-faster comparison worse than no number at all. Detection now repairs before it measures, but only on tapes where tearing was actually found, because doing it costs roughly three and a half times the scan time.

**Undo and redo.** Fifty steps of history over the segment list, covering boundary drags, keep and skip toggles, split, merge, in and out points, keep all, and invert. `Ctrl+Z` and `Ctrl+Y`, plus buttons beside the segment actions.

## 0.5.0

**Choose your keyboard layout.** Settings now offers Default or VideoReDo, and the hint line under the segment list updates to match. If you came from VideoReDo, its navigation works the way you expect: single frames on the up and down arrows, larger jumps on left and right with Shift and Ctrl as multipliers, two-minute jumps on Page Up and Page Down, and F3 and F4 to mark in and out.

Split, merge and save/skip keep the same keys in both layouts. VideoReDo uses those letters for other things, but they're the keys you reach for most here, so they stay put.

**Tab steps through the cut list**, Shift+Tab goes back. On a tape with eighty segments, reviewing them from the keyboard instead of clicking each one is the difference between a minute and ten.

## 0.4.0

**Save cut points as text.** A new button in Export writes the in and out points without encoding anything, so it's instant even on a long tape. You get a CSV with frame numbers, timecodes and durations, plus an AviSynth `Trim()` chain ready to paste. Frame numbers are absolute positions in your source, accurate to about ±2 frames. It follows your commercials-or-show selection, so both directions come from the same button. Useful if you'd rather cut in another editor, or hand the cut list to a script.

**Detection settings are remembered**, and there's a strength picker. Strict, Balanced, Sensitive and Aggressive set the two thresholds to sensible starting points; touching a slider switches it to Custom. Everything survives a restart instead of resetting each session.

**Threshold calibration, marked experimental.** Turn on *Show experimental features* in Settings and a Calibrate button appears in Detect. It samples 20 minutes of the tape at five sensitivities and keeps the highest one still finding real breaks — about 45 seconds. This exists because there is no universally right setting: two tapes from the same collection and deck wanted noticeably different values, and the shipped default was blind on one of them. It's flagged experimental because it's only been checked against those two tapes.

**Help text is now optional.** Every control's explanatory line can be hidden with a switch in the top bar, off by default for a tighter panel. Tooltips and the Guide are unaffected. Min commercial gap and the color balance sliders gained explanations they were missing.

**Color sliders collapse when Correct color is off**, rather than sitting there grayed out.

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

**Simplified export.** Vertical/social reframing, the fill options, and the resolution and frame-rate pickers are gone. Resolution and frame rate now always match your source. Frame is either the source shape or 4:3, which center-crops — on a 4:3 picture inside a 16:9 frame that removes exactly the black pillars and keeps all the picture.

**Playback pauses when a job starts**, instead of competing with it for the same disk.

## 0.1.0

First release. Commercial detection via black-frame and audio-silence correlation, a timeline with zoom, minimap and manual clip editing, preview proxies with an LRU cache, VHS clean-up (denoise, sharpen, color, audio drift), CPU/GPU encoding, and bundled FFmpeg.
