import * as XLSX from "xlsx";
import JSZip from "jszip";

export async function parseIngredientsFromExcel(file) {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });

  const ingredients = new Set();
  for (const row of rows) {
    for (const cell of row || []) {
      const val = String(cell || "").trim();
      if (!val) continue;
      if (/^(active\s*ingredient|ingredient|substance|inn|drug|medicine)s?$/i.test(val)) {
        continue;
      }
      ingredients.add(val);
    }
  }
  return Array.from(ingredients);
}

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 70);
}

export async function buildRegulanceZip({
  findings,
  sourceStatuses,
  ingredients,
  startDate,
  endDate,
  includeDocs = true,
  onProgress = () => {}
}) {
  const zip = new JSZip();
  const docsFolder = zip.folder("supporting_documents");
  const enrichedRows = [];

  if (includeDocs) {
    let idx = 1;
    for (const item of findings) {
      let bundledFileName = "Not Bundled";
      if (item.docUrl) {
        onProgress(`Fetching supporting document ${idx} of ${findings.length}...`);
        try {
          const resp = await fetch(`/api/fetch-doc?url=${encodeURIComponent(item.docUrl)}`);
          if (resp.ok) {
            const blob = await resp.blob();
            const ext = item.docUrl.toLowerCase().includes(".pdf") ? ".pdf" : "";
            const fileName = `${String(idx).padStart(2, "0")}_${sanitizeFilename(item.matchedIngredients)}_${sanitizeFilename(item.title)}${ext}`;
            docsFolder.file(fileName, blob);
            bundledFileName = `supporting_documents/${fileName}`;
          } else {
            bundledFileName = `Link Only (HTTP ${resp.status})`;
          }
        } catch {
          bundledFileName = "Link Only (Fetch Failed)";
        }
      }
      enrichedRows.push({ ...item, bundledFileName });
      idx += 1;
    }
  } else {
    for (const item of findings) {
      enrichedRows.push({ ...item, bundledFileName: "Skipped (Report-Only Mode)" });
    }
  }

  onProgress("Generating Excel report...");
  const wb = XLSX.utils.book_new();

  // Sheet 1: Summary
  const summaryData = [
    ["Metric", "Value"],
    ["Monitoring Start Date", startDate],
    ["Monitoring End Date", endDate],
    ["Active Ingredients Screened", ingredients.length],
    ["Matched & Retained Findings", enrichedRows.length],
    ["Generated At (UTC)", new Date().toISOString()],
    ["Disclaimer", "Preliminary AI screening pilot only. Verify against primary regulatory sources."]
  ];
  const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
  XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");

  // Sheet 2: Findings
  const findingsSheetData = enrichedRows.map((r) => ({
    "Matched Active Ingredient(s)": r.matchedIngredients,
    "Extracted Date": r.extractedDate,
    "Date Status": r.dateStatus,
    "PV Impact Level": r.pvImpactLevel,
    "Publication / Item Title": r.title,
    "AI PV Screening Summary": r.pvSummary,
    "Recommended Next Step": r.recommendedAction,
    "Item URL": r.itemUrl,
    "Supporting Doc URL": r.docUrl || "N/A",
    "Bundled File": r.bundledFileName,
    "Source Page": r.sourceUrl,
    "Model Used": r.modelUsed
  }));
  const wsFindings = XLSX.utils.json_to_sheet(
    findingsSheetData.length > 0
      ? findingsSheetData
      : [{ Note: "No matching items found in the selected date range." }]
  );
  XLSX.utils.book_append_sheet(wb, wsFindings, "PV_Monitoring_Report");

  // Sheet 3: Source Status Log
  const wsSources = XLSX.utils.json_to_sheet(sourceStatuses);
  XLSX.utils.book_append_sheet(wb, wsSources, "Source_Log");

  const excelArrayBuffer = XLSX.write(wb, { bookType: "xlsx", type: "array" });
  zip.file("Regulance_PV_Report.xlsx", excelArrayBuffer);

  onProgress("Compressing ZIP archive in browser memory...");
  return await zip.generateAsync({ type: "blob" });
}
