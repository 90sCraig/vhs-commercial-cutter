// Shared encoder / decoder argument builders, used by export, proxy, and detect.

// Output video codec + quality args. CPU uses x264 CRF; the hardware encoders
// use their nearest constant-quality control, mapped from the same 16–28 scale.
function videoCodecArgs(encoder, crf) {
  switch (encoder) {
    case 'nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', String(crf), '-b:v', '0'];
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
