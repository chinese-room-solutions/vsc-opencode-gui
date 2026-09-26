// opencode serve protects its whole API with HTTP Basic auth whenever a
// server password is set (OPENCODE_SERVER_PASSWORD — any username, the
// password after the colon). The extension host inherits that env from the
// workspace, so every request it makes to the server carries the header;
// without it each call 401s ("Authentication required").
export function serverAuthHeaders(): Record<string, string> {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  return {
    authorization:
      "Basic " + Buffer.from(`opencode:${password}`).toString("base64"),
  };
}
