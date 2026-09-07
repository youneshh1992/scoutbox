// EN/FR string catalogue (F12D). French strings are MACHINE-TRANSLATED and
// labelled as such in the language picker — no professional review has
// happened, and the original English is always retained here.
// Coverage: app chrome + every M12 screen. Pre-M12 screens remain English;
// extending them is mechanical follow-up work, not a different mechanism.

const en = {
  'nav.feed': 'Home', 'nav.filmroom': 'Film Room', 'nav.search': 'Search', 'nav.shortlist': 'Shortlist',
  'nav.requests': 'Requests', 'nav.messages': 'Messages', 'nav.trials': 'Trials & Reports',
  'nav.fixtures': 'Fixtures', 'nav.ledger': 'Discovery Ledger', 'nav.funnel': 'Funnel',
  'nav.reputation': 'Reputation', 'nav.plan': 'Plan & Compliance',
  'nav.assessments': 'Assessments', 'nav.recruitment': 'Recruitment', 'nav.planner': 'Squad Planner',
  'nav.opportunities': 'Opportunities', 'nav.campaigns': 'Campaigns', 'nav.video': 'Video Workspace',
  'nav.outcomes': 'Outcomes', 'nav.trialdays': 'Trial Days', 'nav.coaches': 'Coaches',
  'nav.opendays': 'Open Days', 'nav.squad': 'Squad & Match Days', 'nav.friendlies': 'Friendlies',
  'common.save': 'Save', 'common.create': 'Create', 'common.submit': 'Submit', 'common.close': 'Close',
  'common.cancel': 'Cancel', 'common.loading': 'Loading…', 'common.none': 'Nothing here yet.',
  'common.reasons': 'Reasons', 'common.deadline': 'Deadline', 'common.status': 'Status',
  'common.language': 'Language', 'common.machineTranslated': 'Français : traduction automatique (non relue par un traducteur professionnel)',
  'assess.new': 'New assessment', 'assess.notObserved': 'Not observed', 'assess.confidence': 'Confidence',
  'assess.submit': 'Submit assessment', 'assess.draft': 'Draft', 'assess.compare': 'Compare scouts',
  'assess.publish': 'Publish feedback to player', 'assess.blindNote': 'Colleagues’ reports stay hidden until you submit your own — independence is enforced by the server.',
  'assess.observedOf': 'observed by', 'assess.recommendation': 'Recommendation',
  'assess.draftSaved': 'Draft saved on this device', 'assess.pendingSync': 'pending sync', 'assess.synced': 'synced',
  'assess.conflict': 'This assessment changed on the server after your offline draft — review before overwriting.',
  'cases.title': 'Recruitment cases', 'cases.newCase': 'Open case', 'cases.stage': 'Stage', 'cases.owner': 'Owner',
  'cases.assign': 'Assign scout', 'cases.decision': 'Record decision', 'cases.approvals': 'Approvals',
  'cases.history': 'History (append-only)', 'cases.staff': 'Staff', 'cases.removeStaff': 'Remove access',
  'cases.restricted': 'Restricted', 'cases.tasks': 'Tasks',
  'planner.title': 'Squad planner', 'planner.formation': 'Formation', 'planner.roles': 'Tactical roles',
  'planner.vacancies': 'Vacancies', 'planner.candidates': 'Candidates', 'planner.met': 'met',
  'planner.notMet': 'not met', 'planner.unknown': 'unknown', 'planner.shadow': 'Shadow squad',
  'planner.noScores': 'Rule-based matching: every verdict names its source. Unknown stays unknown — no invented percentages.',
  'opp.title': 'Opportunities', 'opp.new': 'Publish opportunity', 'opp.applications': 'Applications',
  'opp.outcome': 'Record outcome', 'opp.accept': 'Accept', 'opp.decline': 'Decline', 'opp.close': 'Close opportunity',
  'camp.title': 'Assessment campaigns', 'camp.new': 'Publish campaign', 'camp.queue': 'Human review queue',
  'camp.accept': 'Accept attempt', 'camp.return': 'Return with reasons',
  'camp.fileVsHuman': 'Automated checks look at FILES (is it a video, did it upload). Only a human review validates the drill itself.',
  'video.title': 'Video workspace', 'video.newSegment': 'Mark segment', 'video.playlists': 'Playlists',
  'video.segments': 'Segments', 'video.slow': 'Slow', 'video.from': 'from', 'video.to': 'to',
  'out.title': 'Post-signing outcomes', 'out.report': 'File outcome report', 'out.due': 'due',
  'out.confirmed': 'confirmed', 'out.disputed': 'disputed', 'out.unknown': 'unknown',
  'day.title': 'Trial days', 'day.staff': 'Named staff', 'day.addStaff': 'Add staff member',
  'day.checkin': 'Check in player', 'day.arrival': 'Arrival instructions', 'day.postpone': 'Postpone',
  'day.cancel': 'Cancel trial', 'day.checkPending': 'check pending T&S review',
  'day.gateNote': 'Check-in is blocked until a named staff member has a REVIEWED, unexpired check and the player/guardian has consented.',
  'passport.title': 'Evidence passport', 'passport.corroborate': 'Corroborate', 'passport.dispute': 'Dispute',
  'passport.insufficient': 'Not enough evidence yet — this is stated, never padded.',
};

const fr: typeof en = {
  'nav.feed': 'Accueil', 'nav.filmroom': 'Salle vidéo', 'nav.search': 'Recherche', 'nav.shortlist': 'Présélection',
  'nav.requests': 'Demandes', 'nav.messages': 'Messages', 'nav.trials': 'Essais et rapports',
  'nav.fixtures': 'Rencontres', 'nav.ledger': 'Registre de détection', 'nav.funnel': 'Entonnoir',
  'nav.reputation': 'Réputation', 'nav.plan': 'Offre et conformité',
  'nav.assessments': 'Évaluations', 'nav.recruitment': 'Recrutement', 'nav.planner': 'Effectif',
  'nav.opportunities': 'Opportunités', 'nav.campaigns': 'Campagnes', 'nav.video': 'Atelier vidéo',
  'nav.outcomes': 'Suivi post-signature', 'nav.trialdays': 'Journées d’essai', 'nav.coaches': 'Entraîneurs',
  'nav.opendays': 'Journées portes ouvertes', 'nav.squad': 'Effectif et matchs', 'nav.friendlies': 'Matchs amicaux',
  'common.save': 'Enregistrer', 'common.create': 'Créer', 'common.submit': 'Soumettre', 'common.close': 'Fermer',
  'common.cancel': 'Annuler', 'common.loading': 'Chargement…', 'common.none': 'Rien pour l’instant.',
  'common.reasons': 'Motifs', 'common.deadline': 'Date limite', 'common.status': 'Statut',
  'common.language': 'Langue', 'common.machineTranslated': 'Français : traduction automatique (non relue par un traducteur professionnel)',
  'assess.new': 'Nouvelle évaluation', 'assess.notObserved': 'Non observé', 'assess.confidence': 'Confiance',
  'assess.submit': 'Soumettre l’évaluation', 'assess.draft': 'Brouillon', 'assess.compare': 'Comparer les recruteurs',
  'assess.publish': 'Publier le retour au joueur', 'assess.blindNote': 'Les rapports des collègues restent masqués tant que le vôtre n’est pas soumis — l’indépendance est imposée par le serveur.',
  'assess.observedOf': 'observé par', 'assess.recommendation': 'Recommandation',
  'assess.draftSaved': 'Brouillon enregistré sur cet appareil', 'assess.pendingSync': 'en attente de synchronisation', 'assess.synced': 'synchronisé',
  'assess.conflict': 'Cette évaluation a changé côté serveur après votre brouillon hors ligne — vérifiez avant d’écraser.',
  'cases.title': 'Dossiers de recrutement', 'cases.newCase': 'Ouvrir un dossier', 'cases.stage': 'Étape', 'cases.owner': 'Responsable',
  'cases.assign': 'Assigner un recruteur', 'cases.decision': 'Enregistrer la décision', 'cases.approvals': 'Validations',
  'cases.history': 'Historique (ajout uniquement)', 'cases.staff': 'Personnel', 'cases.removeStaff': 'Retirer l’accès',
  'cases.restricted': 'Restreint', 'cases.tasks': 'Tâches',
  'planner.title': 'Plan d’effectif', 'planner.formation': 'Schéma', 'planner.roles': 'Rôles tactiques',
  'planner.vacancies': 'Postes à pourvoir', 'planner.candidates': 'Candidats', 'planner.met': 'rempli',
  'planner.notMet': 'non rempli', 'planner.unknown': 'inconnu', 'planner.shadow': 'Effectif fantôme',
  'planner.noScores': 'Correspondance par règles : chaque verdict cite sa source. L’inconnu reste inconnu — aucun pourcentage inventé.',
  'opp.title': 'Opportunités', 'opp.new': 'Publier une opportunité', 'opp.applications': 'Candidatures',
  'opp.outcome': 'Enregistrer l’issue', 'opp.accept': 'Accepter', 'opp.decline': 'Refuser', 'opp.close': 'Clore l’opportunité',
  'camp.title': 'Campagnes d’évaluation', 'camp.new': 'Publier une campagne', 'camp.queue': 'File de revue humaine',
  'camp.accept': 'Accepter la tentative', 'camp.return': 'Renvoyer avec motifs',
  'camp.fileVsHuman': 'Les contrôles automatiques portent sur les FICHIERS (vidéo, envoi). Seule une revue humaine valide l’exercice lui-même.',
  'video.title': 'Atelier vidéo', 'video.newSegment': 'Marquer un extrait', 'video.playlists': 'Listes de lecture',
  'video.segments': 'Extraits', 'video.slow': 'Ralenti', 'video.from': 'de', 'video.to': 'à',
  'out.title': 'Suivi post-signature', 'out.report': 'Déposer le rapport de suivi', 'out.due': 'à échéance',
  'out.confirmed': 'confirmé', 'out.disputed': 'contesté', 'out.unknown': 'inconnu',
  'day.title': 'Journées d’essai', 'day.staff': 'Personnel nommé', 'day.addStaff': 'Ajouter un membre',
  'day.checkin': 'Pointer le joueur', 'day.arrival': 'Consignes d’arrivée', 'day.postpone': 'Reporter',
  'day.cancel': 'Annuler l’essai', 'day.checkPending': 'vérification en attente de revue T&S',
  'day.gateNote': 'Le pointage est bloqué tant qu’aucun membre nommé n’a une vérification EXAMINÉE et valide, et sans consentement du joueur/tuteur.',
  'passport.title': 'Passeport de preuves', 'passport.corroborate': 'Corroborer', 'passport.dispute': 'Contester',
  'passport.insufficient': 'Preuves encore insuffisantes — c’est affiché, jamais maquillé.',
};

export type Lang = 'en' | 'fr';
const KEY = 'sb-lang';

export function getLang(): Lang {
  try { return localStorage.getItem(KEY) === 'fr' ? 'fr' : 'en'; } catch { return 'en'; }
}
export function setLang(l: Lang) {
  try { localStorage.setItem(KEY, l); } catch { /* private mode */ }
  window.dispatchEvent(new Event('sb-lang'));
}
export function t(key: keyof typeof en): string {
  return (getLang() === 'fr' ? fr : en)[key] ?? en[key] ?? key;
}
// Locale-aware formatting (dates/numbers follow the chosen language).
export const fmtDate = (ts: number | string) =>
  new Date(ts).toLocaleDateString(getLang() === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
export const fmtDateTime = (ts: number) =>
  new Date(ts).toLocaleString(getLang() === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
