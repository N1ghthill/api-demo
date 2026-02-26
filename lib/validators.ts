export function sanitizeString(value: unknown, maxLen = 240): string | null {
  const str = String(value ?? "").trim();
  if (!str) return null;
  return str.length > maxLen ? str.slice(0, maxLen) : str;
}

export function onlyDigits(value: unknown): string {
  return String(value ?? "").replace(/\D+/g, "");
}

export function normalizeEmail(value: unknown, maxLen = 180): string | null {
  const email = sanitizeString(value, maxLen);
  if (!email) return null;
  return email.toLowerCase();
}

export function isValidEmail(value: unknown): boolean {
  const email = normalizeEmail(value, 180);
  if (!email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function normalizePhone(value: unknown): string | null {
  const digits = onlyDigits(value);
  if (digits.length < 10 || digits.length > 13) return null;
  return digits;
}

export function normalizeUf(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.length !== 2) return null;
  const normalized = raw.toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return null;
  return normalized;
}

export function normalizeCpf(value: unknown): string | null {
  const cpf = onlyDigits(value);
  if (cpf.length !== 11) return null;
  return cpf;
}

export function isValidCpf(value: unknown): boolean {
  const cpf = normalizeCpf(value);
  if (!cpf) return false;
  if (/^(\d)\1+$/.test(cpf)) return false;

  const calc = (base: string, factor: number): number => {
    let sum = 0;
    for (let i = 0; i < base.length; i++) {
      sum += Number(base[i]) * (factor - i);
    }
    const mod = sum % 11;
    return mod < 2 ? 0 : 11 - mod;
  };

  const d1 = calc(cpf.slice(0, 9), 10);
  const d2 = calc(cpf.slice(0, 10), 11);
  return cpf.endsWith(String(d1) + String(d2));
}
