/**
 * APK distribution endpoints.
 *
 * Pattern (reusable across any project that ships an Android app):
 *   - APK files live on disk at APK_DIR (default /opt/{project}/apks).
 *   - Filename convention: `<package-prefix>-v<semver>.apk`
 *     e.g. "kyber-phone-proxy-v3.5.0.apk", "myapp-v1.2.3.apk".
 *   - The "latest" version is the highest semver string among files present.
 *     No DB needed — directory listing IS the source of truth.
 *   - Devices poll GET /api/v1/device/version every N minutes, compare to
 *     their currentVersion, and self-install if newer.
 *
 * Endpoints (all under whatever prefix you mount this plugin at):
 *   GET  /apks/manifest                 → list all available APKs (admin UI)
 *   GET  /apks/:filename                → download a specific APK (public)
 *   GET  /apks/qr/:filename             → returns SVG QR code pointing to download URL
 *   POST /apks/upload                   → upload new APK (admin auth required)
 *   DELETE /apks/:filename              → remove an APK (admin auth required)
 *   GET  /api/v1/device/version         → device-poll endpoint; returns latest + download URL
 *
 * Auth model: list/download/version are PUBLIC (read-only, by design — APK
 * distribution doesn't need auth since the URLs are obscure-but-not-secret
 * and most Android update flows can't easily auth). Upload/delete require
 * the requireAdmin middleware.
 */
import { FastifyPluginAsync } from 'fastify';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { requireAdmin } from '../middleware/authenticate';

const APK_DIR = process.env.APK_DIR ?? '/opt/openrouter/apks';
const APK_FILENAME_PATTERN = /^([a-zA-Z0-9_-]+)-v(\d+\.\d+(?:\.\d+)?)\.apk$/;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? 'https://ai.applehappy.net';

interface ApkInfo {
  filename: string;
  package: string;          // e.g. "kyber-phone-proxy"
  version: string;          // e.g. "3.5.0"
  sizeBytes: number;
  sha256: string;
  uploadedAt: string;       // ISO timestamp from mtime
  downloadUrl: string;      // full public URL
}

/** Cache file metadata to avoid re-hashing on every list request. Key by mtime + size. */
const apkMetaCache = new Map<string, { sha256: string; size: number; mtime: number }>();

async function getApkInfo(filename: string): Promise<ApkInfo | null> {
  const m = filename.match(APK_FILENAME_PATTERN);
  if (!m) return null;
  const [, pkg, version] = m;
  const fullPath = path.join(APK_DIR, filename);
  let stat;
  try {
    stat = await fs.stat(fullPath);
  } catch {
    return null;
  }
  const cacheKey = `${filename}:${stat.mtimeMs}:${stat.size}`;
  let sha256 = apkMetaCache.get(cacheKey)?.sha256;
  if (!sha256) {
    const buf = await fs.readFile(fullPath);
    sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    apkMetaCache.set(cacheKey, { sha256, size: stat.size, mtime: stat.mtimeMs });
  }
  return {
    filename,
    package: pkg,
    version,
    sizeBytes: stat.size,
    sha256,
    uploadedAt: stat.mtime.toISOString(),
    downloadUrl: `${PUBLIC_BASE_URL}/apks/${filename}`,
  };
}

async function listApks(): Promise<ApkInfo[]> {
  let files: string[] = [];
  try {
    files = await fs.readdir(APK_DIR);
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const infos: ApkInfo[] = [];
  for (const f of files) {
    const info = await getApkInfo(f);
    if (info) infos.push(info);
  }
  // Sort by version desc (simple lexicographic on 0-padded segments would be
  // more correct but most semver looks sortable as-is for small projects)
  infos.sort((a, b) => compareSemver(b.version, a.version));
  return infos;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((s) => parseInt(s, 10) || 0);
  const pb = b.split('.').map((s) => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Find the latest APK for a given package prefix, or globally if no prefix. */
async function getLatest(packagePrefix?: string): Promise<ApkInfo | null> {
  const all = await listApks();
  const filtered = packagePrefix
    ? all.filter((a) => a.package === packagePrefix)
    : all;
  return filtered[0] ?? null;
}

const apksRoutes: FastifyPluginAsync = async (server) => {
  // Ensure APK dir exists (idempotent)
  await fs.mkdir(APK_DIR, { recursive: true }).catch(() => {});

  // GET /apks/manifest — list all APKs (public, no auth)
  // Returned shape:
  //   { apks: [ApkInfo, ...], latest: ApkInfo | null }
  server.get('/manifest', async () => {
    const apks = await listApks();
    return { apks, latest: apks[0] ?? null };
  });

  // GET /apks/:filename — serve the actual APK bytes (public download)
  // Streams the file, sets Content-Type for Android, and includes
  // Content-Disposition so browsers download with the right filename.
  server.get<{ Params: { filename: string } }>('/:filename', async (request, reply) => {
    const { filename } = request.params;
    // Path-traversal guard: filename MUST match the pattern (no slashes, no ..)
    if (!APK_FILENAME_PATTERN.test(filename)) {
      return reply.status(400).send({ error: 'invalid apk filename format' });
    }
    const fullPath = path.join(APK_DIR, filename);
    let stat;
    try {
      stat = await fs.stat(fullPath);
    } catch {
      return reply.status(404).send({ error: 'apk not found' });
    }
    const stream = (await import('fs')).createReadStream(fullPath);
    reply.header('Content-Type', 'application/vnd.android.package-archive');
    reply.header('Content-Length', stat.size);
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    return reply.send(stream);
  });

  // GET /api/v1/device/version — device-poll endpoint
  //   Query: ?currentVersion=3.4&package=kyber-phone-proxy
  //   Returns: { latest: ApkInfo | null, hasUpdate: bool, currentVersion: ... }
  //   Used by the Android ApkUpdater class to decide whether to prompt install.
  // Note: this route is registered at /api/v1/device/version by the parent
  // (see index.ts) — kept here so plugin users see the full surface.
  // The actual mounting happens at apks prefix so this is exposed as
  // /apks/device/version when registered with prefix '/apks'.
  server.get<{ Querystring: { currentVersion?: string; package?: string } }>(
    '/device/version',
    async (request) => {
      const { currentVersion = '0.0.0', package: pkg } = request.query;
      const latest = await getLatest(pkg);
      const hasUpdate = !!latest && compareSemver(latest.version, currentVersion) > 0;
      return {
        latest,
        hasUpdate,
        currentVersion,
      };
    },
  );

  // ── ADMIN: upload + delete ────────────────────────────────────────────────
  // Multipart upload of a new APK. Filename must match the pattern.
  // Bridges the existing @fastify/multipart plugin already registered at app level.
  server.post('/upload', { preHandler: requireAdmin }, async (request, reply) => {
    const file = await (request as any).file?.();
    if (!file) {
      return reply.status(400).send({ error: 'no file in multipart body' });
    }
    const filename = file.filename;
    if (!APK_FILENAME_PATTERN.test(filename)) {
      return reply.status(400).send({
        error: `filename must match pattern: <package>-v<version>.apk (got "${filename}")`,
      });
    }
    const dest = path.join(APK_DIR, filename);
    const buf = await file.toBuffer();
    await fs.writeFile(dest, buf);
    apkMetaCache.clear();
    server.log.info({ filename, sizeKB: Math.round(buf.length / 1024) }, 'apk uploaded');
    const info = await getApkInfo(filename);
    return { success: true, apk: info };
  });

  server.delete<{ Params: { filename: string } }>(
    '/:filename',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const { filename } = request.params;
      if (!APK_FILENAME_PATTERN.test(filename)) {
        return reply.status(400).send({ error: 'invalid apk filename format' });
      }
      const fullPath = path.join(APK_DIR, filename);
      try {
        await fs.unlink(fullPath);
        apkMetaCache.clear();
        server.log.info({ filename }, 'apk deleted');
        return { success: true, filename };
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return reply.status(404).send({ error: 'apk not found' });
        }
        throw err;
      }
    },
  );
};

export default apksRoutes;
