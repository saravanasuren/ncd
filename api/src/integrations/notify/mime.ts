/**
 * Minimal MIME builder for an email with one attachment.
 *
 * SES's `SendEmailCommand` cannot carry a file, so an attachment forces
 * `SendRawEmailCommand`, which wants a complete RFC-5322 message. There is no
 * nodemailer in this project and pulling one in to compose four headers would
 * be the larger change, so this builds the multipart by hand.
 *
 * Two things here are correctness, not decoration:
 *   - the boundary must not occur in any part, so it is random, and
 *   - base64 MUST be wrapped at 76 characters. SMTP has a 998-octet line limit
 *     and a single unwrapped line of a 30 KB workbook would be rejected or
 *     silently mangled by some relays.
 */
import { randomBytes } from 'node:crypto';
import type { Attachment } from './index.js';

/** RFC 2047 encoded-word, so a non-ASCII subject survives the header. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

const wrap76 = (b64: string): string => (b64.match(/.{1,76}/g) ?? []).join('\r\n');

export function buildRawEmail(input: {
  from: string;
  to: string;
  replyTo?: string;
  subject: string;
  text: string;
  html?: string;
  attachment: Attachment;
}): Buffer {
  const boundary = `----ncd_${randomBytes(16).toString('hex')}`;
  const body = input.html
    ? [
        `Content-Type: text/html; charset=UTF-8`,
        `Content-Transfer-Encoding: base64`,
        '',
        wrap76(Buffer.from(input.html, 'utf8').toString('base64')),
      ]
    : [
        `Content-Type: text/plain; charset=UTF-8`,
        `Content-Transfer-Encoding: base64`,
        '',
        wrap76(Buffer.from(input.text, 'utf8').toString('base64')),
      ];

  const lines = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    ...(input.replyTo ? [`Reply-To: ${input.replyTo}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    ...body,
    '',
    `--${boundary}`,
    `Content-Type: ${input.attachment.contentType}; name="${input.attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${input.attachment.filename}"`,
    '',
    wrap76(input.attachment.content.toString('base64')),
    '',
    `--${boundary}--`,
    '',
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}
