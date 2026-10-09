import { database } from "../core/database.mjs";
import { decryptSecret, encryptSecret } from "../core/crypto.mjs";

export function createFlowRepository(getDatabase = database, encrypt = encryptSecret, decrypt = decryptSecret) {
  function db() {
    const connection = getDatabase();
    connection.exec(`CREATE TABLE IF NOT EXISTS flow_connections (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, edition TEXT NOT NULL,
      organization_id TEXT, domain TEXT NOT NULL, token_ciphertext TEXT NOT NULL,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
    connection.exec(`CREATE TABLE IF NOT EXISTS flow_pipeline_cache (
      connection_id INTEGER NOT NULL, query_key TEXT NOT NULL,
      payload_ciphertext TEXT NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(connection_id,query_key),
      FOREIGN KEY(connection_id) REFERENCES flow_connections(id) ON DELETE CASCADE)`);
    return connection;
  }
  const columns = "id,name,edition,organization_id,domain,(token_ciphertext<>'') AS token_saved,created_at,updated_at";
  const dto = (row) => ({ id: Number(row.id), name: row.name, edition: row.edition, organizationId: row.organization_id,
    domain: row.domain, tokenSaved: Boolean(row.token_saved), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) });
  function get(id) {
    const row = db().prepare(`SELECT ${columns} FROM flow_connections WHERE id=?`).get(id);
    return row ? dto(row) : null;
  }
  function atomic(connection, action) {
    connection.exec("BEGIN IMMEDIATE");
    try { const value = action(); connection.exec("COMMIT"); return value; }
    catch (error) { connection.exec("ROLLBACK"); throw error; }
  }
  return {
    list: () => db().prepare(`SELECT ${columns} FROM flow_connections ORDER BY name COLLATE NOCASE`).all().map(dto),
    get,
    save(input) {
      const connection = db();
      return atomic(connection, () => {
      const old = input.id ? connection.prepare("SELECT token_ciphertext,updated_at FROM flow_connections WHERE id=?").get(input.id) : null;
      if (input.id && !old) return null;
      const ciphertext = input.token ? encrypt(input.token) : old?.token_ciphertext;
      if (!ciphertext) return null;
      const now = Math.max(Date.now(), Number(old?.updated_at ?? 0) + 1);
      if (input.id) connection.prepare("DELETE FROM flow_pipeline_cache WHERE connection_id=?").run(input.id);
      if (input.id) connection.prepare("UPDATE flow_connections SET name=?,edition=?,organization_id=?,domain=?,token_ciphertext=?,updated_at=? WHERE id=?")
        .run(input.name, input.edition, input.organizationId, input.domain, ciphertext, now, input.id);
      else input.id = Number(connection.prepare("INSERT INTO flow_connections(name,edition,organization_id,domain,token_ciphertext,created_at,updated_at) VALUES(?,?,?,?,?,?,?)")
        .run(input.name, input.edition, input.organizationId, input.domain, ciphertext, now, now).lastInsertRowid);
      return get(input.id);
      });
    },
    remove(id) {
      const connection = db();
      return atomic(connection, () => {
        connection.prepare("DELETE FROM flow_pipeline_cache WHERE connection_id=?").run(id);
        return Number(connection.prepare("DELETE FROM flow_connections WHERE id=?").run(id).changes) > 0;
      });
    },
    pipelineCache(id, key) {
      const row = db().prepare("SELECT payload_ciphertext,updated_at FROM flow_pipeline_cache WHERE connection_id=? AND query_key=?").get(id, key);
      return row ? { pipelines: JSON.parse(decrypt(row.payload_ciphertext)), updatedAt: Number(row.updated_at) } : { pipelines: [], updatedAt: null };
    },
    savePipelineCache(id, key, pipelines, expectedVersion) {
      db().prepare(`INSERT INTO flow_pipeline_cache(connection_id,query_key,payload_ciphertext,updated_at)
        SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM flow_connections WHERE id=? AND updated_at=?)
        ON CONFLICT(connection_id,query_key) DO UPDATE SET payload_ciphertext=excluded.payload_ciphertext,updated_at=excluded.updated_at`)
        .run(id, key, encrypt(JSON.stringify(pipelines)), Date.now(), id, expectedVersion);
    },
    load(id) {
      const info = get(id);
      if (!info) return null;
      const row = db().prepare("SELECT token_ciphertext FROM flow_connections WHERE id=?").get(id);
      return { info, token: decrypt(row.token_ciphertext) };
    },
  };
}
