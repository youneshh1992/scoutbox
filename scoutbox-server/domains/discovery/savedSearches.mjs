// Saved searches (moved from server.mjs): "Tell me when a left-footed U16 winger joins" — the club feed made personal.
export function registerSavedSearches({ db, byId, orgRouter, notify, persist, nextId, playerViewForOrg, reqText, badField }) {
  // "Tell me when a left-footed U16 winger joins" — the club feed made personal.
  function matchesSearch(view, f) {
    if (f.q) {
      const n = String(f.q).toLowerCase();
      if (!view.name.toLowerCase().includes(n) && !(view.city || '').toLowerCase().includes(n) && !(view.country || '').toLowerCase().includes(n)) return false;
    }
    if (f.position && view.position !== f.position) return false;
    if (f.availability && view.availability !== f.availability) return false;
    if (f.academyPlus && !view.academyPlus) return false;
    if (f.country && view.country !== f.country) return false;
    if (f.foot && view.foot !== f.foot) return false;
    if (f.ageGroup === 'u16' && view.age >= 16) return false;
    if (f.ageGroup === 'u18' && view.age >= 18) return false;
    if (f.ageGroup === '18-21' && (view.age < 18 || view.age > 21)) return false;
    if (f.ageGroup === 'senior' && view.age < 22) return false;
    return true;
  }

  // Called whenever a player joins: alert every saved search that matches.
  function checkSavedSearches(player) {
    for (const ss of db.savedSearches) {
      const org = byId.org(ss.orgId);
      if (!org) continue;
      const view = playerViewForOrg(player, org);
      if (view && matchesSearch(view, ss.filters ?? {})) {
        notify({ kind: 'org_user', id: ss.userId }, 'saved_search', `New match for your saved search “${ss.name}”: ${player.name} (${player.position ?? '—'}) just joined.`, player.id);
      }
    }
  }

  orgRouter.get('/searches', (req, res) => {
    res.json(db.savedSearches.filter((s) => s.orgId === req.org.id));
  });

  orgRouter.post('/searches', (req, res) => {
    const { name, filters } = req.body || {};
    if (!reqText(name, 120)) return res.status(400).json({ error: 'NAME_REQUIRED' }); // PRE-M24 (PM-10)
    if (filters != null && (typeof filters !== 'object' || Array.isArray(filters))) return badField(res, 'filters');
    const ss = { id: nextId('ss'), orgId: req.org.id, userId: req.orgUser.id, scoutName: req.orgUser.name, name: name.trim(), filters: filters ?? {}, createdAt: Date.now() };
    db.savedSearches.push(ss);
    res.status(201).json(ss);
  });

  orgRouter.delete('/searches/:id', (req, res) => {
    const idx = db.savedSearches.findIndex((s) => s.id === req.params.id && s.orgId === req.org.id);
    if (idx === -1) return res.status(404).json({ error: 'SEARCH_NOT_FOUND' });
    db.savedSearches.splice(idx, 1);
    persist();
    res.json({ ok: true });
  });

  return { checkSavedSearches };
}
