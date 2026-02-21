import { VercelRequest, VercelResponse } from '@vercel/node';

function readHeader(req: VercelRequest, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function stripBearer(value: string): string {
  return value.replace(/^Bearer\s+/i, '').trim();
}

function configuredAdminSecret(): string {
  return (process.env.ADMIN_API_KEY || process.env.CRON_SECRET || '').trim();
}

export function isCronRequest(req: VercelRequest): boolean {
  const cronSecret = (process.env.CRON_SECRET || '').trim();
  if (!cronSecret) return false;
  return stripBearer(readHeader(req, 'authorization')) === cronSecret;
}

export function isAdminRequest(req: VercelRequest): boolean {
  const secret = configuredAdminSecret();
  if (!secret) return false;

  const bearerToken = stripBearer(readHeader(req, 'authorization'));
  const headerToken = readHeader(req, 'x-admin-token').trim();
  return bearerToken === secret || headerToken === secret;
}

export function requireAdminAuth(
  req: VercelRequest,
  res: VercelResponse,
  opts: { allowCron?: boolean } = {}
): boolean {
  const secret = configuredAdminSecret();
  if (!secret) {
    res.status(500).json({ error: 'ADMIN_API_KEY (or CRON_SECRET) is not configured' });
    return false;
  }

  if (isAdminRequest(req)) return true;
  if (opts.allowCron && isCronRequest(req)) return true;

  res.status(401).json({ error: 'Unauthorized' });
  return false;
}
