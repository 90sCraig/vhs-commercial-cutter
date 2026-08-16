// Shared encoder / decoder argument builders, used by export, proxy, and detect.

// nvenc's -cq and x264's -crf are NOT the same scale, despite both running 0-51.
// Handing nvenc the CRF number directly produced files 2.2-2.8x larger than the
// CPU encoder at the same quality preset, which made every size figure in the
// UI wrong for anyone whose first-run probe picked a hardware encoder.
//
// Measured on a 90s 1080p60 capture, matching output size against x264:
//
//   crf 16 (170.6 MB) -> cq 25 (155.9 MB)
//   crf 18 (128.4 MB) -> cq 28 (104.9 MB)
//   crf 21 ( 79.4 MB) -> cq 31 ( 67.6 MB)
//   crf 24 ( 46.8 MB) -> cq 34 ( 39.4 MB)
//   crf 28 ( 21.9 MB) -> cq 37 ( 24.8 MB)
//
// Those are the nearest sampled rungs; interpolating between them puts the true
// crossover at +8.4 to +9.6 depending on the rung, so +9. (+10 was tried and
// undershot: it produced 49 MB where the CPU encoder produced 83, which is the
// same problem in the other direction.)
//
// Size is not traded for quality here. At the matched point SSIM against the
// source measured 0.9687 for nvenc against 0.9696 for x264, a difference far
// below anything visible, while nvenc at the unmapped cq spent 2.8x the bytes
// for +0.0008.
//
// One constant cannot land on parity for every tape: the crossover moves with
// content. On a second capture this maps 57 MB against the CPU encoder's 83 for
// the same preset, so hardware output still runs smaller. That direction is
// harmless (equivalent quality, fewer bytes) and worth far more than chasing an
// exact match by overfitting to whichever tape was measured last.
const NVENC_CQ_OFFSET = 9;

// Output video codec + quality args. CPU uses x264 CRF; the hardware encoders
// use their nearest constant-quality control.
function videoCodecArgs(encoder, crf) {
  switch (encoder) {
    case 'nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr',
        '-cq', String(crf + NVENC_CQ_OFFSET), '-b:v', '0'];
    // qsv and amf are left on the raw number deliberately. Their controls are
    // different again (-global_quality, and -qp_* which is a fixed quantiser
    // rather than a quality target), and there is no Intel or AMD hardware here
    // to measure them against. Guessing an offset would risk making them worse.
    case 'qsv':
      return ['-c:v', 'h264_qsv', '-global_quality', String(crf), '-preset', 'veryfast'];
    case 'amf':
      return ['-c:v', 'h264_amf', '-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf), '-qp_b', String(crf)];
    default:
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf)];
  }
}

// Short-GOP args so proxies seek instantly (~1 keyframe/sec), per encoder.
function proxyGopArgs(encoder) {
  switch (encoder) {
    case 'nvenc': return ['-g', '30', '-no-scenecut', '1'];
    case 'qsv':
    case 'amf':   return ['-g', '30'];
    default:      return ['-g', '30', '-keyint_min', '30', '-sc_threshold', '0'];
  }
}

// Hardware-accelerated DECODE flag for the selected GPU (input side), or null.
// Frames are copied back to system memory so CPU filters (scale, blackdetect,
// silencedetect) still work.
//
// NOTHING CALLS THIS RIGHT NOW, on purpose. Every place that used to — proxy
// building and the detection scan — measured faster without it, because both
// feed CPU filters and neither has a hardware encoder on the far end, so the
// readback is paid for nothing. On one RTX 5080 the penalty was 2.8x on proxy
// building and 3.9x on detection, scaling with length rather than a fixed
// startup cost. Keeping the helper because that finding is one machine's, and
// a weak CPU could easily flip it; see the comments in src/proxy.js and the
// detect handlers in main.js.
function decodeAccel(encoder) {
  switch (encoder) {
    case 'nvenc': return 'cuda';
    case 'qsv':   return 'qsv';
    case 'amf':   return 'd3d11va';
    default:      return null;
  }
}

module.exports = { videoCodecArgs, proxyGopArgs, decodeAccel };
