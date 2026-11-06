// A small JSON Schema (draft-07) checker for the keywords docs/settings.schema.json uses: type, enum, const, pattern,
// minLength, minimum, maximum, properties, required, additionalProperties, items, propertyNames, allOf, if/then, not.
// Returns a list of "path: reason" strings (empty: valid). An unknown keyword throws, so the schema cannot grow a
// keyword this checker silently ignores.
const KNOWN = new Set(['$schema', '$id', 'title', 'description', 'type', 'enum', 'const', 'pattern', 'minLength', 'minimum', 'maximum', 'properties', 'required', 'additionalProperties', 'items', 'propertyNames', 'allOf', 'if', 'then', 'not']);

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function validate(schema, value, at = '$') {
  const errors = [];
  for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`json-schema.js does not know the keyword "${k}" (at ${at})`);
  const t = typeOf(value);
  if (schema.type) {
    const ok = schema.type === t || (schema.type === 'number' && t === 'integer');
    if (!ok) return [`${at}: expected ${schema.type}, got ${t}`];
  }
  if (schema.enum && !schema.enum.some((x) => x === value)) errors.push(`${at}: not one of ${schema.enum.join(', ')}`);
  if ('const' in schema && schema.const !== value) errors.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at}: does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above ${schema.maximum}`);
  }
  if (t === 'array' && schema.items) value.forEach((x, i) => errors.push(...validate(schema.items, x, `${at}[${i}]`)));
  if (t === 'object') {
    for (const r of schema.required ?? []) if (!(r in value)) errors.push(`${at}: missing ${r}`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.propertyNames) errors.push(...validate(schema.propertyNames, k, `${at}{${k}}`));
      if (schema.properties && k in schema.properties) errors.push(...validate(schema.properties[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${k}: not allowed`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') errors.push(...validate(schema.additionalProperties, v, `${at}.${k}`));
    }
  }
  for (const sub of schema.allOf ?? []) errors.push(...validate(sub, value, at));
  if (schema.if && validate(schema.if, value, at).length === 0 && schema.then) errors.push(...validate(schema.then, value, at));
  if (schema.not && validate(schema.not, value, at).length === 0) errors.push(`${at}: must not match ${JSON.stringify(schema.not)}`);
  return errors;
}

module.exports = { validate };
