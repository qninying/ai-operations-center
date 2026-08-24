import "../loadEnv.js";
import { generateTotpSecret, buildOtpAuthUri } from "./totp.js";

// First-time setup for MFA_TOTP_SECRET — not part of the app, run by hand:
//   npm run generate-totp-secret                  (primary approver)
//   npm run generate-totp-secret -- sre-oncall     (a second identity, e.g. the
//                                                    backup approver — labels the
//                                                    authenticator entry correctly
//                                                    instead of showing AUTH_USERNAME)
// Paste the printed secret into mcp-server/.env (MFA_TOTP_SECRET or
// BACKUP_APPROVER_TOTP_SECRET), then enter it (manually, or via the printed
// otpauth:// URI) into an authenticator app once. Mirrors this repo's existing
// ".env.example -> copy -> fill in -> never commit" setup pattern, same as
// hashPassword.ts.

const accountName = process.argv[2] ?? process.env.AUTH_USERNAME ?? "operator";
const secret = generateTotpSecret();
const uri = buildOtpAuthUri(secret, accountName, "CoreOps");

console.log(`MFA_TOTP_SECRET=${secret}`);
console.log("");
console.log("Enter this into your authenticator app (manual entry, or paste this URI):");
console.log(uri);
