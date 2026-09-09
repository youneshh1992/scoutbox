// Player-app EN/FR catalogue for the M12 surfaces (F12D). French is
// machine-translated and labelled as such where the language is chosen;
// the English originals live here permanently. Web builds persist the
// choice; native storage would use AsyncStorage behind the same helper.
const en = {
  passport: 'Evidence passport', addClaim: 'Log a claim', insufficient: 'Not enough evidence yet — that is simply shown, never padded.',
  provenance: 'How each claim was checked — not a rating of your football.',
  board: 'Opportunity board', apply: 'Apply', applied: 'Applied', withdraw: 'Withdraw',
  guardianApplies: 'Applications for under-18s are made by your parent/guardian.',
  campaigns: 'Club assessment campaigns', submitAttempt: 'Submit attempt', recording: 'Recording instructions',
  fileVsHuman: 'Passing the file check is not approval — a coach reviews the drill itself.',
  feedback: 'Published feedback', makeObjective: 'Turn into an objective', objectives: 'Development objectives',
  logProgress: 'Log progress', share: 'Share with club', unshare: 'Stop sharing', reassess: 'Request reassessment',
  trialDay: 'Trial day & safety pack', consent: 'Give event consent', consented: 'Consent given',
  emergency: 'Emergency contact (event staff only)', safetyPack: 'View safety pack',
  squadInvites: 'Squad invitations', accept: 'Accept', decline: 'Decline',
  followUps: 'Placement check-ins', confirm: 'Confirm', dispute: 'Dispute',
  language: 'Language', dataSaver: 'Data saver (tap to load video)', category: 'Competition category',
  captions: 'Captions (WebVTT)', uploadLarge: 'Large upload (resumable)',
  machineNote: 'Français : traduction automatique — non relue par un traducteur professionnel.',
  m13prefs: 'Suitability preferences', m13prefsPrivate: 'Private to you — clubs only ever see verdict summaries you explicitly approve on an application.',
  m13prefsGuardian: 'Managed by your parent/guardian for under-18s.',
  m13commitments: 'Commitments', m13available: 'Available to train', m13travel: 'Travel limit', m13transport: 'Transport',
  m13relocation: 'Relocation', m13expenses: 'Expenses', m13expensesNeeded: 'need covering', m13expensesOk: 'not required',
  m13saveTravel: 'Save travel limit', m13expensesNeedBtn: 'I need expenses covered', m13expensesOkBtn: 'Expenses not needed',
  m13fit: 'Opportunity fit', m13fitNote: 'Compared against YOUR private preferences. Eligibility (age, level, distance) is separate and always applies. No travel times are invented — only distance is shown.',
  m13checkFit: 'Check fit', m13hideFit: 'Hide', m13shareFit: 'Share summary with this club', m13sharedFit: 'Shared — the club sees verdicts only, never your reasons or commitments.',
  m13trn: 'Club transition', m13trnGuardian: 'Transition cases for under-18s are opened and controlled by the parent/guardian.',
  m13trnNote: 'You choose the evidence, you choose each club, you can withdraw at any time. There is no public list and no “released” label.',
  m13trnGrant: 'Share with club', m13trnGranted: 'Shared — expiring and revocable.', m13trnRevoke: 'Withdraw',
  m13trnRevoked: 'withdrawn', m13trnRevokedMsg: 'Access withdrawn. Files a club already downloaded are outside the platform and cannot be remotely erased — they were asked to delete them.',
  m13trnPlace: 'Record placement', m13trnPlaced: 'Placement recorded — the case closes, history stays, your level is unchanged.',
  m13trnPlacedAt: 'Placed at', m13trnOpen: 'Open a transition case', m13trnOpened: 'Case opened — nothing is shared until you add a club.',
  m13trnNeedMedia: 'Add a clip to your profile first — the pack needs at least one item you own.',
  m13rep: 'Representation', m13repConfirm: 'Confirm', m13repConfirmed: 'Confirmed — active from now.',
  m13repWithdraw: 'Withdraw', m13repWithdrawn: 'Withdrawn — their access ends now; the record stays for accountability.',
  m13repDispute: 'Dispute', m13repDisputed: 'Disputed — Trust & Safety will review.', m13repNone: 'No agency has proposed representation.',
  m13exposure: 'Profile exposure', m13expSearches: 'Search appearances', m13expProfiles: 'Profile views', m13expClubs: 'Clubs',
  m13ack: 'Needs your acknowledgement', m13ackBtn: 'Acknowledge',
};
const fr: typeof en = {
  passport: 'Passeport de preuves', addClaim: 'Consigner une donnée', insufficient: 'Preuves encore insuffisantes — c’est affiché tel quel, jamais maquillé.',
  provenance: 'Comment chaque donnée a été vérifiée — pas une note de votre football.',
  board: 'Tableau des opportunités', apply: 'Postuler', applied: 'Candidature envoyée', withdraw: 'Retirer',
  guardianApplies: 'Pour les moins de 18 ans, c’est le parent/tuteur qui postule.',
  campaigns: 'Campagnes d’évaluation des clubs', submitAttempt: 'Soumettre une tentative', recording: 'Consignes de tournage',
  fileVsHuman: 'Réussir le contrôle du fichier n’est pas une validation — un entraîneur examine l’exercice lui-même.',
  feedback: 'Retours publiés', makeObjective: 'Transformer en objectif', objectives: 'Objectifs de développement',
  logProgress: 'Consigner un progrès', share: 'Partager avec le club', unshare: 'Arrêter le partage', reassess: 'Demander une réévaluation',
  trialDay: 'Journée d’essai et dossier sécurité', consent: 'Donner le consentement', consented: 'Consentement donné',
  emergency: 'Contact d’urgence (personnel de l’événement uniquement)', safetyPack: 'Voir le dossier sécurité',
  squadInvites: 'Invitations d’effectif', accept: 'Accepter', decline: 'Refuser',
  followUps: 'Points d’étape post-signature', confirm: 'Confirmer', dispute: 'Contester',
  language: 'Langue', dataSaver: 'Économie de données (toucher pour charger la vidéo)', category: 'Catégorie de compétition',
  captions: 'Sous-titres (WebVTT)', uploadLarge: 'Envoi volumineux (reprise possible)',
  machineNote: 'Français : traduction automatique — non relue par un traducteur professionnel.',
  m13prefs: 'Préférences de compatibilité', m13prefsPrivate: 'Privé — les clubs ne voient que les synthèses de verdicts que vous approuvez explicitement sur une candidature.',
  m13prefsGuardian: 'Géré par le parent/tuteur pour les moins de 18 ans.',
  m13commitments: 'Engagements', m13available: 'Disponible pour s’entraîner', m13travel: 'Limite de trajet', m13transport: 'Transport',
  m13relocation: 'Déménagement', m13expenses: 'Frais', m13expensesNeeded: 'à couvrir', m13expensesOk: 'non requis',
  m13saveTravel: 'Enregistrer la limite', m13expensesNeedBtn: 'J’ai besoin des frais couverts', m13expensesOkBtn: 'Frais non nécessaires',
  m13fit: 'Compatibilité des opportunités', m13fitNote: 'Comparé à VOS préférences privées. L’éligibilité (âge, niveau, distance) est distincte et s’applique toujours. Aucun temps de trajet n’est inventé — seule la distance est affichée.',
  m13checkFit: 'Vérifier', m13hideFit: 'Masquer', m13shareFit: 'Partager la synthèse avec ce club', m13sharedFit: 'Partagé — le club voit les verdicts, jamais vos raisons ni vos engagements.',
  m13trn: 'Transition de club', m13trnGuardian: 'Les dossiers de transition des moins de 18 ans sont ouverts et contrôlés par le parent/tuteur.',
  m13trnNote: 'Vous choisissez les preuves, vous choisissez chaque club, vous pouvez retirer à tout moment. Pas de liste publique, pas d’étiquette « libéré ».',
  m13trnGrant: 'Partager avec un club', m13trnGranted: 'Partagé — limité dans le temps et révocable.', m13trnRevoke: 'Retirer',
  m13trnRevoked: 'retiré', m13trnRevokedMsg: 'Accès retiré. Les fichiers déjà téléchargés par un club sont hors plateforme et ne peuvent pas être effacés à distance — il lui a été demandé de les supprimer.',
  m13trnPlace: 'Enregistrer le placement', m13trnPlaced: 'Placement enregistré — le dossier se ferme, l’historique reste, votre niveau ne change pas.',
  m13trnPlacedAt: 'Placé à', m13trnOpen: 'Ouvrir un dossier de transition', m13trnOpened: 'Dossier ouvert — rien n’est partagé tant que vous n’ajoutez pas de club.',
  m13trnNeedMedia: 'Ajoutez d’abord un extrait à votre profil — le dossier requiert au moins un élément qui vous appartient.',
  m13rep: 'Représentation', m13repConfirm: 'Confirmer', m13repConfirmed: 'Confirmé — actif dès maintenant.',
  m13repWithdraw: 'Retirer', m13repWithdrawn: 'Retiré — leur accès prend fin ; le dossier reste pour la traçabilité.',
  m13repDispute: 'Contester', m13repDisputed: 'Contesté — Trust & Safety examinera.', m13repNone: 'Aucune agence n’a proposé de représentation.',
  m13exposure: 'Exposition du profil', m13expSearches: 'Apparitions en recherche', m13expProfiles: 'Vues du profil', m13expClubs: 'Clubs',
  m13ack: 'Accusé de réception requis', m13ackBtn: 'Accuser réception',
};

export type PLang = 'en' | 'fr';
const KEY = 'sb-player-lang';
let cached: PLang | null = null;
export function getPLang(): PLang {
  if (cached) return cached;
  try { cached = (typeof localStorage !== 'undefined' && localStorage.getItem(KEY)) === 'fr' ? 'fr' : 'en'; } catch { cached = 'en'; }
  return cached ?? 'en';
}
export function setPLang(l: PLang) {
  cached = l;
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(KEY, l); } catch { /* memory only */ }
}
export const pt = (key: keyof typeof en): string => (getPLang() === 'fr' ? fr : en)[key];
export const pFmtDate = (ts: number | string) =>
  new Date(ts).toLocaleDateString(getPLang() === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short' });

// Data-saver preference (F12B): user-controlled video loading.
const DS_KEY = 'sb-data-saver';
export function getDataSaver(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(DS_KEY) === '1'; } catch { return false; }
}
export function setDataSaver(on: boolean) {
  try { if (typeof localStorage !== 'undefined') localStorage.setItem(DS_KEY, on ? '1' : '0'); } catch { /* memory only */ }
}
