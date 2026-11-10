// Pictures a member uploads into chat (POST /channels/{id}/windows/{w}/images).
export const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const PICTURE_ACCEPT = PICTURE_TYPES.join(',');
export const MAX_PICTURE_BYTES = 10 * 1024 * 1024;
const MAX_SIDE = 2560, JPEG_QUALITY = 0.9;

/** The first image among pasted or dropped files, if any. */
export function pictureAmong(files: FileList | null | undefined): File | null {
  for (const f of Array.from(files ?? [])) if (f.type.startsWith('image/')) return f;
  return null;
}

/**
 * A camera photo records where and when it was taken and is far larger than a chat needs, so a JPEG is drawn again
 * in the browser before it leaves: upright, at most MAX_SIDE on its longer side, without that data. Other formats
 * (a PNG screenshot, an animated GIF) go as they are; so does a JPEG the browser cannot redraw.
 */
export async function preparePicture(file: File): Promise<File> {
  if (file.type !== 'image/jpeg' || typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    return blob ? new File([blob], file.name, { type: 'image/jpeg' }) : file;
  } catch { return file; }
}
