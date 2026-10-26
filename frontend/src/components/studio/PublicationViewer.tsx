import PdfPreview from "./PdfPreview";
import { useEffect, useState, useMemo } from "react";
import { speakerColor, fmtTime } from "./StyledLogViewer";
import { publicationApi as api, type Publication } from "./publicationApi";
import VNPlayer from "./vn/VNPlayer";
export function PublicationContent({
  publication: p,
  token,
  channelId,
}: {
  publication: Publication;
  token?: string;
  channelId?: string;
}) {
  const colors = useMemo(() => new Map<string, string>(), [p.id]);
  const [index, setIndex] = useState(0);
  const content = p.frozen_content;
  if (!content) return null;
  return (
    <div className="card published-reading">
      <h1>{p.title}</h1>
      {p.kind === "pdf" ? (
        <PdfPreview
          url={
            token
              ? api.sharedFile(token, "pdf")
              : api.publicationFile(channelId!, p.id, "pdf")
          }
        />
      ) : p.kind === "vn" && content.presentation ? (
        <VNPlayer
          channelId={channelId || ""}
          presentation={content.presentation}
          index={index}
          onIndexChange={setIndex}
          editorMode
          characterNames={{}}
          assetUrl={(id) =>
            token
              ? api.sharedFile(token, id)
              : api.publicationFile(channelId!, p.id, id)
          }
          audioUrl={(id) =>
            token
              ? api.sharedFile(token, id)
              : api.publicationFile(channelId!, p.id, id)
          }
        />
      ) : (
        content.snapshot.events.map((e: any) => (
          <article key={e.event_id}>
            {e.event_type === "scene_change" ? (
              <h2>{e.content}</h2>
            ) : (
              <>
                <strong
                  style={{
                    color: speakerColor(
                      e,
                      content.snapshot.character_map,
                      colors,
                    ),
                  }}
                >
                  {e.speaker_display_name}
                </strong>
                <time className="tiny muted" style={{ marginLeft: 12 }}>
                  {fmtTime(e)}
                </time>
                <p
                  style={{
                    whiteSpace: "pre-wrap",
                    fontStyle:
                      e.event_type === "narration" ? "italic" : undefined,
                  }}
                >
                  {e.content}
                </p>
              </>
            )}
            {e.metadata?.dice_result?.text && (
              <pre>{e.metadata.dice_result.text}</pre>
            )}
          </article>
        ))
      )}
    </div>
  );
}
export default function SharedPublication({ token }: { token: string }) {
  const [publication, setPublication] = useState<Publication | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api
      .shared(token)
      .then((p) => active && setPublication(p))
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [token]);
  return (
    <main className="shared-publication">
      {error ? (
        <p role="alert">{error}</p>
      ) : publication ? (
        <PublicationContent publication={publication} token={token} />
      ) : (
        <p>Loading publication…</p>
      )}
    </main>
  );
}
