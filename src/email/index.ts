import type { AppEnv } from '../env';
import { consoleEmail } from './console';
import type { EmailProvider } from './provider';
import { resendEmail } from './resend';

export function emailProvider(env: AppEnv): EmailProvider {
  if (env.EMAIL_PROVIDER === 'resend' && env.EMAIL_API_KEY)
    return resendEmail(env.EMAIL_API_KEY, env.EMAIL_FROM);
  return consoleEmail;
}
