import { nextAttemptAt } from "../backoff";
import { config } from "../config";
import * as repo from "../forms/repository";
import { logger } from "../logger";
import { sendEmail } from "../providers/sendgrid";

export type EmailOutcome = "sent" | "retry_scheduled" | "dead_lettered";

/**
 * The outbox relay: drains queued notification emails.
 *
 * This is the second half of the transactional outbox. The first half
 * guaranteed the email was *recorded* atomically with the transform; this half
 * guarantees it eventually *goes out*, retrying through provider outages.
 *
 * The honest guarantee is at-least-once, not exactly-once. If SendGrid accepts
 * the message but the response is lost in transit, we will resend and the team
 * gets a duplicate notification. That is the right trade for an internal alert
 * - a duplicate is noise, a missing one is a form nobody knows about. Against a
 * real provider you would pass an idempotency key to collapse the duplicate.
 */
export const sendPendingEmails = async (limit: number = config.worker.batchSize): Promise<EmailOutcome[]> => {
	const due = await repo.claimDueEmails(limit);
	if (due.length === 0) return [];

	return Promise.all(
		due.map(async (email): Promise<EmailOutcome> => {
			const log = logger.child({ emailId: email.id, formId: email.formId });

			try {
				const response = await sendEmail({
					to: email.toAddress,
					from: email.fromAddress,
					subject: email.subject,
					body: email.body,
				});

				if (response.statusCode === 200) {
					await repo.markEmailSent(email.id, email.formId);
					log.info("notification email sent");
					return "sent";
				}

				return scheduleEmailRetry(email, `provider returned ${response.statusCode}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return scheduleEmailRetry(email, message);
			}
		}),
	);
};

const scheduleEmailRetry = async (
	email: { id: string; formId: string; attempts: number },
	error: string,
): Promise<EmailOutcome> => {
	const log = logger.child({ emailId: email.id, formId: email.formId });
	const attempts = email.attempts + 1;
	const dead = attempts >= config.worker.maxAttempts;

	await repo.rescheduleEmail(email.id, email.formId, {
		attempts,
		nextAttemptAt: dead ? new Date() : nextAttemptAt(attempts),
		error,
		dead,
	});

	if (dead) {
		log.error({ attempts, error }, "notification email dead-lettered");
		return "dead_lettered";
	}

	log.warn({ attempts, error }, "notification email failed - retry scheduled");
	return "retry_scheduled";
};
