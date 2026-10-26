import { t as tr } from '../../i18n';
import { useEffect, useState } from "react";
import { request } from "../../api/client";
import { useNav } from "../../store/nav";
import { studioPath } from "./publicationApi";
type Policy = { studio_cloud_allowed: boolean; tts_budget_chars: number };
export default function StudioPolicyPanel() {
  const { channelId, channel } = useNav();
  const [policy, setPolicy] = useState<Policy | null>(null),
    [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    if (channelId)
      request<Policy>("GET", studioPath(channelId) + "/settings")
        .then((p) => active && setPolicy(p))
        .catch((e) => active && setMessage(e.message));
    return () => {
      active = false;
    };
  }, [channelId]);
  if (!channelId || !policy)
    return message ? <p role="alert">{message}</p> : null;
  const editable = channel?.my_role === "gm";
  return (
    <details className="card">
      <summary>{tr("Campaign production settings")}</summary>
      <p>{tr("Cloud processing uses the providers and region configured by server maintainers. Local uploads, cached audio, PDFs and Mock providers remain usable with cloud processing disabled.")}</p>
      <div className="row">
        <label>
          <input
            type="checkbox"
            disabled={!editable}
            checked={policy.studio_cloud_allowed}
            onChange={(e) =>
              setPolicy({ ...policy, studio_cloud_allowed: e.target.checked })
            }
          />{" "}{tr("Allow selected Log Studio content to be sent to configured cloud providers")}</label>
        <label>{tr("Total TTS character budget")}{" "}
          <input
            type="number"
            min="0"
            max="100000000"
            disabled={!editable}
            value={policy.tts_budget_chars}
            onChange={(e) =>
              setPolicy({ ...policy, tts_budget_chars: Number(e.target.value) })
            }
          />
        </label>
        {editable && (
          <button
            onClick={async () => {
              try {
                setPolicy(
                  await request<Policy>(
                    "PUT",
                    studioPath(channelId) + "/settings",
                    policy,
                  ),
                );
                setMessage("Saved");
              } catch (e) {
                setMessage((e as Error).message);
              }
            }}
          >{tr("Save production settings")}</button>
        )}
      </div>
      {message && <p role="status">{message}</p>}
    </details>
  );
}
