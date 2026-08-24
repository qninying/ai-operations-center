import "../loadEnv.js";
import { generateTotpCode } from "./totp.js";

// Non-interactive login support for .claude/skills/demo-start/SKILL.md and
// demo-stop/SKILL.md, which curl POST /api/login without a human present to read
// an authenticator app. Same trust category as the plaintext AUTH_PASSWORD already
// in .env for this exact purpose — whoever has filesystem access to .env already
// holds the raw TOTP secret. Prints only the current code, nothing else, so it's
// safe to capture directly: TOTP_CODE=$(npm run current-totp-code --silent)

if (!process.env.MFA_TOTP_SECRET) {
  console.error("MFA_TOTP_SECRET must be set in mcp-server/.env — see .env.example.");
  process.exit(1);
}

console.log(generateTotpCode(process.env.MFA_TOTP_SECRET, Date.now()));
