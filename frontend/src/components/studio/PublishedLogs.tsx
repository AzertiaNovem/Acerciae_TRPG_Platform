import { t as tr } from '../../i18n';
import { useEffect, useState } from "react";
import { useNav } from "../../store/nav";
import { useStudio } from "../../store/studio";
import {
  publicationApi as api,
  type Publication,
  type PdfJob,
} from "./publicationApi";
import { PublicationContent } from "./PublicationViewer";
export default function PublishedLogs() {
  const { channelId: ch, channel } = useNav(),
    { snapshot, presentationId } = useStudio();
  const [items, setItems] = useState<Publication[]>([]),
    [jobs, setJobs] = useState<PdfJob[]>([]),
    [kind, setKind] = useState("styled"),
    [visibility, setVisibility] = useState("players"),
    [pdf, setPdf] = useState(""),
    [title, setTitle] = useState(""),
    [error, setError] = useState(""),
    [share, setShare] = useState(""),
    [selected, setSelected] = useState<Publication | null>(null);
  useEffect(() => {
    let active = true;
    if (ch)
      Promise.all([api.list(ch), api.jobs(ch)])
        .then(([a, b]) => {
          if (active) {
            setItems(a);
            setJobs(b);
          }
        })
        .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [ch]);
  if (!ch) return null;
  const publish = async () => {
    try {
      setError("");
      const p = await api.publish(ch, {
        snapshot_id: snapshot?.id,
        presentation_id: presentationId,
        pdf_job_id: pdf,
        kind,
        visibility,
        title: title || snapshot?.title,
      });
      if (p.share_token)
        setShare(`${location.origin}/?publication=${p.share_token}`);
      setItems(await api.list(ch));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="card">
      <h2>{tr("Published logs")}</h2>
      <p>{tr("Publishing freezes the selected snapshot, performance and approved asset versions. Public links require a public-player snapshot.")}</p>
      {error && <p role="alert">{error}</p>}
      {channel?.my_role === "gm" && (
        <div className="publication-fields">
          <label>{tr("Title")}<input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>{tr("Format")}<select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="styled">{tr("Styled log")}</option>
              <option value="pdf">{tr("PDF")}</option>
              <option value="vn">{tr("Existing visual novel")}</option>
            </select>
          </label>
          <label>{tr("Audience")}<select
              value={visibility}
              onChange={(e) => setVisibility(e.target.value)}
            >
              <option value="players">{tr("Channel players")}</option>
              <option value="gm">{tr("GM only")}</option>
              <option value="link">{tr("Anyone with the link")}</option>
            </select>
          </label>
          {kind === "pdf" && (
            <label>{tr("Completed PDF")}<select value={pdf} onChange={(e) => setPdf(e.target.value)}>
                <option value="">{tr("Choose PDF")}</option>
                {jobs
                  .filter(
                    (j) =>
                      j.status === "completed" &&
                      j.snapshot_id === snapshot?.id,
                  )
                  .map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.template_config.base} · {j.id.slice(0, 8)}
                    </option>
                  ))}
              </select>
            </label>
          )}
          <button
            disabled={
              !snapshot ||
              (kind === "pdf" && !pdf) ||
              (kind === "vn" && !presentationId)
            }
            onClick={publish}
          >{tr("Publish selected snapshot")}</button>
        </div>
      )}
      {share && (
        <p>{tr("Share link:")}{" "}
          <a href={share} target="_blank" rel="noreferrer">
            {share}
          </a>
        </p>
      )}
      {items.map((p) => (
        <div className="row" key={p.id}>
          <span>
            {p.title} · {p.kind} · {p.revoked ? tr("revoked") : p.visibility}
          </span>
          {!p.revoked && (
            <button
              onClick={() =>
                api
                  .get(ch, p.id)
                  .then(setSelected)
                  .catch((e) => setError(e.message))
              }
            >{tr("Open")}</button>
          )}
          {!p.revoked && channel?.my_role === "gm" && (
            <button
              onClick={async () => {
                try {
                  await api.revoke(ch, p.id);
                  setSelected(null);
                  setItems(await api.list(ch));
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >{tr("Revoke")}</button>
          )}
        </div>
      ))}
      {selected && <PublicationContent publication={selected} channelId={ch} />}
    </div>
  );
}
