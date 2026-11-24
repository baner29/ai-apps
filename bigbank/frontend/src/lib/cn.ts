/**
 * Minimal class-name joiner (clsx-style) used across the UI kit.
 *
 * Accepts strings, numbers, nested arrays, and `{ className: boolean }`
 * objects; falsy values are dropped and the rest are joined with spaces.
 */
export type ClassValue =
  | string
  | number
  | null
  | undefined
  | boolean
  | ClassValue[]
  | { [className: string]: boolean | null | undefined };

function collect(input: ClassValue, out: string[]): void {
  if (!input) return;
  if (typeof input === 'string' || typeof input === 'number') {
    out.push(String(input));
    return;
  }
  if (Array.isArray(input)) {
    for (const item of input) collect(item, out);
    return;
  }
  if (typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      if (value) out.push(key);
    }
  }
}

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  for (const input of inputs) collect(input, out);
  return out.join(' ');
}

export default cn;
