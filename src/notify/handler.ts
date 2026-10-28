import type { AttributeValue } from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from "aws-lambda";
import { log as defaultLog, type Logger } from "../log";
import { emailFor } from "./emails";

export interface OutgoingEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface NotifyDeps {
  /** The sender, in the domain SES has verified. */
  from: string;
  sendEmail: (email: OutgoingEmail) => Promise<void>;
  log?: Logger;
}

const image = (attributes: unknown) =>
  attributes ? unmarshall(attributes as Record<string, AttributeValue>) : undefined;

/**
 * Reads the Users table's stream and sends the account emails. Records are handled in order; on
 * the first failed send it reports that record, so the stream retries from there (and the records
 * after it come again with it), until the retries run out and the batch goes to the failure queue.
 */
export function createNotifyHandler(deps: NotifyDeps) {
  const log = deps.log ?? defaultLog;

  return async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
    for (const record of event.Records) {
      const email = emailFor(image(record.dynamodb?.OldImage), image(record.dynamodb?.NewImage));
      if (!email) continue;
      try {
        await deps.sendEmail({ from: deps.from, to: email.to, subject: email.subject, text: email.text });
        log({ event: "email_sent", kind: email.kind, userId: email.userId });
      } catch (err) {
        // SES names the recipient in some errors; keep the address out of the logs.
        const error = err instanceof Error ? { name: err.name, message: err.message.replaceAll(email.to, "[email]") } : {};
        log({ event: "notify_failed", kind: email.kind, userId: email.userId, error }, "error");
        return { batchItemFailures: [{ itemIdentifier: record.dynamodb?.SequenceNumber ?? "" }] };
      }
    }
    return { batchItemFailures: [] };
  };
}
