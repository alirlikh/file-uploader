/*
 * lib/email.ts — Transactional email via Resend (https://resend.com).
 *
 * Free tier: 3,000 emails/month, 100/day. No SMTP config.
 *
 * Env vars:
 *   RESEND_API_KEY  — from resend.com/api-keys
 *   EMAIL_FROM      — e.g. "VaultChunk <noreply@yourdomain.com>"
 *                     Use "onboarding@resend.dev" for testing.
 */

const RESEND_API = "https://api.resend.com/emails";
const API_KEY = process.env.RESEND_API_KEY ?? "";
const FROM = process.env.EMAIL_FROM ?? "VaultChunk <noreply@kiwi-land.eu.cc>";
const APP = "VaultChunk";

export interface SendOtpOptions {
  to: string;
  otp: string;
  name?: string;
  expiresMinutes: number;
  subject?: string; // override subject line (e.g. for payment OTP)
  headline?: string; // override body headline
}

export async function sendOtpEmail(opts: SendOtpOptions): Promise<void> {
  const name = opts.name ?? opts.to.split("@")[0];
  const subject =
    opts.subject ?? `${opts.otp} is your ${APP} verification code`;
  const headline = opts.headline ?? "Verify your email address";
  const bodyNote = opts.headline
    ? "Use the code below to confirm your action. It expires in"
    : "Enter this code to complete your account setup. It expires in";

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<title>${subject}</title></head>
<body style="margin:0;padding:0;background:#0a0b0d;font-family:'IBM Plex Mono',monospace">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0"
  style="max-width:480px;background:#0f1114;border:1px solid #252b33;border-top:3px solid #e8ff47">
<tr><td style="padding:28px 32px 20px">
  <p style="margin:0;font-size:18px;font-weight:700;letter-spacing:.18em;color:#eaf2ff">
    ⬡ VAULTCHUNK
  </p>
</td></tr>
<tr><td style="padding:0 32px 28px">
  <p style="font-size:15px;font-weight:700;color:#eaf2ff;margin:0 0 10px">${headline}</p>
  <p style="font-size:13px;color:#5a6a7a;line-height:1.7;margin:0 0 24px">
    Hi ${name}, ${bodyNote}
    <strong style="color:#c8d4e0">${opts.expiresMinutes} minutes</strong>.
  </p>
  <div style="background:#161a1f;border:1px solid #3a4452;padding:22px;text-align:center;margin-bottom:24px">
    <span style="font-size:38px;font-weight:700;letter-spacing:.35em;color:#e8ff47;font-family:monospace">
      ${opts.otp}
    </span>
  </div>
  <p style="font-size:11px;color:#5a6a7a;line-height:1.7;margin:0">
    Never share this code. If you didn't request it, ignore this email.
  </p>
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #252b33">
  <p style="font-size:10px;color:#5a6a7a;margin:0">
    © ${new Date().getFullYear()} ${APP} · Secure Chunked File Storage
  </p>
</td></tr>
</table>
</td></tr>
</table></body></html>`;

  const text = [
    `Hi ${name},`,
    "",
    `${headline}`,
    "",
    `Your ${APP} verification code: ${opts.otp}`,
    "",
    `Expires in ${opts.expiresMinutes} minutes.`,
    "",
    `If you didn't request this, ignore this email.`,
  ].join("\n");

  const res = await fetch(RESEND_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to: [opts.to], subject, html, text }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${body}`);
  }
}
