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
