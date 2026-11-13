import { handleAdminRequest } from '../../src/admin/router';
import { getApp, handleStartupError } from '../../src/server';

/** Admin dashboard root: overview of settings and usage. */
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const app = getApp();
      return await handleAdminRequest(app, request, '');
    } catch (error) {
      return handleStartupError(error);
    }
  },
};
