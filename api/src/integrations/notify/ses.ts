/**
 * AWS SES email provider (docs/08 §5). Auth rides the EC2 instance role —
 * no SMTP credentials. The sender domain must be verified in SES (it is:
 * the old wealth app sends from the same identity today).
 */
import { config } from '../../config.js';
import type { NotifyProvider } from './index.js';

export function sesProvider(): NotifyProvider {
  return {
    async send(to, subject, body, meta) {
      if (!to) return { ok: false, error: 'no destination' };
      try {
        // Lazy import so dev/test without the SDK/creds never loads it.
        const { SESClient, SendEmailCommand } = await import('@aws-sdk/client-ses');
        const client = new SESClient({ region: config.SES_REGION });
        const out = await client.send(new SendEmailCommand({
          Source: `"${config.NOTIFICATIONS_FROM_NAME}" <${config.NOTIFICATIONS_FROM_EMAIL}>`,
          ReplyToAddresses: [config.NOTIFICATIONS_REPLY_TO],
          Destination: { ToAddresses: [to] },
          Message: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            // Send HTML when the renderer provided it, with `body` as the text
            // fallback; plain text alone otherwise.
            Body: meta?.html
              ? { Html: { Data: meta.html, Charset: 'UTF-8' }, Text: { Data: body, Charset: 'UTF-8' } }
              : { Text: { Data: body, Charset: 'UTF-8' } },
          },
        }));
        return { ok: true, messageId: out.MessageId };
      } catch (e) {
        return { ok: false, error: `ses: ${(e as Error).message}` };
      }
    },
  };
}
