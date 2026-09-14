// M22 — a deterministic camera for the live browser suite (§106).
//
// Chromium can be handed a Y4M file as its fake webcam
// (--use-file-for-fake-video-capture), so `getUserMedia` returns a REAL
// MediaStream carrying frames we chose. That makes the live suite genuinely
// end to end: the app's own capture code draws from a real video element, the
// real client encodes gray8, the real transport carries it, and the real
// engine decides what it saw.
//
// The scenes come from m22/scenes.mjs — the same generator the engine is
// evaluated against — so a live journey and a unit fixture are looking at the
// same physics rather than two similar-looking approximations.
//
// A NOTE ON WHAT THIS DOES AND DOES NOT PROVE
//
// It proves the pipeline: camera → capture → encode → transport → engine →
// result → UI. It does NOT make the observation real football, and §43's
// honest statement stands unchanged — a virtual camera replaying a file is
// exactly what a spoofer would use, and this fixture IS that spoof, used
// deliberately. The live suite therefore asserts transport and UI behaviour,
// never counting accuracy.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Write a Y4M file from a normalised scene.
 *
 * gray8 in, YUV420 out: the luminance plane is the scene, and both chroma
 * planes are a flat 128 (neutral). Chromium reads that back as a grey image,
 * which is what the engine wants anyway — the client would discard colour.
 */
export async function writeY4m({
  outPath, serverRoot, w = 320, h = 240, fps = 12, durationMs = 6000,
  scene = 'touch', seed = 23,
}) {
  const scenes = await import(pathToFileURL(path.join(serverRoot, 'm22', 'scenes.mjs')).href);
  const { sequence, touchPath, jugglePath, stationaryPath } = scenes;

  const paths = {
    touch: () => touchPath({ touches: 8 }),
    juggle: () => jugglePath({ contacts: 8 }),
    still: () => stationaryPath({ x: 0.567, y: 0.83 }),
  };

  // Low light for the §105 refusal journey: the scene is legitimate, the
  // capture is simply too dark to observe reliably.
  const dark = scene === 'lowlight';
  const frames = sequence({
    w, h, fps, durationMs,
    path: (paths[dark ? 'touch' : scene] ?? paths.touch)(),
    seed,
    ...(dark ? { bgLuma: 10, ballLuma: 26, noise: 2 } : {}),
  });

  // Y4M header. Frame rate as a ratio, 4:2:0, progressive.
  const header = Buffer.from(`YUV4MPEG2 W${w} H${h} F${fps}:1 Ip A1:1 C420\n`, 'latin1');
  const chromaW = w >> 1, chromaH = h >> 1;
  const neutralChroma = Buffer.alloc(chromaW * chromaH, 128);
  const frameTag = Buffer.from('FRAME\n', 'latin1');

  const chunks = [header];
  for (const f of frames) {
    // The envelope carries base64 gray8 — exactly the luminance plane.
    const y = Buffer.from(f.data, 'base64');
    if (y.length !== w * h) {
      throw new Error(`scene frame is ${y.length} bytes, expected ${w * h} for ${w}x${h}`);
    }
    chunks.push(frameTag, y, neutralChroma, neutralChroma);
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat(chunks));
  return { outPath, frames: frames.length, w, h, fps, bytes: fs.statSync(outPath).size };
}

/** Chromium flags that turn the Y4M into the camera `getUserMedia` returns. */
export function fakeCameraArgs(y4mPath) {
  return [
    '--use-fake-ui-for-media-stream',      // no permission prompt
    '--use-fake-device-for-media-stream',  // synthetic capture device
    `--use-file-for-fake-video-capture=${y4mPath}`,
    '--autoplay-policy=no-user-gesture-required',
  ];
}
