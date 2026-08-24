import "../loadEnv.js";
import { generateTotpSecret, buildOtpAuthUri } from "./totp.js";

// First-time setup for MFA_TOTP_SECRET — not part of the app, run by hand:
//   npm run generate-totp-secret
// Paste the printed secret into mcp-server/.env as MFA_TOTP_SECRET, then enter it
// (manually, or via the printed otpauth:// URI) into an authenticator app once.
// Mirrors this repo's existing ".env.example -> copy -> fill in -> never commit"
// setup pattern, same as hashPassword.ts.

const secret = generateTotpSecret();
const uri = buildOtpAuthUri(secret, process.env.AUTH_USERNAME ?? "operator", "CoreOps");

console.log(`MFA_TOTP_SECRET=${secret}`);
console.log("");
console.log("Enter this into your authenticator app (manual entry, or paste this URI):");
console.log(uri);
