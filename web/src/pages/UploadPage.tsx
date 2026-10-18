import { useEffect, useRef, useState, type DragEvent } from 'react';
import type { RouteProps } from '../router/router';
import { navigate } from '../router/router';
import { normalizeVideo, videoApi } from '../api/endpoints';
import { probeVideo, releaseProbe, uploadVideo, type Probe } from '../media/uploader';
import { feedStore } from '../store/feed';
import { useAuthStatus } from '../store/auth';
import { toast } from '../store/ui';
import { SpinnerIcon, UploadIcon } from '../components/icons';
import { formatDuration } from '../utils/format';

const MAX_MB = 200;

export default function UploadPage(_props: RouteProps) {
  const status = useAuthStatus();
  const [file, setFile] = useState<File | null>(null);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [caption, setCaption] = useState('');
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState<'pick' | 'ready' | 'uploading' | 'done'>('pick');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const probeRef = useRef<Probe | null>(null);

  useEffect(
    () => () => {
      releaseProbe(probeRef.current);
    },
    []
  );

  if (status !== 'ready') {
    return (
      <div className="upload-page">
        <div className="guard-card">
          <h1>上传作品</h1>
          <p>登录后即可发布你的第一条短视频。</p>
          <button className="btn accent pill" onClick={() => navigate('/login')}>
            去登录
          </button>
        </div>
      </div>
    );
  }

  const accept = async (picked: File | null) => {
    if (!picked) return;
    if (!picked.type.startsWith('video/')) {
      setError('请选择视频文件（mp4 / webm）');
      return;
    }
    if (picked.size > MAX_MB * 1024 * 1024) {
      setError(`文件过大，单文件上限 ${MAX_MB}MB`);
      return;
    }
    setError(null);
    releaseProbe(probeRef.current);
    setFile(picked);
    setStage('pick');
    setProgress(0);
    try {
      const result = await probeVideo(picked);
      probeRef.current = result;
      setProbe(result);
      setStage('ready');
    } catch (err) {
      setFile(null);
      setError(err instanceof Error ? err.message : '读取失败');
    }
  };

  const publish = async () => {
    if (!file || !probe || stage === 'uploading') return;
    setStage('uploading');
    setProgress(0);
    setError(null);
    try {
      const uploaded = await uploadVideo(
        file,
        { caption: caption.trim(), duration: probe.duration, width: probe.width, height: probe.height },
        setProgress
      );
      setProgress(1);
      const created = await videoApi.create({
        caption: caption.trim(),
        duration: probe.duration,
        width: probe.width,
        height: probe.height,
        poster: probe.poster,
        media_key: uploaded.media_key
      });
      const video = normalizeVideo(created.video);
      feedStore.upsertVideo(video);
      setStage('done');
      toast('发布成功', 'ok');
      navigate(`/video/${video.id}`);
    } catch (err) {
      setStage('ready');
      setError(err instanceof Error ? err.message : '发布失败');
      toast('发布失败', 'error');
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void accept(e.dataTransfer.files?.[0] ?? null);
  };

  return (
    <div className="upload-page">
      <div className="page-head">
        <h1>发布作品</h1>
      </div>
      <div className="upload-grid">
        <div
          className={`dropzone${dragging ? ' dragging' : ''}${file ? ' filled' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="选择视频文件"
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            inputRef.current?.click();
          }}
        >
          {probe ? (
            <video className="upload-preview" src={probe.objectUrl} controls muted playsInline loop />
          ) : (
            <>
              <UploadIcon size={34} strokeWidth={1.6} />
              <p>拖拽视频到这里，或点击选择文件</p>
              <span className="drop-hint">支持 mp4 / webm，单个文件不超过 {MAX_MB}MB</span>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => void accept(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="upload-form">
          <label className="field">
            <span>作品描述</span>
            <textarea
              rows={4}
              value={caption}
              maxLength={200}
              placeholder="添加作品描述，#话题 更容易被看到"
              onChange={(e) => setCaption(e.target.value)}
            />
          </label>
          <dl className="meta-list">
            <div>
              <dt>时长</dt>
              <dd>{probe ? formatDuration(probe.duration) : '—'}</dd>
            </div>
            <div>
              <dt>分辨率</dt>
              <dd>{probe ? `${probe.width}×${probe.height}` : '—'}</dd>
            </div>
            <div>
              <dt>大小</dt>
              <dd>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB` : '—'}</dd>
            </div>
            <div>
              <dt>文件名</dt>
              <dd className="ellipsis">{file?.name ?? '—'}</dd>
            </div>
          </dl>
          {stage === 'uploading' || stage === 'done' ? (
            <div className="progress">
              <div className="progress-fill" style={{ transform: `scaleX(${progress})` }} />
              <span>{Math.round(progress * 100)}%</span>
            </div>
          ) : null}
          {error ? <p className="form-error">{error}</p> : null}
          <div className="row-actions">
            {file ? (
              <button
                className="btn ghost pill"
                onClick={() => {
                  releaseProbe(probeRef.current);
                  probeRef.current = null;
                  setProbe(null);
                  setFile(null);
                  setStage('pick');
                }}
              >
                重选
              </button>
            ) : null}
            <button className="btn accent pill" onClick={publish} disabled={!probe || stage === 'uploading'}>
              {stage === 'uploading' ? <SpinnerIcon size={17} /> : null}
              <span>{stage === 'uploading' ? '上传中' : '发布'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
