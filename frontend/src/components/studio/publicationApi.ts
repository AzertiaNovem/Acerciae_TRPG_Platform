import { apiBase } from "../../lib/platform";
import { request, fileToken } from "../../api/client";
export interface PdfConfig {
  base: string;
  page_size: string;
  orientation: string;
  font: string;
  font_size: number;
  line_height: number;
  margin_mm: number;
  include_ooc: boolean;
  timestamps: boolean;
  toc: boolean;
  page_numbers: boolean;
  chapter_breaks: boolean;
  dice_style: string;
  title: string;
  subtitle: string;
  header: string;
  footer: string;
  cover_asset_id: string;
  scene_images: Record<string, string>;
  character_colors: Record<string, string>;
}
export interface PdfJob {
  id: string;
  snapshot_id: string;
  status: string;
  attempts: number;
  bytes: number | null;
  error: string | null;
  template_config: PdfConfig;
}
export interface Publication {
  id: string;
  title: string;
  kind: string;
  visibility: string;
  revoked: boolean;
  share_token?: string;
  pdf_job_id?: string;
  frozen_content?: any;
}
export const studioPath = (ch: string) => `/api/channels/${ch}/studio`;
export const publicationApi = {
  templates: (ch: string) =>
    request<{ id: string; name: string; config: PdfConfig }[]>(
      "GET",
      studioPath(ch) + "/pdf/templates",
    ),
  saveTemplate: (ch: string, name: string, config: PdfConfig) =>
    request("POST", studioPath(ch) + "/pdf/templates", { name, config }),
  jobs: (ch: string) => request<PdfJob[]>("GET", studioPath(ch) + "/pdf/jobs"),
  createPdf: (
    ch: string,
    snapshot: string,
    config: PdfConfig,
    appendix_document_ids: string[] = [],
  ) =>
    request<PdfJob>("POST", studioPath(ch) + `/snapshots/${snapshot}/pdf`, {
      config,
      appendix_document_ids,
      retry: true,
    }),
  file: (ch: string, id: string) =>
    `${apiBase()}${studioPath(ch)}/pdf/jobs/${id}/file?token=${encodeURIComponent(fileToken())}`,
  list: (ch: string) =>
    request<Publication[]>("GET", studioPath(ch) + "/publications"),
  publish: (ch: string, body: unknown) =>
    request<Publication>("POST", studioPath(ch) + "/publications", body),
  revoke: (ch: string, id: string) =>
    request("POST", studioPath(ch) + `/publications/${id}/revoke`),
  get: (ch: string, id: string) =>
    request<Publication>("GET", studioPath(ch) + `/publications/${id}`),
  shared: (token: string) =>
    request<Publication>("GET", `/api/published/${encodeURIComponent(token)}`),
  publicationFile: (ch: string, pub: string, id: string) =>
    `${apiBase()}${studioPath(ch)}/publications/${pub}/files/${id}?token=${encodeURIComponent(fileToken())}`,
  sharedFile: (token: string, id: string) =>
    `${apiBase()}/api/published/${encodeURIComponent(token)}/files/${encodeURIComponent(id)}`,
};
