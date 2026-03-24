import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  getConfiguredGitHostPatterns,
  isGitHostAllowed,
  MAX_PROXY_REQUEST_BODY_BYTES,
} from './proxy-utils';

const readRequestBody = async (req: AsyncIterable<Buffer | string>): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    totalBytes += buffer.byteLength;
    if (totalBytes > MAX_PROXY_REQUEST_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
};

/**
 * CORS Proxy for isomorphic-git
 * 
 * isomorphic-git calls: /api/proxy?url=https://host/group/repo.git
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Git-Protocol, Accept');
    res.status(200).end();
    return;
  }

  // Get URL from query parameter
  const { url } = req.query;
  
  if (!url || typeof url !== 'string') {
    res.status(400).json({ error: 'Missing url query parameter' });
    return;
  }

  // Allow the built-in public hosts plus any self-hosted GitLab domains configured by env.
  const allowedHosts = getConfiguredGitHostPatterns();
  let parsedUrl: URL;
  
  try {
    parsedUrl = new URL(url);
  } catch {
    res.status(400).json({ error: 'Invalid URL' });
    return;
  }
  
  if (!isGitHostAllowed(parsedUrl.hostname, allowedHosts)) {
    res.status(403).json({
      error: `Git host "${parsedUrl.hostname}" is not allowed. Set GITNEXUS_ALLOWED_GIT_HOSTS to add custom GitLab hosts.`,
    });
    return;
  }

  try {
    const headers: Record<string, string> = {
      'User-Agent': 'git/isomorphic-git',
    };
    
    // Forward relevant headers
    if (req.headers.authorization) {
      headers['Authorization'] = req.headers.authorization as string;
    }
    if (req.headers['content-type']) {
      headers['Content-Type'] = req.headers['content-type'] as string;
    }
    if (req.headers['git-protocol']) {
      headers['Git-Protocol'] = req.headers['git-protocol'] as string;
    }
    if (req.headers.accept) {
      headers['Accept'] = req.headers.accept as string;
    }

    // Get request body for POST requests
    let body: Buffer | undefined;
    if (req.method === 'POST') {
      body = await readRequestBody(req);
    }

    const response = await fetch(url, {
      method: req.method || 'GET',
      headers,
      body: body ? new Uint8Array(body) : undefined,
    });

    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', '*');

    // Forward response headers (except ones that cause issues)
    const skipHeaders = [
      'content-encoding', 
      'transfer-encoding', 
      'connection',
      'www-authenticate', // IMPORTANT: Strip this to prevent browser's native auth popup!
    ];
    
    response.headers.forEach((value, key) => {
      if (!skipHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    });

    res.status(response.status);
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
    
  } catch (error) {
    if (error instanceof Error && error.message === 'Request body too large') {
      res.status(413).json({ error: 'Proxy request body exceeds 256 MB limit' });
      return;
    }

    console.error('Proxy error:', error);
    res.status(500).json({ error: 'Proxy request failed', details: String(error) });
  }
}

