import { isEncrypted, decryptField } from './crypto.js';

const sensitiveKeys = new Set([
  'password',
  'token',
  'authorization',
  'jwt',
  'secret',
  'apiKey',
  'api_key',
  'aadhaar',
  'accountNumber'
]);

// Some JSON columns legitimately use property names that collide with
// PII regexes (e.g. the per-section approval map stored on User.sectionStatus
// has a `pan` key whose value is a workflow status like `"approved"` /
// `"rejected"` — not an actual PAN number). Walking those subtrees with the
// masker would corrupt the values (`"approved"` -> `"****OVED"`), which then
// breaks downstream equality checks like `sectionStatus.pan === "approved"`
// on the admin scrutiny screen. Treat the whole subtree as opaque so the
// admin UI sees the persisted status verbatim.
const passthroughKeys = new Set([
  'sectionStatus',
  'sectionRejectionReasons',
  'complianceViolations'
]);

const isWorkflowStatus = (val: unknown): boolean => {
  if (typeof val !== 'string') return false;
  const s = val.trim().toLowerCase();
  return ['approved', 'rejected', 'pending', 'submitted', 'verified', 'incomplete', 'under_review', 'active', 'inactive', 'suspended', 'cancelled'].includes(s);
};

export const maskValue = (value: unknown, visibleSuffix = 4) => {
  const text = String(value ?? '');
  if (text.length <= visibleSuffix) return '*'.repeat(text.length);
  return `${'*'.repeat(Math.max(0, text.length - visibleSuffix))}${text.slice(-visibleSuffix)}`;
};

const compact = (value: unknown) => String(value ?? '').replace(/\s+/g, '').toUpperCase();

export const maskPAN = (value: unknown) => {
  const text = compact(value);
  if (!text) return '';
  return text.length >= 10 ? `${text.slice(0, 2)}***${text.slice(-2)}` : maskValue(text);
};

export const maskGST = (value: unknown) => {
  const text = compact(value);
  if (!text) return '';
  return text.length >= 15 ? `${text.slice(0, 2)}***********${text.slice(-2)}` : maskValue(text);
};

export const maskGSTIN = maskGST;

export const maskAadhaar = (value: unknown) => {
  const text = compact(value);
  return text.length >= 12 ? `XXXXXXXX${text.slice(-4)}` : maskValue(text, 4);
};

export const maskBankAccount = (value: unknown) => maskValue(String(value ?? '').replace(/\s+/g, ''), 4);

export const maskEmail = (value: unknown) => {
  const text = String(value ?? '').trim();
  if (!text || !text.includes('@')) return maskValue(text);
  const [local, domain] = text.split('@');
  const visible = local.length > 2 ? `${local[0]}***${local.slice(-1)}` : `${local[0]}***`;
  return `${visible}@${domain}`;
};

export const maskPhone = (value: unknown) => {
  const text = String(value ?? '').replace(/\s+/g, '');
  if (!text) return '';
  return text.length > 4 ? `${'*'.repeat(text.length - 4)}${text.slice(-4)}` : maskValue(text);
};

export interface MaskSensitiveOptions {
  unmaskForAdmin?: boolean;
  unmaskSelf?: boolean;
  unmaskEmails?: boolean;
}

export const maskSensitive = <T>(input: T, options?: MaskSensitiveOptions): T => {
  const mask = (val: any, stack = new Set<any>()): any => {
    if (!val || typeof val !== 'object') return val;
    if (val instanceof Date) return val;
    if (val.constructor && (val.constructor.name === 'Decimal' || val._isDecimal === true || (typeof val.toNumber === 'function' && typeof val.toFixed === 'function'))) return val;
    
    if (stack.has(val)) return '[Circular]';
    
    const newStack = new Set(stack);
    newStack.add(val);

    if (Array.isArray(val)) return val.map(item => mask(item, newStack));

    const allowUnmaskedPii = Boolean(options?.unmaskForAdmin || options?.unmaskSelf);
    const allowUnmaskedEmails = Boolean(allowUnmaskedPii || options?.unmaskEmails);

    return Object.entries(val).reduce<Record<string, unknown>>((acc, [key, value]) => {
      if (passthroughKeys.has(key)) {
        acc[key] = value;
        return acc;
      }

      let effectiveVal = value;
      if (typeof effectiveVal === 'string' && isEncrypted(effectiveVal)) {
        try {
          effectiveVal = decryptField(effectiveVal);
        } catch {
          // retain encrypted text if key missing or invalid
        }
      }

      if (/^aadhaar|aadhaarNumber$/i.test(key)) {
        acc[key] = effectiveVal ? maskAadhaar(effectiveVal) : effectiveVal;
      } else if (allowUnmaskedPii && /^(pan|panNumber|gst|gstin|gstNumber|nameAsInPan|panName)$/i.test(key)) {
        acc[key] = effectiveVal;
      } else if (options?.unmaskForAdmin && (key !== 'bankAccounts' && /accountNumber|bankAccount|bankAccountNo/i.test(key))) {
        acc[key] = effectiveVal;
      } else if (allowUnmaskedEmails && /(^|_)(email|officialEmail|contactEmail|complainantEmail|contactPersonEmail|verifyingEmail)$/i.test(key)) {
        acc[key] = effectiveVal;
      } else if (allowUnmaskedPii && /(^|_)(phone|mobile|officialPhone|contactPhone|complainantMobile|contactPersonMobile|verifyingMobile|mobileNumber)$/i.test(key)) {
        acc[key] = effectiveVal;
      } else if (key !== 'bankAccounts' && /accountNumber|bankAccount|bankAccountNo/i.test(key)) {
        acc[key] = effectiveVal ? maskBankAccount(effectiveVal) : effectiveVal;
      } else if (/^(pan|panNumber)$/i.test(key)) {
        acc[key] = effectiveVal ? (isWorkflowStatus(effectiveVal) ? effectiveVal : maskPAN(effectiveVal)) : effectiveVal;
      } else if (/^(gst|gstin|gstNumber)$/i.test(key)) {
        acc[key] = effectiveVal ? (isWorkflowStatus(effectiveVal) ? effectiveVal : maskGST(effectiveVal)) : effectiveVal;
      } else if (/(^|_)(email|officialEmail|contactEmail|complainantEmail|contactPersonEmail|verifyingEmail)$/i.test(key)) {
        acc[key] = (typeof effectiveVal === 'string' || typeof effectiveVal === 'number') ? maskEmail(effectiveVal) : (effectiveVal ? mask(effectiveVal, newStack) : effectiveVal);
      } else if (/(^|_)(phone|mobile|officialPhone|contactPhone|complainantMobile|contactPersonMobile|verifyingMobile|mobileNumber)$/i.test(key)) {
        acc[key] = (typeof effectiveVal === 'string' || typeof effectiveVal === 'number') ? maskPhone(effectiveVal) : (effectiveVal ? mask(effectiveVal, newStack) : effectiveVal);
      } else if (sensitiveKeys.has(key) || /password|secret|token|apiKey|api_key/i.test(key)) {
        acc[key] = effectiveVal ? maskValue(effectiveVal) : effectiveVal;
      } else {
        acc[key] = mask(effectiveVal, newStack);
      }
      return acc;
    }, {});
  };

  return mask(input) as T;
};
