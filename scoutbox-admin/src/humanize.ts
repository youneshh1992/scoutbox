// M24F.5 — staff read words, not machine codes. A server reason such as
// DOCUMENT_AUTHENTICITY_UNCONFIRMED reads "Document authenticity unconfirmed";
// a check such as emailDomainAlignment=passed reads "Email domain alignment: passed".
// The code itself stays available as the element's title for anyone who needs it.
export function humanCode(code: string | null | undefined): string {
  if (!code) return '';
  const words = code
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  const out = words.charAt(0).toUpperCase() + words.slice(1);
  // Acronyms keep their capitals ("DNS ownership", not "Dns ownership").
  return out.replace(/\b(dns|idv|fifa|mfa|sso|url|id|fa|dob)\b/gi, (m) => m.toUpperCase());
}

export function humanCheck(key: string, value: string): string {
  const v = humanCode(value);
  return `${humanCode(key)}: ${/^[A-Z]{2}/.test(v) ? v : v.charAt(0).toLowerCase() + v.slice(1)}`;
}
