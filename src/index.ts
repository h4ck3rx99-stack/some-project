import { createApp } from './app';
import { appEnv, type Bindings } from './env';
import { emailProvider } from './email';
import { runCron } from './jobs/schedule';
import { runnerDeps } from './routes/helpers';

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext): Promise<void> {
    const e = appEnv(env);
    ctx.waitUntil(runCron(controller.cron, { runner: runnerDeps(env, e), email: emailProvider(e), appUrl: e.APP_URL, captures: env.CAPTURES }));
  },
} satisfies ExportedHandler<Bindings>;
