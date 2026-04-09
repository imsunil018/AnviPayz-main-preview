function escapeHtml(value) {
    return String(value || '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function createOtpEmail({ otp, heading, intro, purposeLine, subject }) {
    const safeOtp = escapeHtml(otp);
    const safeHeading = escapeHtml(heading);
    const safeIntro = escapeHtml(intro);
    const safePurpose = escapeHtml(purposeLine);
    const preheader = `Your AnviPayz verification code is ${safeOtp}. It expires in 5 minutes.`;

    return {
        subject,
        text: [
            heading,
            '',
            intro,
            `Verification code: ${otp}`,
            'This code expires in 5 minutes.',
            'If you did not request this email, you can ignore it.'
        ].join('\n'),
        html: `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f7fb;font-family:Arial,Helvetica,sans-serif;color:#14213d;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    ${preheader}
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f4f7fb;margin:0;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:620px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:18px;overflow:hidden;">
          <tr>
            <td style="background-color:#0f172a;padding:20px 28px;">
              <div style="font-size:22px;line-height:1.3;font-weight:700;color:#ffffff;">AnviPayz</div>
              <div style="margin-top:4px;font-size:13px;line-height:1.5;color:#cbd5e1;">Secure verification email</div>
            </td>
          </tr>
          <tr>
            <td style="padding:32px 28px 10px 28px;">
              <div style="display:inline-block;padding:6px 12px;border-radius:999px;background-color:#eef2ff;color:#3730a3;font-size:12px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;">Verification code</div>
              <h1 style="margin:18px 0 12px 0;font-size:30px;line-height:1.25;color:#111827;">${safeHeading}</h1>
              <p style="margin:0 0 10px 0;font-size:16px;line-height:1.7;color:#475569;">${safeIntro}</p>
              <p style="margin:0;font-size:15px;line-height:1.7;color:#64748b;">${safePurpose}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 28px 8px 28px;">
              <div style="background-color:#eff6ff;border:1px solid #bfdbfe;border-radius:16px;padding:22px 18px;text-align:center;">
                <div style="font-size:12px;line-height:1.4;color:#1d4ed8;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;">One-time code</div>
                <div style="margin-top:10px;font-size:38px;line-height:1;letter-spacing:10px;font-weight:700;color:#0f172a;">${safeOtp}</div>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:12px 28px 0 28px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:#f8fafc;border-radius:14px;border:1px solid #e2e8f0;">
                <tr>
                  <td style="padding:16px 18px;font-size:14px;line-height:1.7;color:#475569;">
                    <strong style="color:#0f172a;">Important:</strong> This code expires in 5 minutes. Do not share it with anyone.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 28px 30px 28px;">
              <p style="margin:0;font-size:13px;line-height:1.7;color:#64748b;">If you did not request this email, you can safely ignore it.</p>
            </td>
          </tr>
          <tr>
            <td style="border-top:1px solid #e5e7eb;padding:18px 28px 24px 28px;background-color:#fafafa;">
              <div style="font-size:12px;line-height:1.7;color:#94a3b8;">Sent by AnviPayz authentication system.</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`
    };
}

module.exports = {
    createOtpEmail
};
