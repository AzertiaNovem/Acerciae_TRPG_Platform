import { useEffect, useState } from "react";
import { api, request } from "../../api/client";
import { useNav } from "../../store/nav";
import { useStudio } from "../../store/studio";
import { studioPath } from "./publicationApi";
export default function CreativePanel({ onChange }: { onChange: () => void }) {
  const { channelId: ch, characters } = useNav(),
    { snapshot, presentationId } = useStudio();
  const [status, setStatus] = useState<any>(null),
    [styles, setStyles] = useState<any[]>([]),
    [style, setStyle] = useState(""),
    [kind, setKind] = useState("background"),
    [character, setCharacter] = useState(""),
    [description, setDescription] = useState(""),
    [prompt, setPrompt] = useState(""),
    [cloud, setCloud] = useState(false),
    [jobs, setJobs] = useState<any[]>([]),
    [error, setError] = useState(""),
    [suggestions, setSuggestions] = useState<any[]>([]),
    [source, setSource] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    if (!ch) return;
    Promise.all([
      request("GET", studioPath(ch) + "/images/status"),
      api.styleProfiles(ch),
    ])
      .then(([s, t]) => {
        if (active) {
          setStatus(s);
          setStyles(t);
          setStyle(t[0]?.id || "");
        }
      })
      .catch((e) => active && setError(e.message));
    const load = () =>
      request<any[]>("GET", studioPath(ch) + "/images/jobs")
        .then((j) => active && setJobs(j))
        .catch((e) => active && setError(e.message));
    load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [ch]);
  if (!ch) return null;
  const act = async (fn: () => Promise<unknown>) => {
    try {
      setError("");
      await fn();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="card">
      <h3>AI candidates</h3>
      <p>{status?.note || "Loading provider…"}</p>
      {error && <p role="alert">{error}</p>}
      <div className="publication-fields">
        <label>
          Style profile
          <select value={style} onChange={(e) => setStyle(e.target.value)}>
            <option value="">Choose style</option>
            {styles.map((s) => (
              <option key={s.id} value={s.id}>
                {s.style_name} · v{s.version}
              </option>
            ))}
          </select>
        </label>
        <label>
          Asset type
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="background">Background</option>
            <option value="standee">Character standee</option>
          </select>
        </label>
        <label>
          Character
          <select
            value={character}
            onChange={(e) => setCharacter(e.target.value)}
          >
            <option value="">No character</option>
            {characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {character && (
        <label>
          Fixed appearance (hair, face, clothing)
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button
            onClick={() =>
              act(() =>
                request(
                  "PUT",
                  studioPath(ch) + `/character-visuals/${character}`,
                  { description },
                ),
              )
            }
          >
            Save visual identity
          </button>
        </label>
      )}
      <label>
        Requested visual content
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      {snapshot && (
        <details>
          <summary>Explicit source lines from selected snapshot</summary>
          {snapshot.events?.map((e) => (
            <label key={e.event_id} style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={source.includes(e.event_id)}
                onChange={(x) =>
                  setSource(
                    x.target.checked
                      ? [...source, e.event_id]
                      : source.filter((id) => id !== e.event_id),
                  )
                }
              />
              {e.speaker_display_name}: {e.content.slice(0, 120)}
            </label>
          ))}
        </details>
      )}
      <label>
        <input
          type="checkbox"
          checked={cloud}
          onChange={(e) => setCloud(e.target.checked)}
        />
        Allow these selected inputs, visual profiles and reference images to be
        sent to the configured cloud provider
      </label>
      <div className="row">
        <button
          disabled={
            !status?.enabled ||
            !style ||
            !prompt ||
            (kind === "standee" && !character)
          }
          onClick={() =>
            act(() =>
              request("POST", studioPath(ch) + "/images/jobs", {
                kind,
                prompt,
                request_id: crypto.randomUUID(),
                style_profile_id: style,
                character_id: character || undefined,
                allow_cloud: cloud,
                ...(source.length && snapshot
                  ? { snapshot_id: snapshot.id, event_ids: source }
                  : {}),
              }),
            )
          }
        >
          Generate candidate
        </button>
        <button onClick={onChange}>Refresh asset library</button>
      </div>
      <p className="tiny muted">
        Candidates remain GM-only until you review identity, style and plot
        details, then explicitly approve and share them.
      </p>
      {jobs.map((j) => (
        <div className="row" key={j.id}>
          <span>
            {j.kind} · {j.provider} · {j.status} {j.error}
          </span>
          {["pending", "running"].includes(j.status) && (
            <button
              onClick={() =>
                act(() =>
                  request(
                    "POST",
                    studioPath(ch) + `/images/jobs/${j.id}/cancel`,
                  ),
                )
              }
            >
              Cancel
            </button>
          )}
        </div>
      ))}
      <hr />
      <h3>Voice delivery suggestions</h3>
      <p>
        Uses only selected performance lines. Accepting changes delivery
        instructions; canonical text remains unchanged.
      </p>
      <button
        disabled={!presentationId}
        onClick={() =>
          act(async () => {
            const p = await api.presentation(ch, presentationId!);
            setSuggestions(
              await request<any[]>(
                "POST",
                studioPath(ch) + `/presentations/${presentationId}/suggest`,
                {
                  event_ids: (p.events || [])
                    .filter((e) => !e.hidden)
                    .slice(0, 30)
                    .map((e) => e.id),
                  allow_cloud: cloud,
                },
              ),
            );
          })
        }
      >
        Suggest for first 30 visible lines
      </button>
      {suggestions.map((s) => (
        <div key={s.event_id}>
          <p>
            {s.style_instruction} — {s.reason}
          </p>
          {[true, false].map((accept) => (
            <button
              key={String(accept)}
              onClick={() =>
                act(async () => {
                  await request(
                    "POST",
                    studioPath(ch) + `/pevents/${s.event_id}/suggestion`,
                    { accept },
                  );
                  setSuggestions((x) =>
                    x.filter((i) => i.event_id !== s.event_id),
                  );
                })
              }
            >
              {accept ? "Accept" : "Discard"}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
