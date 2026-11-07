// Validators identify a field, not a replacement document. A repair may replace exactly these JSON pointers.
export class JsonFieldError extends Error {
  constructor(path, expected) {
    const paths = Array.isArray(path) ? path : [path];
    super(`${paths.join(', ')}: ${expected}`);
    this.paths = paths;
  }
}

export function applyFieldRepairs(original, patch, allowed) {
  if (!Array.isArray(patch?.repairs) || patch.repairs.length !== allowed.length) throw Error('Return exactly one repair for each requested path');
  const result = structuredClone(original), seen = new Set();
  for (const item of patch.repairs) {
    if (!item || !allowed.includes(item.path) || seen.has(item.path) || !Object.hasOwn(item, 'value') ||
        Object.keys(item).some(k => !['path', 'value'].includes(k))) throw Error('Repair paths must match the requested paths exactly');
    seen.add(item.path);
    const segments = item.path.split('/').slice(1).map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!item.path.startsWith('/') || segments.length === 0 || segments.some(s => ['', '__proto__', 'constructor', 'prototype'].includes(s))) throw Error('Unsafe repair path');
    let target = result;
    for (const key of segments.slice(0, -1)) {
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key)) throw Error('Repair parent does not exist');
      target = target[key];
    }
    const key = segments.at(-1);
    if (!target || typeof target !== 'object' || (Array.isArray(target) && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= target.length))) throw Error('Invalid repair target');
    Object.defineProperty(target, key, { value: item.value, enumerable: true, configurable: true, writable: true });
  }
  if (Object.keys(patch).some(k => k !== 'repairs')) throw Error('Return only the repairs object');
  return result;
}

export function repairInstruction(error) {
  return `Repair only the invalid JSON fields in the last draft. ${error.message}\nAllowed paths: ${JSON.stringify(error.paths)}. Return {"repairs":[{"path":"<exact allowed path>","value":<corrected field value>}]} with exactly one entry per allowed path. Do not return a new document or change any other fields. Keep valid IDs and the rest of the design unchanged.`;
}
