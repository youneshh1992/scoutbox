/** Meaningful visual cues shared by destinations and disclosure rows. */
export function sectionIcon(label: string): string {
  if (/privacy|medical|protect|safety|trust|verified|identity/i.test(label)) return 'shield-check';
  if (/clip|video|footage|box cam/i.test(label)) return 'video';
  if (/goal|focus|fit|target/i.test(label)) return 'target';
  if (/combine|performance|progress|stat|season/i.test(label)) return 'activity';
  if (/training|development|plan|session/i.test(label)) return 'soccer-ball';
  if (/history|recent|timeline|earlier/i.test(label)) return 'history';
  if (/club|squad|agent|representation/i.test(label)) return 'building-2';
  if (/trial|schedule|calendar|attendance/i.test(label)) return 'calendar-days';
  if (/sign|contract|document|evidence|passport/i.test(label)) return 'file-check-2';
  if (/message|contact|feedback|request/i.test(label)) return 'message-circle';
  if (/notification|alert/i.test(label)) return 'bell';
  if (/appearance|theme/i.test(label)) return 'sun';
  if (/language|access/i.test(label)) return 'globe';
  if (/profile|account|you/i.test(label)) return 'user-round';
  if (/achievement|badge/i.test(label)) return 'trophy';
  if (/how|about|help/i.test(label)) return 'circle-help';
  return 'layers';
}
