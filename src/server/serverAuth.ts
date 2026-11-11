// opencode serve protects its whole API with HTTP Basic auth whenever a
// server password is set (any username, the password after the colon).
// Sources, in priority order:
// - the password this extension generated for a server it spawned (v2
//   serves are password-protected BY DEFAULT, so ServerManager always sets
//   one on the child, and the child-only env var is invisible to
//   process.env here, hence the explicit thread-through),
// - an inherited password from the workspace (servers the user started
//   themselves): v2 reads OPENCODE_PASSWORD first and still honors the
//   legacy OPENCODE_SERVER_PASSWORD, so probe both in that order.
let spawnedPassword: string | undefined;

export function setSpawnedServerPassword(password: string | undefined): void {
  spawnedPassword = password;
}

export function serverAuthHeaders(): Record<string, string> {
  const password =
    spawnedPassword ??
    process.env.OPENCODE_PASSWORD ??
    process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  return {
    authorization:
      "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
  };
}
