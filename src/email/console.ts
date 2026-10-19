import { log } from '../lib/log';
import { maskEmail } from '../lib/crypto';
import type { EmailMessage, EmailProvider } from './provider';

/** In-memory outbox for development and tests (bounded). Never used in production config. */
export const consoleOutbox: EmailMessage[] = [];

export const consoleEmail: EmailProvider = {
  name: 'console',
  async send(msg) {
    consoleOutbox.push(msg);
    if (consoleOutbox.length > 100) consoleOutbox.shift();
    log.info({ msg: 'email (console provider)', to_masked: maskEmail(msg.to), subject: msg.subject });
    // Development convenience: print the text body so magic links can be clicked from the terminal.
    console.log(`\n----- EMAIL to ${msg.to}: ${msg.subject}\n${msg.text}\n-----\n`);
    return { ok: true };
  },
};
