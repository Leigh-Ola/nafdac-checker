export const NAPAMS = 'https://registration.nafdac.gov.ng/';
export const normalizeNumber = value => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

export function cleanNumber(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[–—−]/g, '-');
}

export function validNumber(value) {
  return /^[A-Z0-9][A-Z0-9\s/-]{1,39}$/.test(value);
}

// Some official names already end in several copies of their registration
// number. Collapse that trailing run only; do not append or alter name content.
export function normalizeProductName(value, number) {
  const name = String(value ?? '').trim();
  let remaining = name, copies = 0;
  for (;;) {
    const suffix = remaining.match(/\s*\(([^()]*)\)\s*$/);
    if (!suffix || !/^[A-Z0-9\s/-]+$/i.test(suffix[1]) ||
        normalizeNumber(suffix[1]) !== normalizeNumber(number)) break;
    copies++;
    remaining = remaining.slice(0, suffix.index).trimEnd();
  }
  return copies > 1 ? remaining + ' (' + cleanNumber(number) + ')' : name;
}

export class LookupError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Parse only the official result dialog. Never infer a negative result from an
// empty page, CAPTCHA rejection, HTTP error, timeout or changed page structure.
export function parseNapamsResult(text, number, checkedAt = new Date().toISOString()) {
  text = String(text ?? '').replace(/\r/g, '').trim();
  if (/captcha|verification required|verify you are human/i.test(text)) {
    throw new LookupError('verification_required', 'NAFDAC requires an interactive verification. This check is incomplete.');
  }
  if (/^Product not found!{0,2}$/i.test(text)) {
    return { state: 'not_found', source: 'NAPAMS', sourceUrl: NAPAMS, checkedAt, record: null };
  }
  const fields = {};
  for (const line of text.split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0) fields[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  if (!/Success,\s*Product found/i.test(text) || !fields['product name'] ||
      !fields['nafdac no'] || normalizeNumber(fields['nafdac no']) !== normalizeNumber(number)) {
    throw new LookupError('unexpected_response', 'NAFDAC returned an unrecognised result. This check is incomplete.');
  }
  return {
    state: 'found', source: 'NAPAMS', sourceUrl: NAPAMS, checkedAt,
    record: {
      source: 'NAPAMS', source_url: NAPAMS, checked_at: checkedAt,
      product_name: normalizeProductName(fields['product name'], fields['nafdac no']), NAFDAC: fields['nafdac no'],
      category: fields['product category'] || '', product_source: fields['product source'] || '',
      manufacturer_name: fields.manufacturer || '',
      approval_date: fields['date approved'] || '', expiry_date: fields['expiry date'] || '',
      ingredient_name: fields['active ingredient'] || '',
      // This page provides dates but no separate Active/Inactive status.
      status: null
    }
  };
}
