import type { VercelRequest, VercelResponse } from "@vercel/node";

/**
 * CORS Proxy for isomorphic-git
 *
 * isomorphic-git calls: /api/proxy?url=https://github.com/...
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, Git-Protocol, Accept",
    );
    res.status(200).end();
    return;
  }

  // Get URL from query parameter
  const { url } = req.query;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Missing url query parameter" });
    return;
  }

  // Only allow GitHub URLs for security
  const allowedHosts = ["github.com", "raw.githubusercontent.com"];
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    res.status(400).json({ error: "Invalid URL" });
    return;
  }

  if (!allowedHosts.some((host) => parsedUrl.hostname.endsWith(host))) {
    res.status(403).json({ error: "Only GitHub URLs are allowed" });
    return;
  }

  try {
    const headers: Record<string, string> = {
      "User-Agent": "git/isomorphic-git",
    };

    // Forward relevant headers
    if (req.headers.authorization) {
      headers["Authorization"] = req.headers.authorization as string;
    }
    if (req.headers["content-type"]) {
      headers["Content-Type"] = req.headers["content-type"] as string;
    }
    if (req.headers["git-protocol"]) {
      headers["Git-Protocol"] = req.headers["git-protocol"] as string;
    }
    if (req.headers.accept) {
      headers["Accept"] = req.headers.accept as string;
    }

    // Get request body for POST requests
    let body: Buffer | undefined;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      body = Buffer.concat(chunks);
    }

    const response = await fetch(url, {
      method: req.method || "GET",
      headers,
      body: body ? new Uint8Array(body) : undefined,
    });

    // Set CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Expose-Headers", "*");

    // Forward response headers (except ones that cause issues)
    const skipHeaders = [
      "content-encoding",
      "transfer-encoding",
      "connection",
      "www-authenticate", // IMPORTANT: Strip this to prevent browser's native auth popup!
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
    console.error("Proxy error:", error);
    res
      .status(500)
      .json({ error: "Proxy request failed", details: String(error) });
  }
}
