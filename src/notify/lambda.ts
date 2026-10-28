import { SendEmailCommand, SESv2Client } from "@aws-sdk/client-sesv2";
import { createNotifyHandler } from "./handler";

const ses = new SESv2Client({});

export const handler = createNotifyHandler({
  from: process.env.EMAIL_FROM!,
  sendEmail: async ({ from, to, subject, text }) => {
    await ses.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: { Text: { Data: text, Charset: "UTF-8" } },
          },
        },
      }),
    );
  },
});
