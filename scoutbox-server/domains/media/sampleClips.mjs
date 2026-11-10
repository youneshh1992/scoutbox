// A first installation gives three demo players their sample clips. The assets are optional: without them the Film
// Room starts empty.
import fs from 'node:fs';
import path from 'node:path';

const SAMPLE_CLIPS = [
  { file: 'clip-sprint.webm', playerId: 'pl-adeyemi', title: 'Sprint & finishing session' },
  { file: 'clip-passing.webm', playerId: 'pl-carvalho', title: 'Passing range compilation' },
  { file: 'clip-wingplay.webm', playerId: 'pl-guni', title: 'U15 highlights — wing play' },
];

export function installSampleClips({ assetsDir, findPlayer, players, storage }) {
  for (const sample of SAMPLE_CLIPS) {
    try {
      const data = fs.readFileSync(path.join(assetsDir, sample.file));
      const player = findPlayer(sample.playerId);
      const media = player?.media.find((m) => m.title === sample.title);
      if (!media) continue;
      storage.saveDataUrl(media.id, `data:video/webm;base64,${data.toString('base64')}`);
      // Each sample is a verified clip of the player's first attended fixture.
      players.patchItem(player.id, 'media', { id: media.id }, { url: `/media/${media.id}`, ...(player.attendance[0] ? { verifiedClip: player.attendance[0].id } : {}) });
    } catch {
      // the asset is optional
    }
  }
}
