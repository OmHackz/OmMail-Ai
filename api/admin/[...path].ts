import { handleAdminRequest } from '../../src/admin/router';
import { adminSubPath, getApp, handleStartupError } from '../../src/server';

/**
 * Admin API catch-all: /api/admin/<action>
 *
 *   GET  /api/admin/stats
 *   GET  /api/admin/activity
 *   GET  /api/admin/settings        POST /api/admin/settings
 *   GET  /api/admin/connection
 *   POST /api/admin/test-ai
 *   GET  /api/admin/drafts           POST /api/admin/drafts
 *   GET  /api/admin/drafts/:id
 *   POST /api/admin/drafts/:id/approve
 *   POST /api/admin/drafts/:id/reject
 *   POST /api/admin/drafts/:id/regenerate
 */
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      const app = getApp();
      return await handleAdminRequest(app, request, adminSubPath(request));
    } catch (error) {
      return handleStartupError(error);
    }
  },
};
