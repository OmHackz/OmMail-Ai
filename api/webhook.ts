import { getApp, handleStartupError } from '../src/server';
import { handleWebhookRequest } from '../src/webhook/handler';

/**
 * DeoMail Fire webhook entry point.
 *
 * POST https://<deployment>.vercel.app/api/webhook
 * POST https://mailbot.omhackz.top/api/webhook
 */
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const app = getApp();
      return await handleWebhookRequest(app, request);
    } catch (error) {
      return handleStartupError(error);
    }
  },
};
