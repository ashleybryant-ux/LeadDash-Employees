import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import { ENV } from "./env";

let client: SESClient | null = null;

/**
 * Sends mail through Amazon SES using the server's AWS credentials (the same
 * account and verified leaddash.io domain as LeadDash EHR).
 *
 * Outside production, when SES is not reachable, the message is printed to the
 * server log instead so sign-in can be tested locally.
 */
export async function sendEmail(to: string, subject: string, text: string, html?: string) {
  try {
    client ||= new SESClient({ region: ENV.sesRegion });
    await client.send(
      new SendEmailCommand({
        Source: ENV.emailFrom,
        ReplyToAddresses: ENV.emailReplyTo ? [ENV.emailReplyTo] : undefined,
        Destination: { ToAddresses: [to] },
        Message: {
          Subject: { Data: subject, Charset: "UTF-8" },
          Body: {
            Text: { Data: text, Charset: "UTF-8" },
            ...(html ? { Html: { Data: html, Charset: "UTF-8" } } : {}),
          },
        },
      })
    );
  } catch (err) {
    if (ENV.isProduction) throw err;
    console.log(`[email:dev] SES unavailable (${(err as Error).message}). To: ${to}\nSubject: ${subject}\n${text}`);
  }
}
