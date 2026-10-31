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
  return JSON.parse(JSON.stringify(value));
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
  params.curve = clone(curve);
  return { version: 1, params: params as RenderParams };
}
