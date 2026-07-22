// Full-state JSON backup and restore (plan §3.6). The backup contains
// everything app-created — most importantly the par levels.

const BACKUP_VERSION = 1;

export function exportBackup(state, meta = {}) {
  return JSON.stringify(
    {
      app: "store-reorder",
      version: BACKUP_VERSION,
      exportedAt: meta.exportedAt ?? new Date().toISOString(),
      state,
    },
    null,
    2,
  );
}

// Returns { state } or { error }.
export function importBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: "not a valid JSON file" };
  }
  if (parsed?.app !== "store-reorder") {
    return { error: "not a store-reorder backup file" };
  }
  if (parsed.version !== BACKUP_VERSION) {
    return { error: `unsupported backup version ${parsed.version}` };
  }
  if (typeof parsed.state?.products !== "object" || parsed.state.products === null) {
    return { error: "backup file has no product data" };
  }
  return { state: parsed.state };
}
