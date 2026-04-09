const { createOtpEmail } = require('../../api/_lib/otp-email');

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || 'anvipayz@gmail.com';
const SENDER_NAME = process.env.BREVO_SENDER_NAME || 'AnviPayz';

async function readBrevoError(response) {
    const rawBody = await response.text();

    try {
        const parsed = JSON.parse(rawBody);
        return parsed.message || parsed.code || rawBody;
    } catch (error) {
        return rawBody;
    }
}

async function sendOtpEmail({ toEmail, otp, subject, heading, intro, purposeLine }) {
    const emailContent = createOtpEmail({
        otp,
        subject,
        heading,
        intro,
        purposeLine
    });

    const response = await fetch(BREVO_API_URL, {
        method: 'POST',
        headers: {
            'api-key': process.env.BREVO_API_KEY,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            sender: {
                email: SENDER_EMAIL,
                name: SENDER_NAME
            },
            replyTo: {
                email: SENDER_EMAIL,
                name: 'AnviPayz Support'
            },
            to: [{ email: toEmail }],
            subject: emailContent.subject,
            htmlContent: emailContent.html,
            textContent: emailContent.text
        })
    });

    if (!response.ok) {
        const errorMessage = await readBrevoError(response);

        if (/sender.+not valid|validate your sender/i.test(errorMessage)) {
            throw new Error(`Brevo sender "${SENDER_EMAIL}" is not validated. Verify this sender or domain in Brevo before sending OTP emails.`);
        }

        throw new Error(errorMessage || 'Failed to send email');
    }

    return { success: true };
}

module.exports = {
    sendOtpEmail
};
