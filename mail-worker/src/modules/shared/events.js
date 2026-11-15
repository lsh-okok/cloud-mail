// Call within the same database transaction as the configuration change.
export function recordFeatureChange(db, { objectType, objectId, revision, payload }) {
  return Number(db.prepare(`INSERT INTO sync_event
    (object_type, object_id, revision, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(objectType, String(objectId), revision, JSON.stringify(payload), Date.now()).lastInsertRowid);
}
