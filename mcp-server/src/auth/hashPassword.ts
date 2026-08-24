import { hashPassword } from "./credentials.js";

// First-time setup for AUTH_PASSWORD_HASH — not part of the app, run by hand:
//   npm run hash-password -- 'my-new-password'
// Paste the printed value into mcp-server/.env as AUTH_PASSWORD_HASH. Mirrors this
// repo's existing ".env.example -> copy -> fill in -> never commit" setup pattern.

const password = process.argv[2];
if (!password) {
  console.error("Usage: npm run hash-password -- '<password>'");
  process.exit(1);
}

console.log(hashPassword(password));
