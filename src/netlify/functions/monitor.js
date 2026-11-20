import * as cheerio from "cheerio";

const DEFAULT_MODEL = "gemini-2.5-flash"; // Free tier supported model

function isSafeExternalUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl.trim());
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

async function fetchWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "RegulancePVPilot/0.1 (+https://example.org; contact@example.org)",
        "Accept": "text/html,application/xhtml+xml,application/xml,text/xml,*/*;q=0.8"
      }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractCandidates(htmlOrXml, baseUrl, ingredients) {
  const $ = cheerio.load(htmlOrXml, { xmlMode: /<(\?xml|rss|feed)\b/i.test(htmlOrXml) });

  // Remove noisy elements on HTML pages
  $("script, style, nav, footer, noscript, iframe, svg").remove();

  const lowerIngredients = ingredients.map((i) => i.trim().toLowerCase()).filter(Boolean);
  const candidates = [];

  // 1. RSS / Atom <item> or <entry> support
  $("item, entry").each((_, el) => {
    const title = $(el).find("title").first().text().trim();
    const linkRaw =
      $(el).find("link").first().text().trim() ||
      $(el).find("link").first().attr("href") ||
      baseUrl;
    const pubDateRaw =
      $(el).find("pubDate, dc\\:date, updated, published").first().text().trim();
    const desc = $(el).find("description, summary, content").first().text().replace(/\s+/g, " ").trim();
    const combined = `${title} ${desc}`.toLowerCase();

    const matched = lowerIngredients.filter((ing) => combined.includes(ing));
    if (matched.length > 0) {
      let absUrl = baseUrl;
      try { absUrl = new URL(linkRaw, baseUrl).toString(); } catch {}
      candidates.push({
        title: title || "Untitled Feed Item",
        url: absUrl,
        docUrl: absUrl.toLowerCase().endsWith(".pdf") ? absUrl : "",
        rawDateHint: pubDateRaw || "Not stated in feed",
        matchedIngredients: matched,
        excerpt: desc.slice(0, 1200)
      });
    }
  });

  // 2. HTML blocks / paragraphs / table rows fallback if no RSS items matched
  if (candidates.length === 0) {
    $("article, tr, li, p, .views-row").each((_, el) => {
      const text = $(el).text().replace(/\s+/g, " ").trim();
      if (text.length < 25 || text.length > 3000) return;
      const lower = text.toLowerCase();
      const matched = lowerIngredients.filter((ing) => lower.includes(ing));
      if (matched.length === 0) return;

      const linkEl = $(el).find("a[href]").first();
      const href = linkEl.attr("href");
      let itemUrl = baseUrl;
      if (href) {
        try { itemUrl = new URL(href, baseUrl).toString(); } catch {}
      }

      const docLinkEl = $(el).find('a[href$=".pdf"], a[href*=".pdf"]').first();
      let docUrl = "";
      if (docLinkEl.length && docLinkEl.attr("href")) {
        try { docUrl = new URL(docLinkEl.attr("href"), baseUrl).toString(); } catch {}
      }

      const timeAttr = $(el).find("time[datetime]").first().attr("datetime");
      const timeText = $(el).find("time").first().text().trim();

      candidates.push({
        title: linkEl.text().trim() || text.slice(0, 90),
        url: itemUrl,
        docUrl,
        rawDateHint: timeAttr || timeText || "Not explicitly tagged",
        matchedIngredients: matched,
        excerpt: text.slice(0, 1200)
      });
    });
  }

  // Deduplicate by title + url and cap per source URL to protect free-tier rate limits
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const key = `${c.title}::${c.url}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(c);
    }
    if (unique.length >= 12) break;
  }
  return unique;
}

async function assessWithGemini({ apiKey, model, candidate, startDate, endDate, includeUndated }) {
  const chosenModel = model || DEFAULT_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chosenModel)}:generateContent`;

  const prompt = `You are a Pharmacovigilance Regulatory Intelligence screening assistant.
Evaluate whether this candidate web item falls within the requested date window [${startDate} to ${endDate}] and summarize its potential PV relevance for the matched active ingredient(s).

Rules:
- Never invent facts or dates not supported by the text.
- If no date is clear, set extractedDate to "Unknown" and dateStatus to "Undated - Verify Manually".
- Treat output strictly as preliminary screening, never final regulatory determination.

Respond ONLY with a valid JSON object matching this exact schema:
{
  "extractedDate": "YYYY-MM-DD or Unknown",
  "dateStatus": "In Range" | "Undated - Verify Manually" | "Out of Range",
  "pvImpactLevel": "High" | "Medium" | "Low" | "None",
  "pvSummary": "Concise 1-2 sentence PV screening note",
  "recommendedAction": "Concrete next step for PV reviewer"
}

Target Date Window: ${startDate} to ${endDate} (Include Undated: ${includeUndated})
Matched Active Ingredients: ${candidate.matchedIngredients.join(", ")}
Source URL: ${candidate.url}
Title: ${candidate.title}
Date Hint: ${candidate.rawDateHint}
Excerpt: ${candidate.excerpt}`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json"
      }
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return JSON.parse(rawText);
}

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method Not Allowed" }) };
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Missing GEMINI_API_KEY in Netlify environment variables." })
    };
  }

  try {
    const {
      urls = [],
      ingredients = [],
      startDate,
      endDate,
      includeUndated = true,
      model = DEFAULT_MODEL
    } = JSON.parse(event.body || "{}");

    if (!Array.isArray(urls) || urls.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Provide at least one target URL." }) };
    }
    if (!Array.isArray(ingredients) || ingredients.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "Upload an Excel sheet with active ingredients." }) };
    }
    if (!startDate || !endDate || startDate > endDate) {
      return { statusCode: 400, body: JSON.stringify({ error: "Provide a valid startDate <= endDate." }) };
    }

    const findings = [];
    const sourceStatuses = [];

    for (const rawUrl of urls.slice(0, 8)) {
      const cleanUrl = String(rawUrl || "").trim();
      if (!isSafeExternalUrl(cleanUrl)) {
        sourceStatuses.push({ url: cleanUrl, status: "Skipped (Invalid/Unsafe URL)" });
        continue;
      }

      try {
        const html = await fetchWithTimeout(cleanUrl);
        const candidates = extractCandidates(html, cleanUrl, ingredients);

        let keptCount = 0;
        for (const cand of candidates.slice(0, 6)) {
          const ai = await assessWithGemini({
            apiKey,
            model,
            candidate: cand,
            startDate,
            endDate,
            includeUndated
          });

          if (ai.dateStatus === "Out of Range") continue;
          if (ai.dateStatus === "Undated - Verify Manually" && !includeUndated) continue;

          keptCount += 1;
          findings.push({
            sourceUrl: cleanUrl,
            itemUrl: cand.url,
            docUrl: cand.docUrl || "",
            title: cand.title,
            matchedIngredients: cand.matchedIngredients.join(", "),
            extractedDate: ai.extractedDate || "Unknown",
            dateStatus: ai.dateStatus || "Undated - Verify Manually",
            pvImpactLevel: ai.pvImpactLevel || "Low",
            pvSummary: ai.pvSummary || "",
            recommendedAction: ai.recommendedAction || "",
            modelUsed: model
          });
        }

        sourceStatuses.push({
          url: cleanUrl,
          status: `Fetched (${keptCount} relevant item${keptCount === 1 ? "" : "s"})`
        });
      } catch (err) {
        sourceStatuses.push({
          url: cleanUrl,
          status: `Error: ${err.message}`
        });
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        findings,
        sourceStatuses,
        assessedAt: new Date().toISOString()
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || "Unexpected monitoring error." })
    };
  }
}
