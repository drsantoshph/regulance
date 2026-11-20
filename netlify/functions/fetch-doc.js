function isSafeExternalUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || "").trim());
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host.endsWith(".local") ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function handler(event) {
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const targetUrl = event.queryStringParameters?.url;
  if (!isSafeExternalUrl(targetUrl)) {
    return { statusCode: 400, body: "Invalid or unsafe document URL." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "RegulancePVPilot/0.1 (+https://example.org; contact@example.org)",
        "Accept": "application/pdf,application/octet-stream,*/*"
      }
    });

    if (!res.ok) {
      return { statusCode: res.status, body: `Upstream document error: HTTP ${res.status}` };
    }

    const contentType = res.headers.get("content-type") || "application/octet-stream";
    const arrayBuffer = await res.arrayBuffer();

    // Guard against huge files in serverless memory (8 MB limit)
    if (arrayBuffer.byteLength > 8 * 1024 * 1024) {
      return { statusCode: 413, body: "Document exceeds 8 MB serverless limit." };
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-store"
      },
      body: Buffer.from(arrayBuffer).toString("base64"),
      isBase64Encoded: true
    };
  } catch (err) {
    return { statusCode: 502, body: `Failed to fetch document: ${err.message}` };
  } finally {
    clearTimeout(timer);
  }
}
