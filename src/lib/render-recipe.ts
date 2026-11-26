export type RenderParams = Record<string, unknown> & { curve: unknown };

export type RenderRecipe = {
  version: 1;
  params: RenderParams;
};

// These values drive only the editor UI or describe a previously saved render.
// Sending them to Sharp makes preview/save payloads depend on editor history
// rather than the actual image recipe.
const UI_ONLY_KEYS = new Set([
  'snapshots',
  'history',
  '_appliedCrop',
  '_appliedLut',
]);

function clone<T>(value: T): T {
  // JSON.stringify(undefined) returns undefined, and JSON.parse(undefined)
  // throws "undefined is not valid JSON". Guard it — a single undefined
  // value in the recipe must not take down the whole render.
  const json = JSON.stringify(value);
  return (json === undefined ? undefined : JSON.parse(json)) as T;
}

/**
 * The single serialized render contract shared by browser preview and save.
 * Keep it JSON-only because it crosses the browser/API boundary.
 */
export function buildRenderRecipe(state: Record<string, unknown>, curve: unknown): RenderRecipe {
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state || {})) {
    if (!UI_ONLY_KEYS.has(key) && value !== undefined) params[key] = clone(value);
  }
  // The curve may be absent (no tone curve in the editor yet). Only include
  // it when there is something to include.
  if (curve !== undefined) params.curve = clone(curve);
  return { version: 1, params: params as RenderParams };
}
