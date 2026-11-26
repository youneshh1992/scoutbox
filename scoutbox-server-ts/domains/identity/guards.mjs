/** Request guards other domains' guardian routes share. */

/** The guardian's own child, or a 404 that does not say whether the child exists. */
export function ownChild(req, res, findPlayer, id = req.params.id) {
  const child = findPlayer(id);
  if (child && req.guardian.childIds.includes(child.id)) return child;
  res.status(404).json({ error: 'CHILD_NOT_FOUND' });
  return null;
}
