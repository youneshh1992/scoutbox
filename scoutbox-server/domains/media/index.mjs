// Media: signed media URLs and the media route, resumable uploads, sample clips, and the deletion of stored files.
import { needs, strictContext } from '../platform/deps.mjs';
import { installSampleClips } from './sampleClips.mjs';
import { installSignedMedia } from './signedMedia.mjs';
import { registerUploads, removeUploadChunks } from './uploads.mjs';

/** Signs every media reference in a JSON response for the caller's session, so it is installed before any route. */
export function createMediaSigning(deps) {
  installSignedMedia(
    strictContext(
      'createMediaSigning',
      needs('createMediaSigning', deps, [
        'app',
        'byId',
        'sessions',
        'mediaDeletions',
        'storage',
        'sessionFor',
        'isBlocked',
      ]),
    ),
  );
}

/**
 * The upload routes, and the sample clips a first installation gets. Returns the sweeps (`sweepUploads`, and
 * `sweepDeletions`, which retries files whose removal was committed but not completed) and `removeUploadChunks`.
 */
export function createMedia(deps) {
  const d = strictContext(
    'createMedia',
    needs('createMedia', deps, [
      'playerRouter',
      'playerRecord',
      'uploadSessions',
      'mediaDeletions',
      'storage',
      'findPlayer',
      'firstInstallation',
      'assetsDir',
      'moderateOrRefuse',
      'recordActivity',
      'unit',
      'nextId',
      'broadcast',
      'DATA_DIR',
    ]),
  );
  const { playerRecord, storage } = d;
  if (d.firstInstallation)
    installSampleClips({ assetsDir: d.assetsDir, findPlayer: d.findPlayer, playerRecord, storage });
  const { sweepUploads } = registerUploads(
    strictContext('createMedia', {
      DATA_DIR: d.DATA_DIR,
      broadcast: d.broadcast,
      moderateOrRefuse: d.moderateOrRefuse,
      nextId: d.nextId,
      uploadSessions: d.uploadSessions,
      playerRouter: d.playerRouter,
      playerRecord,
      recordActivity: d.recordActivity,
      storage,
      unit: d.unit,
    }),
  );
  const sweepDeletions = () => d.mediaDeletions.process(storage);
  return { sweepUploads, sweepDeletions, removeUploadChunks };
}
