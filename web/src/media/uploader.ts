import { getToken } from '../api/client';
import type { UploadResult } from '../api/endpoints';

export type VideoMeta = { caption: string; duration: number; width: number; height: number };

export function uploadVideo(
  file: File | Blob,
  meta: VideoMeta,
  onProgress: (ratio: number) => void,
  signal?: AbortSignal
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/api/upload');
    xhr.responseType = 'text';
    xhr.setRequestHeader('X-Meta', encodeURIComponent(JSON.stringify(meta)));
    xhr.setRequestHeader('Content-Type', 'video/mp4');
    const token = getToken();
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    /* docs-perf-notes: fetch cannot surface upload progress, so the byte counter here drives
       the progress bar for multi-megabyte clips. */
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } catch {
          reject(new Error('上传响应解析失败'));
        }
        return;
      }
      let msg = `上传失败 (${xhr.status})`;
      try {
        const body = JSON.parse(xhr.responseText) as { error?: string; message?: string };
        msg = body.error ?? body.message ?? msg;
      } catch {
        /* keep default message */
      }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('网络中断，上传失败'));
    xhr.onabort = () => reject(new DOMException('aborted', 'AbortError'));
    if (signal) {
      if (signal.aborted) {
        xhr.abort();
        return;
      }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}

export type Probe = {
  objectUrl: string;
  duration: number;
  width: number;
  height: number;
  poster: string;
  element: HTMLVideoElement;
};

export function probeVideo(file: File): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.muted = true;
    el.playsInline = true;
    el.src = objectUrl;
    const fail = () => {
      URL.revokeObjectURL(objectUrl);
      el.remove();
      reject(new Error('无法读取视频文件，请改用 MP4 / WebM'));
    };
    el.onerror = fail;
    el.onloadedmetadata = () => {
      const target = Math.min(Math.max(0.2, el.duration * 0.15), Math.max(0.2, el.duration - 0.2));
      const capture = () => {
        let poster = '';
        try {
          const w = 240;
          const ratio = el.videoHeight && el.videoWidth ? el.videoHeight / el.videoWidth : 16 / 9;
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = Math.max(1, Math.round(w * ratio));
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
            poster = canvas.toDataURL('image/jpeg', 0.6);
          }
        } catch {
          poster = '';
        }
        resolve({
          objectUrl,
          duration: Math.round(el.duration * 100) / 100,
          width: el.videoWidth || 720,
          height: el.videoHeight || 1280,
          poster,
          element: el
        });
      };
      el.onseeked = () => {
        el.onseeked = null;
        capture();
      };
      try {
        el.currentTime = target;
      } catch {
        capture();
      }
    };
  });
}

export function releaseProbe(probe: Probe | null) {
  if (!probe) return;
  try {
    probe.element.pause();
  } catch {
    /* already detached */
  }
  probe.element.removeAttribute('src');
  probe.element.load();
  probe.element.remove();
  URL.revokeObjectURL(probe.objectUrl);
}
