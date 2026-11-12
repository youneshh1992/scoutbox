/** Request guards other domains' routes share. */

/** Answers 403 and returns true unless the signed-in organisation is a grassroots club. */
export function grassrootsOrgOnly(req, res) {
  if (req.org.level !== 'grassroots') {
    res.status(403).json({ error: 'GRASSROOTS_ORGS_ONLY', message: 'Open days are a ScoutBox Grassroots feature.' });
    return true;
  }
  return false;
}
