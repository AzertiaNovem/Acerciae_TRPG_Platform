import { t as tr } from '../../i18n';
import PdfPreview from "./PdfPreview";
import { useEffect, useState } from "react";
import { api as coreApi } from "../../api/client";
import { useNav } from "../../store/nav";
import { useStudio } from "../../store/studio";
import {
  publicationApi as api,
  type PdfConfig,
  type PdfJob,
} from "./publicationApi";
export default function PdfTemplateEditor() {
  const { channelId: ch, channel } = useNav();
  const { snapshot } = useStudio();
  const [documents, setDocuments] = useState<
      { id: string; title: string; gm_only: boolean }[]
    >([]),
    [appendices, setAppendices] = useState<string[]>([]);
  const [templates, setTemplates] = useState<
      { id: string; name: string; config: PdfConfig }[]
    >([]),
    [config, setConfig] = useState<PdfConfig | null>(null),
    [jobs, setJobs] = useState<PdfJob[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState("");
  useEffect(() => {
    let active = true;
    if (!ch) return;
    coreApi
      .documents(ch)
      .then((d) => active && setDocuments(d))
      .catch(() => undefined);
    api
      .templates(ch)
      .then((t) => {
        if (active) {
          setTemplates(t);
          setConfig(t.find((x) => x.id === "classic")?.config || t[0]?.config);
        }
      })
      .catch((e) => active && setError(e.message));
    const load = () =>
      api
        .jobs(ch)
        .then((j) => active && setJobs(j))
        .catch((e) => active && setError(e.message));
    load();
    const timer = setInterval(load, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [ch]);
  if (!ch || !config) return <p>{error || tr("Loading PDF templates…")}</p>;
  const patch = (p: Partial<PdfConfig>) => setConfig({ ...config, ...p });
  const submit = async () => {
    if (!snapshot) return;
    setBusy(true);
    setError("");
    try {
      await api.createPdf(ch, snapshot.id, config, appendices);
      setJobs(await api.jobs(ch));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="studio-publishing">
      <div className="card">
        <h2>{tr("PDF publication")}</h2>
        <p>{tr("Choose a snapshot in the library. Preview and download use the same frozen text and visibility scope.")}</p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="publication-fields">
          <label>{tr("Template")}<select
              onChange={(e) =>
                setConfig(
                  templates.find((t) => t.id === e.target.value)!.config,
                )
              }
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          {(["page_size", "orientation", "font", "dice_style"] as const).map(
            (k) => (
              <label key={k}>
                {tr(k.replace(/_/g, " "))}
                <select
                  value={config[k]}
                  onChange={(e) => patch({ [k]: e.target.value })}
                >
                  {{
                    page_size: ["A4", "A5", "B5"],
                    orientation: ["portrait", "landscape"],
                    font: ["serif", "sans"],
                    dice_style: ["box", "inline", "hide"],
                  }[k].map((v) => (
                    <option key={v} value={v}>{tr(v)}</option>
                  ))}
                </select>
              </label>
            ),
          )}
          {(["font_size", "line_height", "margin_mm"] as const).map((k) => (
            <label key={k}>
              {tr(k.replace(/_/g, " "))}
              <input
                type="number"
                step={k === "line_height" ? 0.1 : 1}
                value={config[k]}
                onChange={(e) => patch({ [k]: Number(e.target.value) })}
              />
            </label>
          ))}
          {(
            ["title", "subtitle", "header", "footer", "cover_asset_id"] as const
          ).map((k) => (
            <label key={k}>
              {tr(k.replace(/_/g, " "))}
              <input
                value={config[k]}
                onChange={(e) => patch({ [k]: e.target.value })}
              />
            </label>
          ))}
        </div>
        <div className="row">
          {(
            [
              "include_ooc",
              "timestamps",
              "toc",
              "page_numbers",
              "chapter_breaks",
            ] as const
          ).map((k) => (
            <label key={k}>
              <input
                type="checkbox"
                checked={config[k]}
                onChange={(e) => patch({ [k]: e.target.checked })}
              />
              {tr(k.replace(/_/g, " "))}
            </label>
          ))}
        </div>
        <details>
          <summary>{tr("Character colors and scene illustrations")}</summary>
          <p>{tr("Colors use speaker keys and #RRGGBB values. Illustrations map scene keys to approved image IDs from the asset library.")}</p>
          {(["character_colors", "scene_images"] as const).map((k) => (
            <label key={k}>
              {k}
              <textarea
                defaultValue={JSON.stringify(config[k], null, 2)}
                onBlur={(e) => {
                  try {
                    patch({ [k]: JSON.parse(e.target.value) });
                    setError("");
                  } catch {
                    setError("Enter a valid JSON object.");
                  }
                }}
              />
            </label>
          ))}
        </details>
        <fieldset>
          <legend>{tr("Optional document appendices")}</legend>
          <p className="tiny muted">{tr("Only confirmed or resolved entries visible to this snapshot's audience are included, with source references.")}</p>
          {documents
            .filter((d) => snapshot?.scope === "gm_full" || !d.gm_only)
            .map((d) => (
              <label key={d.id}>
                <input
                  type="checkbox"
                  checked={appendices.includes(d.id)}
                  onChange={(e) =>
                    setAppendices(
                      e.target.checked
                        ? [...appendices, d.id]
                        : appendices.filter((x) => x !== d.id),
                    )
                  }
                />
                {d.title}{" "}
              </label>
            ))}
        </fieldset>
        <div className="row">
          <button disabled={!snapshot || busy} onClick={submit}>
            {busy ? tr("Submitting…") : tr("Render PDF")}
          </button>
          {channel?.my_role === "gm" && (
            <button
              onClick={async () => {
                const name = window.prompt("Template name");
                if (name)
                  try {
                    await api.saveTemplate(ch, name, config);
                    setTemplates(await api.templates(ch));
                  } catch (e) {
                    setError((e as Error).message);
                  }
              }}
            >{tr("Save template")}</button>
          )}
        </div>
        {!snapshot && (
          <p className="muted">{tr("Select a snapshot in Library first.")}</p>
        )}
      </div>
      <div className="card">
        <h3>{tr("Render jobs")}</h3>
        {jobs.map((j) => (
          <div className="row" key={j.id}>
            <span>
              {j.template_config.base} · {tr(j.status)}{tr(" · attempt ")}{j.attempts}
            </span>
            {j.status === "completed" && (
              <>
                <button onClick={() => setPreview(api.file(ch, j.id))}>{tr("Preview")}</button>
                <a href={api.file(ch, j.id)} target="_blank" rel="noreferrer">{tr("Download")}</a>
              </>
            )}
            {j.error && <span role="alert">{j.error}</span>}
          </div>
        ))}
        {preview && <PdfPreview url={preview} />}
      </div>
    </div>
  );
}
