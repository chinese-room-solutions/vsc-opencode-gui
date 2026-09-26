// opencode serve protects its whole API with HTTP Basic auth whenever a
// server password is set (OPENCODE_SERVER_PASSWORD — any username, the
// password after the colon). Two sources, in priority order:
// - the password this extension generated for a server it spawned (v2
//   serves are password-protected BY DEFAULT, so ServerManager always sets
//   one on the child; the child-only env var is invisible to process.env
//   here, hence the explicit thread-through);
// - OPENCODE_SERVER_PASSWORD inherited from the workspace (servers the
//   user started themselves, v1 or v2).
let spawnedPassword: string | undefined;

export function setSpawnedServerPassword(password: string | undefined): void {
  spawnedPassword = password;
}

export function serverAuthHeaders(): Record<string, string> {
  const password = spawnedPassword ?? process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  return {
    authorization:
      "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
  };
}
