import React, { useState, useMemo, useRef } from "react";
import { parseIngredientsFromExcel, buildRegulanceZip } from "./utils/excelAndZip";

const todayISO = () => new Date().toISOString().slice(0, 10);
const daysAgoISO = (days) => {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
};

export default function App() {
  const [ingredients, setIngredients] = useState([]);
  const [fileName, setFileName] = useState("");
  const [urlsText, setUrlsText] = useState("https://www.ema.europa.eu/en/news\n");
  const [startDate, setStartDate] = useState(daysAgoISO(14));
  const [endDate, setEndDate] = useState(todayISO());
  const [includeUndated, setIncludeUndated] = useState(true);
  const [includeDocs, setIncludeDocs] = useState(true);
  const [model, setModel] = useState("gemini-2.5-flash");

  const [statusMsg, setStatusMsg] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState(null);
  const [zipUrl, setZipUrl] = useState("");

  const zipUrlRef = useRef("");
  zipUrlRef.current = zipUrl;

  const wipeSessionMemory = () => {
    if (zipUrlRef.current) {
      URL.revokeObjectURL(zipUrlRef.current);
    }
    setIngredients([]);
    setFileName("");
    setResults(null);
    setZipUrl("");
    setStatusMsg("");
    setErrorMsg("");
  };

  // Wipe ephemeral session state when user closes or leaves the tab
  useEffect(() => {
    const handleUnload = () => {
      if (zipUrlRef.current) {
        URL.revokeObjectURL(zipUrlRef.current);
      }
    };
    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
    };
  }, []);

  const handleExcelUpload = async (e) => {
    setErrorMsg("");
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const list = await parseIngredientsFromExcel(file);
      if (list.length === 0) {
        setErrorMsg("No active ingredient values found in the first Excel sheet.");
        return;
      }
      setFileName(file.name);
      setIngredients(list);
      setStatusMsg(`Loaded ${list.length} active ingredient(s) in browser memory.`);
    } catch (err) {
      setErrorMsg(`Failed to read Excel file: ${err.message}`);
    }
  };

  const handleRunMonitoring = async () => {
    setErrorMsg("");
    setStatusMsg("");
    if (zipUrl) {
      URL.revokeObjectURL(zipUrl);
      setZipUrl("");
    }

    const urls = urlsText
      .split(/\r?\n/)
      .map((u) => u.trim())
      .filter(Boolean);

    if (ingredients.length === 0) {
      setErrorMsg("Please upload an Excel file containing active ingredients first.");
      return;
    }
    if (urls.length === 0) {
      setErrorMsg("Please enter at least one website or feed URL to monitor.");
      return;
    }
    if (!startDate || !endDate || startDate > endDate) {
      setErrorMsg("Please select a valid date range where Start Date is on or before End Date.");
      return;
    }

    setIsRunning(true);
    try {
      setStatusMsg("Fetching target pages and running Gemini PV assessment...");
      const res = await fetch("/api/monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urls,
          ingredients,
          startDate,
          endDate,
          includeUndated,
          model
        })
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Monitoring request failed.");
      }

      setResults(data);

      const blob = await buildRegulanceZip({
        findings: data.findings || [],
        sourceStatuses: data.sourceStatuses || [],
        ingredients,
        startDate,
        endDate,
        includeDocs,
        onProgress: (msg) => setStatusMsg(msg)
      });

      const objectUrl = URL.createObjectURL(blob);
      setZipUrl(objectUrl);
      setStatusMsg(`Done. Found ${(data.findings || []).length} matching item(s). ZIP ready for download.`);
    } catch (err) {
      setErrorMsg(err.message);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <main style={{ maxWidth: 820, margin: "2rem auto", fontFamily: "system-ui, sans-serif", padding: "0 1rem" }}>
      <h1>Regulance — PV Monitoring Pilot</h1>
      <p style={{ color: "#4b5563" }}>
        Ephemeral browser session: uploaded Excel data, generated Excel/ZIP files, and session state are held in memory and cleared on exit.
      </p>

      <section style={{ marginBottom: "1.25rem" }}>
        <label style={{ fontWeight: 600, display: "block", marginBottom: 6 }}>
          1. Upload Active Ingredients Excel (.xlsx / .csv)
        </label>
        <input type="file" accept=".xlsx,.xls,.csv" onChange={handleExcelUpload} />
        {fileName && (
          <div style={{ marginTop: 6, fontSize: 14 }}>
            <strong>{fileName}</strong> — {ingredients.length} ingredient(s): {ingredients.slice(0, 8).join(", ")}
            {ingredients.length > 8 ? "..." : ""}
          </div>
        )}
      </section>

      <section style={{ marginBottom: "1.25rem" }}>
        <label style={{ fontWeight: 600, display: "block", marginBottom: 6 }}>
          2. Target Websites / Pages / RSS URLs (one per line)
        </label>
        <textarea
          rows={4}
          style={{ width: "100%", padding: 8, fontFamily: "monospace" }}
          value={urlsText}
          onChange={(e) => setUrlsText(e.target.value)}
          placeholder="https://www.ema.europa.eu/en/news"
        />
      </section>

      <section style={{ display: "flex", gap: "1rem", flexWrap: "wrap", marginBottom: "1.25rem" }}>
        <div>
          <label style={{ fontWeight: 600, display: "block", marginBottom: 4 }}>3. Start Date</label>
          <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
        </div>
        <div>
          <label style={{ fontWeight: 600, display: "block", marginBottom: 4 }}>End Date</label>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
        </div>
        <div>
          <label style={{ fontWeight: 600, display: "block", marginBottom: 4 }}>AI Model (Free Tier)</label>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="gemini-2.5-flash">Gemini 2.5 Flash (Recommended)</option>
            <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite (Fastest)</option>
            <option value="gemini-2.5-pro">Gemini 2.5 Pro (Detailed)</option>
          </select>
        </div>
      </section>

      <section style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", marginBottom: "1.25rem" }}>
        <label>
          <input
            type="checkbox"
            checked={includeUndated}
            onChange={(e) => setIncludeUndated(e.target.checked)}
          />{" "}
          Include undated items for manual review
        </label>
        <label>
          <input
            type="checkbox"
            checked={includeDocs}
            onChange={(e) => setIncludeDocs(e.target.checked)}
          />{" "}
          Bundle linked supporting documents in ZIP
        </label>
      </section>

      <div style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap", marginBottom: "1rem" }}>
        <button onClick={handleRunMonitoring} disabled={isRunning} style={{ padding: "0.6rem 1.2rem", fontWeight: 600 }}>
          {isRunning ? "Running Monitoring..." : "Run Monitoring"}
        </button>

        {zipUrl && (
          <a
            href={zipUrl}
            download={`Regulance_Report_${startDate}_to_${endDate}.zip`}
            style={{ padding: "0.6rem 1.2rem", background: "#111827", color: "#fff", textDecoration: "none", borderRadius: 4 }}
          >
            Download ZIP (Excel + Docs)
          </a>
        )}

        <button type="button" onClick={wipeSessionMemory} style={{ padding: "0.6rem 1rem" }}>
          Clear / Wipe Session Now
        </button>
      </div>

      {errorMsg && <p style={{ color: "#b91c1c", fontWeight: 500 }}>{errorMsg}</p>}
      {statusMsg && <p style={{ color: "#1f2937" }}>{statusMsg}</p>}

      {results && (
        <section style={{ marginTop: "1.5rem" }}>
          <h2>Source Status</h2>
          <ul>
            {(results.sourceStatuses || []).map((s, i) => (
              <li key={i}>
                <code>{s.url}</code> — {s.status}
              </li>
            ))}
          </ul>

          <h2>Screened Findings ({(results.findings || []).length})</h2>
          {(results.findings || []).map((f, idx) => (
            <div key={idx} style={{ border: "1px solid #e5e7eb", borderRadius: 6, padding: "0.75rem", marginBottom: "0.75rem" }}>
              <div>
                <strong>[{f.pvImpactLevel}]</strong> {f.title} ({f.extractedDate} — <em>{f.dateStatus}</em>)
              </div>
              <div style={{ fontSize: 13, color: "#4b5563", margin: "4px 0" }}>
                Ingredients: <strong>{f.matchedIngredients}</strong>
              </div>
              <p style={{ margin: "0.4rem 0" }}>{f.pvSummary}</p>
              <div style={{ fontSize: 13 }}>Action: {f.recommendedAction}</div>
              <a href={f.itemUrl} target="_blank" rel="noreferrer" style={{ fontSize: 13 }}>
                Open Source Link
              </a>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
