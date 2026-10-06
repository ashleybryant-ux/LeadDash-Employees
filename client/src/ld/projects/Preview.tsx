import React from "react";
import { trpc } from "@/lib/trpc";
import { ErrorLine } from "../ui";

/**
 * A file preview over the page: images and PDFs as they are; Word,
 * PowerPoint and text as text; spreadsheets and CSVs as a table. Download
 * stays one click away.
 */
export type PreviewFile = { id: number; name: string; url: string; kind: string };

export function FilePreview({ orgId, file, onClose }: { orgId: number; file: PreviewFile; onClose: () => void }) {
  const q = trpc.pj.preview.useQuery({ organizationId: orgId, fileId: file.id });
  const [sheet, setSheet] = React.useState(0);
  React.useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", key, true);
    return () => document.removeEventListener("keydown", key, true);
  }, [onClose]);
  const d = q.data;
  return (
    <div className="gp-modal gp-pvwrap" role="dialog" aria-modal="true" aria-label={file.name} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="gp-mbox gp-pv">
        <div className="ld-between gp-mhead">
          <b className="gp-ell" style={{ fontSize: 15 }}>{file.name}</b>
          <span className="ld-row">
            <a className="ld-btn sm" href={file.url} download={file.name}>Download</a>
            <a className="ld-btn sm" href={file.url} target="_blank" rel="noreferrer noopener">Open in a tab</a>
            <button type="button" className="ld-btn sm" onClick={onClose}>Close</button>
          </span>
        </div>
        <div className="gp-pvbody">
          <ErrorLine error={q.error} />
          {!d && !q.error && <p className="ld-muted" style={{ padding: 20 }}>Loading the preview</p>}
          {d?.kind === "image" && <img className="gp-pvimg" src={d.url} alt={file.name} />}
          {d?.kind === "pdf" && <iframe className="gp-pvpdf" src={d.url} title={file.name} />}
          {d?.kind === "text" && (
            <>
              {d.note && <span className="ld-small ld-muted" style={{ padding: "0 20px" }}>{d.note}</span>}
              <pre className="gp-pvtext">{d.text || "This file has no readable text."}</pre>
            </>
          )}
          {d?.kind === "sheet" && (
            <div className="gp-pvsheet">
              {d.sheets.length > 1 && (
                <div className="gp-ftabs" role="tablist" style={{ padding: "8px 16px 0" }}>
                  {d.sheets.map((s, i) => (
                    <button key={s.name} type="button" role="tab" aria-selected={sheet === i} className={sheet === i ? "on" : ""} onClick={() => setSheet(i)}>{s.name}</button>
                  ))}
                </div>
              )}
              <div className="gp-tablewrap" style={{ padding: "0 16px 16px" }}>
                <table className="gp-table gp-pvtable">
                  <tbody>
                    {(d.sheets[sheet]?.rows ?? []).map((r, i) => (
                      <tr key={i}>
                        {r.map((c, j) => (i === 0 ? <th key={j}>{c}</th> : <td key={j}>{c}</td>))}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(d.sheets[sheet]?.rows.length ?? 0) >= 500 && <span className="ld-small ld-muted">Showing the first 500 rows. Download the file for the rest.</span>}
                {!d.sheets.length && <span className="ld-small ld-muted">This sheet is empty.</span>}
              </div>
            </div>
          )}
          {d?.kind === "none" && <p className="ld-muted" style={{ padding: 20 }}>{d.note}</p>}
        </div>
      </div>
    </div>
  );
}
