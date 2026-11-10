// Football activity feeds the streak and weekly-goal habit loop, and Grassroots journey badges are awarded as the
// record grows. Level-up moments are handled at the signing itself.
import { computeStreak } from '../../domain.mjs';
import { earnedGrassrootsBadges } from '../../grassrootsJourney.mjs';

export function createActivity({ players, notify }) {
  if (typeof players?.addItem !== 'function' || typeof notify !== 'function')
    throw new TypeError('createActivity needs the players repository and notify');

  function refreshJourneyBadges(given) {
    const player = players.byId(given.id); // the stored record, with the caller's writes
    if (!player || player.level === 'pro') return;
    const earned = earnedGrassrootsBadges(player, { streak: computeStreak(player.activityLog) });
    for (const badge of earned) {
      if (!(player.badges ?? []).includes(badge)) {
        players.addItem(player.id, 'badges', badge);
        notify(
          { kind: 'player', id: player.id },
          'badge',
          `🏅 Badge earned: ${badge}. It's on your profile — recognition that never depends on being scouted.`,
          player.id,
        );
      }
    }
  }

  function recordActivity(player) {
    players.addItem(player.id, 'activityLog', Date.now());
    refreshJourneyBadges(players.byId(player.id));
  }

  return { recordActivity, refreshJourneyBadges };
}
