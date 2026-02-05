/**
 * Storage routes aggregator
 * Combines browse, upload, delete, and move routes into a single Hono app
 * with shared auth middleware and body size overrides for upload routes.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Env } from '../../types';
import { authMiddleware, AuthVariables } from '../../middleware/auth';
import browseRoutes from './browse';
import uploadRoutes from './upload';
import deleteRoutes from './delete';
import moveRoutes from './move';
import statsRoutes from './stats';
import downloadRoutes from './download';
import previewRoutes from './preview';
import seedRoutes from './seed';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

// Apply shared auth middleware to all storage routes
app.use('*', authMiddleware);

// Override body size limit for upload routes (global is 64KB in index.ts:112)
app.use('/upload/*', bodyLimit({ maxSize: 100 * 1024 * 1024 })); // 100MB for multipart parts
app.use('/upload', bodyLimit({ maxSize: 10 * 1024 * 1024 }));    // 10MB for simple upload

// Mount sub-routes
app.route('/browse', browseRoutes);     // → GET  /api/storage/browse
app.route('/upload', uploadRoutes);     // → POST /api/storage/upload, /upload/initiate, etc.
app.route('/delete', deleteRoutes);     // → POST /api/storage/delete
app.route('/move', moveRoutes);         // → POST /api/storage/move
app.route('/stats', statsRoutes);       // → GET  /api/storage/stats
app.route('/download', downloadRoutes); // → GET  /api/storage/download
app.route('/preview', previewRoutes);   // → GET  /api/storage/preview
app.route('/seed', seedRoutes);         // → POST /api/storage/seed/getting-started

export default app;
