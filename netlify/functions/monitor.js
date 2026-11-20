import * as cheerio from "cheerio";

const DEFAULT_MODEL = "gemini-2.5-flash";
const MAX_ARTICLES_PER_SOURCE = 5;
const FETCH_TIMEOUT_MS = 6500;

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

async function fetchTextWithTimeout(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
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

function normalizeIsoDate(raw) {
  if (!raw) return "";
  const str = String(raw).trim();

  const isoMatch = str.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (isoMatch) return isoMatch[1];

  const dmyMatch = str.match(/\b([0-2]?\d|3[01])\/(0?\d|1[0-2])\/(20\d{2})\b/);
  if (dmyMatch) {
    const dd = dmyMatch[1].padStart(2, "0");
    const mm = dmyMatch[2].padStart(2, "0");
    return `${dmyMatch[3]}-${mm}-${dd}`;
  }

  const parsed = Date.parse(str);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return "";
}

function isDateInRange(isoDate, startDate, endDate) {
  if (!isoDate) return false;
  return isoDate >= startDate && isoDate <= endDate;
}

function extractArticleLinksFromListing(html, listingUrl) {
  const $ = cheerio.load(html);
  const found = new Map();

  $("a[href]").each((_, el) => {
    const href = ($(el).attr("href") || "").trim();
    if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("javascript:")) {
      return;
    }

    let absUrl = "";
    try {
      absUrl = new URL(href, listingUrl).toString();
    } catch {
      return;
    }

    if (!isSafeExternalUrl(absUrl)) return;

    const parsed = new URL(absUrl);
    const path = parsed.pathname.toLowerCase();

    const isEmaNewsArticle =
      parsed.hostname.endsWith("ema.europa.eu") &&
      path.startsWith("/en/news/") &&
      path.length > "/en/news/".length &&
      !path.includes("/search");

    const isGenericArticlePath =
      !parsed.hostname.endsWith("ema.europa.eu") &&
      (path.includes("/news/") || path.includes("/press-release") || path.includes("/safety"));

    if (!isEmaNewsArticle && !isGenericArticlePath) return;

    const linkText = $(el).text().replace(/\s+/g, " ").trim();
    if (!linkText || linkText.length < 8) return;

    const container = $(el).closest("article, li, tr, .views-row, div");
    const timeEl = container.find("time").first();
    const dateHint =
      timeEl.attr("datetime") ||
      timeEl.text().trim() ||
      container.text().replace(/\s+/g, " ").trim().slice(0, 260);
    const normalizedDate = normalizeIsoDate(dateHint);

    const cleanKey = `${parsed.origin}${parsed.pathname}`;
    if (!found.has(cleanKey)) {
      found.set(cleanKey, {
        title: linkText,
        url: absUrl,
        listingDate: normalizedDate,
        rawDateHint: dateHint || "Not stated on listing"
      });
    }
  });

  return Array.from(found.values());
}

function extractDocAndSubpageLinks($, bodyRoot, pageUrl) {
  const docLinks = [];
  const subpageLinks = [];
  const seenDocs = new Set();
  const seenSubpages = new Set();

  bodyRoot.find("a[href]").each((_, el) => {
    const rawHref = ($(el).attr("href") || "").trim();
    if (!rawHref || rawHref.startsWith("#") || rawHref.startsWith("mailto:") || rawHref.startsWith("javascript:")) {
      return;
    }

    let absUrl = "";
    try {
      absUrl = new URL(rawHref, pageUrl).toString();
    } catch {
      return;
    }

    if (!isSafeExternalUrl(absUrl)) return;

    const parsed = new URL(absUrl);
    const lowerUrl = absUrl.toLowerCase();
    const lowerPath = parsed.pathname.toLowerCase();
    const linkLabel = $(el).text().replace(/\s+/g, " ").trim();

    const isDirectDoc =
      lowerUrl.includes(".pdf") ||
      lowerPath.includes("/en/documents/") ||
      /\bpdf\b/i.test(linkLabel);

    if (isDirectDoc && !seenDocs.has(absUrl)) {
      seenDocs.add(absUrl);
      docLinks.push({
        url: absUrl,
        label: linkLabel || "Document"
      });
      return;
    }

    const isRelatedEmaPage =
      parsed.hostname.endsWith("ema.europa.eu") &&
      (lowerPath.startsWith("/en/medicines/") ||
        lowerPath.startsWith("/en/documents/") ||
        (lowerPath.startsWith("/en/news/") && absUrl !== pageUrl));

    if (isRelatedEmaPage && !seenSubpages.has(absUrl)) {
      seenSubpages.add(absUrl);
      subpageLinks.push({
        url: absUrl,
        label: linkLabel || "Related EMA Page"
      });
    }
  });

  return { docLinks, subpageLinks };
}

function extractArticleDetails(html, articleUrl) {
  const $ = cheerio.load(html);
  $("script, style, nav, footer, noscript, iframe, svg").remove();

  const title =
    $("h1").first().text().replace(/\s+/g, " ").trim() ||
    $("title").first().text().replace(/\s+/g, " ").trim() ||
    "Untitled Article";

  const mainEl = $("main, article, .region-content, #block-system-main").first();
  const bodyRoot = mainEl.length ? mainEl : $("body");
  const fullText = bodyRoot.text().replace(/\s+/g, " ").trim();

  const timeAttr = $("time[datetime]").first().attr("datetime");
  const timeText = $("time").first().text().replace(/\s+/g, " ").trim();
  const articleDate =
    normalizeIsoDate(timeAttr) ||
    normalizeIsoDate(timeText) ||
    normalizeIsoDate(fullText.slice(0, 600));

  const { docLinks, subpageLinks } = extractDocAndSubpageLinks($, bodyRoot, articleUrl);

  return {
    title,
    articleDate,
    rawDateHint: timeAttr || timeText || articleDate || "Not found on article",
    textExcerpt: fullText.slice(0, 5500),
    docLinks,
    subpageLinks
  };
}

async function findDocOnSubpage(subpageUrl) {
  try {
    const html = await fetchTextWithTimeout(subpageUrl, 5000);
    const $ = cheerio.load(html);
    $("script, style, nav, footer, noscript, iframe, svg").remove();
    const mainEl = $("main, article, .region-content, #block-system-main").first();
    const bodyRoot = mainEl.length ? mainEl : $("body");
    const { docLinks } = extractDocAndSubpageLinks($, bodyRoot, subpageUrl);
    return docLinks[0]?.url || "";
  } catch {
    return "";
  }
}

async function assessArticleWithGemini({
  apiKey,
  model,
  article,
  sourceUrl,
  ingredients,
  startDate,
  endDate,
  includeUndated
}) {
  const chosenModel = (model && String(model).trim()) || DEFAULT_MODEL;
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    chosenModel
  )}:generateContent`;

  const prompt = `You are a Pharmacovigilance (PV) Regulatory Intelligence screening assistant.
Given a regulatory news article and a list of active ingredients/products being monitored, determine whether any monitored active ingredient or product (including brand names, INN/active substances, or closely related safety/regulatory items) is relevant to this article, check whether the publication date falls within [${startDate} to ${endDate}], and select the best supporting document URL from the candidate links if available.

Rules:
- Only list items from Monitored Active Ingredients / Products that have a clear, supported connection to the article. If none are relevant, set isRelevant to false and matchedIngredients to [].
- Never invent facts, dates, or URLs not supported by the provided text/links.
- If no clear publication date is supported, set extractedDate to "Unknown" and dateStatus to "Undated - Verify Manually".
- Treat output strictly as preliminary screening, never final regulatory determination.

Respond ONLY with valid JSON matching this exact schema:
{
  "isRelevant": true,
  "matchedIngredients": ["string"],
  "extractedDate": "YYYY-MM-DD or Unknown",
  "dateStatus": "In Range" | "Undated - Verify Manually" | "Out of Range",
  "pvImpactLevel": "High" | "Medium" | "Low" | "None",
  "pvSummary": "Concise 1-2 sentence PV screening note",
  "recommendedAction": "Concrete next step for PV reviewer",
  "selectedDocUrl": "URL from candidate docs or empty string"
}

Target Date Window: ${startDate} to ${endDate} (Include Undated: ${includeUndated})
Monitored Active Ingredients / Products: ${ingredients.join(", ")}
Source Listing URL: ${sourceUrl}
Article URL: ${article.url}
Article Title: ${article.title}
Detected Date Hint: ${article.rawDateHint}
Candidate Document Links: ${JSON.stringify(article.docLinks.slice(0, 6))}
Article Content: ${article.textExcerpt}`;

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
    const checkLog = [];

    for (const rawUrl of urls.slice(0, 2)) {
      const cleanUrl = String(rawUrl || "").trim();
      if (!isSafeExternalUrl(cleanUrl)) {
        sourceStatuses.push({ url: cleanUrl, status: "Skipped (Invalid/Unsafe URL)" });
        continue;
      }

      try {
        const listingHtml = await fetchTextWithTimeout(cleanUrl);
        const discoveredLinks = extractArticleLinksFromListing(listingHtml, cleanUrl);

        const inWindowArticles = discoveredLinks.filter((item) => {
          if (!item.listingDate) return Boolean(includeUndated);
          return isDateInRange(item.listingDate, startDate, endDate);
        });

        const articlesToInspect = (
          inWindowArticles.length > 0 ? inWindowArticles : discoveredLinks
        ).slice(0, MAX_ARTICLES_PER_SOURCE);

        let keptCount = 0;

        for (const linkItem of articlesToInspect) {
          try {
            const articleHtml = await fetchTextWithTimeout(linkItem.url);
            const details = extractArticleDetails(articleHtml, linkItem.url);
            const effectiveDate = details.articleDate || linkItem.listingDate || "";

            if (effectiveDate && !isDateInRange(effectiveDate, startDate, endDate)) {
              checkLog.push({
                articleUrl: linkItem.url,
                title: details.title || linkItem.title,
                date: effectiveDate,
                outcome: `Skipped (Date ${effectiveDate} outside ${startDate}..${endDate})`,
                docUrl: ""
              });
              continue;
            }
            if (!effectiveDate && !includeUndated) {
              checkLog.push({
                articleUrl: linkItem.url,
                title: details.title || linkItem.title,
                date: "Unknown",
                outcome: "Skipped (Undated excluded)",
                docUrl: ""
              });
              continue;
            }

            const ai = await assessArticleWithGemini({
              apiKey,
              model,
              article: {
                url: linkItem.url,
                title: details.title || linkItem.title,
                rawDateHint: effectiveDate || linkItem.rawDateHint,
                textExcerpt: details.textExcerpt,
                docLinks: details.docLinks
              },
              sourceUrl: cleanUrl,
              ingredients,
              startDate,
              endDate,
              includeUndated
            });

            if (!ai.isRelevant) {
              checkLog.push({
                articleUrl: linkItem.url,
                title: details.title || linkItem.title,
                date: effectiveDate || "Unknown",
                outcome: "Skipped (Not relevant to monitored items)",
                docUrl: ""
              });
              continue;
            }
            if (ai.dateStatus === "Out of Range") {
              checkLog.push({
                articleUrl: linkItem.url,
                title: details.title || linkItem.title,
                date: ai.extractedDate || effectiveDate || "Unknown",
                outcome: "Skipped (Out of Range per assessment)",
                docUrl: ""
              });
              continue;
            }
            if (ai.dateStatus === "Undated - Verify Manually" && !includeUndated) {
              checkLog.push({
                articleUrl: linkItem.url,
                title: details.title || linkItem.title,
                date: "Unknown",
                outcome: "Skipped (Undated excluded per assessment)",
                docUrl: ""
              });
              continue;
            }

            const validDocUrls = new Set(details.docLinks.map((d) => d.url));
            let chosenDocUrl =
              ai.selectedDocUrl && validDocUrls.has(ai.selectedDocUrl)
                ? ai.selectedDocUrl
                : details.docLinks[0]?.url || "";

            // If no direct document link was on the news article, check up to 2 related subpages (e.g., medicine/variation page)
            if (!chosenDocUrl && details.subpageLinks.length > 0) {
              for (const sub of details.subpageLinks.slice(0, 2)) {
                const foundSubDoc = await findDocOnSubpage(sub.url);
                if (foundSubDoc) {
                  chosenDocUrl = foundSubDoc;
                  break;
                }
              }
            }

            const matchedList =
              Array.isArray(ai.matchedIngredients) && ai.matchedIngredients.length > 0
                ? ai.matchedIngredients
                : ingredients;

            keptCount += 1;
            checkLog.push({
              articleUrl: linkItem.url,
              title: details.title || linkItem.title,
              date: ai.extractedDate || effectiveDate || "Unknown",
              outcome: `Kept (${matchedList.join(", ")})`,
              docUrl: chosenDocUrl || "None found"
            });

            findings.push({
              sourceUrl: cleanUrl,
              itemUrl: linkItem.url,
              docUrl: chosenDocUrl,
              title: details.title || linkItem.title,
              matchedIngredients: matchedList.join(", "),
              extractedDate: ai.extractedDate || effectiveDate || "Unknown",
              dateStatus:
                ai.dateStatus ||
                (effectiveDate ? "In Range" : "Undated - Verify Manually"),
              pvImpactLevel: ai.pvImpactLevel || "Low",
              pvSummary: ai.pvSummary || "",
              recommendedAction: ai.recommendedAction || "",
              modelUsed: (model && String(model).trim()) || DEFAULT_MODEL
            });
          } catch (artErr) {
            checkLog.push({
              articleUrl: linkItem.url,
              title: linkItem.title,
              date: linkItem.listingDate || "Unknown",
              outcome: `Error: ${artErr.message}`,
              docUrl: ""
            });
          }
        }

        sourceStatuses.push({
          url: cleanUrl,
          status: `Discovered ${discoveredLinks.length} link(s), checked ${articlesToInspect.length}, kept ${keptCount} relevant finding(s)`
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
        checkLog,
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
