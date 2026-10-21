import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { date } from "./api";
import type { Photo } from "./types";

export function PhotoViewer({
  photos,
  initialId,
  onClose,
  onEdit,
}: {
  photos: Photo[];
  initialId: string;
  onClose: () => void;
  onEdit?: (photo: Photo) => void;
}) {
  const [index, setIndex] = useState(
    Math.max(
      0,
      photos.findIndex((p) => p.id === initialId),
    ),
  );
  const [zoom, setZoom] = useState(1),
    [pan, setPan] = useState({ x: 0, y: 0 });
  const [loaded, setLoaded] = useState(false),
    [failed, setFailed] = useState(false),
    [fullscreen, setFullscreen] = useState(false);
  const root = useRef<HTMLDivElement>(null),
    stage = useRef<HTMLDivElement>(null),
    image = useRef<HTMLImageElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const drag = useRef<{
    id: number;
    x: number;
    y: number;
    pan: { x: number; y: number };
  } | null>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const photo = photos[index];
  const clampPan = (p: { x: number; y: number }, scale: number) => {
    const el = stage.current,
      img = image.current;
    if (!el || !img || scale <= 1) return { x: 0, y: 0 };
    const x = Math.max(0, (img.clientWidth * scale - el.clientWidth) / 2),
      y = Math.max(0, (img.clientHeight * scale - el.clientHeight) / 2);
    return {
      x: Math.max(-x, Math.min(x, p.x)),
      y: Math.max(-y, Math.min(y, p.y)),
    };
  };
  const changeZoom = (value: number) => {
    const next = Math.max(1, Math.min(4, value));
    setZoom(next);
    zoomRef.current = next;
    setPan((p) => clampPan(p, next));
  };
  const move = (direction: number) =>
    setIndex((i) => Math.max(0, Math.min(photos.length - 1, i + direction)));
  useLayoutEffect(() => {
    setZoom(1);
    zoomRef.current = 1;
    setPan({ x: 0, y: 0 });
    setLoaded(false);
    setFailed(false);
    drag.current = null;
  }, [photo.id]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null,
      overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close.current();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        move(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        changeZoom(zoomRef.current * 1.25);
      } else if (e.key === "-") {
        e.preventDefault();
        changeZoom(zoomRef.current / 1.25);
      } else if (e.key === "0") {
        e.preventDefault();
        changeZoom(1);
      } else if (e.key === "Tab") {
        const all = Array.from(
          root.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),a[href]",
          ) || [],
        ).filter((el) => el.getClientRects().length);
        const first = all[0],
          last = all[all.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    const element = root.current;
    const fs = () => setFullscreen(document.fullscreenElement === element);
    document.addEventListener("keydown", key, true);
    document.addEventListener("fullscreenchange", fs);
    return () => {
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("fullscreenchange", fs);
      if (document.fullscreenElement === element)
        void document.exitFullscreen().catch(() => {});
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, [photos.length]);
  useEffect(() => {
    const element = stage.current!;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      changeZoom(zoomRef.current * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
    };
    const reset = () => {
      setZoom(1);
      zoomRef.current = 1;
      setPan({ x: 0, y: 0 });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    window.addEventListener("resize", reset);
    return () => {
      element.removeEventListener("wheel", wheel);
      window.removeEventListener("resize", reset);
    };
  }, []);
  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement === root.current)
        await document.exitFullscreen();
      else await root.current?.requestFullscreen();
    } catch {
      /* The viewer also fills the browser window when native fullscreen is unavailable. */
    }
  };
  return createPortal(
    <div
      className="photo-viewer"
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={`Просмотр фотографии: ${photo.filename}`}
    >
      <header className="viewer-toolbar">
        <button
          onClick={onClose}
          aria-label="Закрыть просмотр"
          title="Закрыть · Esc"
        >
          <Icon name="close" />
        </button>
        <div className="viewer-title">
          <strong>{photo.filename}</strong>
          <span>
            {date(photo.taken_at)}
            {photos.length > 1 ? ` · ${index + 1} / ${photos.length}` : ""}
          </span>
        </div>
        <div className="viewer-tools">
          <button
            onClick={() => changeZoom(zoom / 1.25)}
            disabled={zoom <= 1 || !loaded}
            aria-label="Уменьшить"
            title="Уменьшить · −"
          >
            <Icon name="minus" />
          </button>
          <button
            className="viewer-scale"
            onClick={() => changeZoom(1)}
            title="Вписать в экран · 0"
            aria-label="Вписать в экран"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={() => changeZoom(zoom * 1.25)}
            disabled={zoom >= 4 || !loaded}
            aria-label="Увеличить"
            title="Увеличить · +"
          >
            <Icon name="plus" />
          </button>
          {document.fullscreenEnabled && (
            <button
              onClick={toggleFullscreen}
              aria-label={
                fullscreen ? "Выйти из полноэкранного режима" : "На весь экран"
              }
              title="Полноэкранный режим"
            >
              <Icon name={fullscreen ? "shrink" : "expand"} />
            </button>
          )}
          {onEdit && (
            <button
              onClick={() => onEdit(photo)}
              aria-label="Описание и редактирование"
              title="Описание и редактирование"
            >
              <Icon name="edit" />
            </button>
          )}
          <a
            href={`/api/photos/${photo.id}/original`}
            aria-label="Скачать оригинал"
            title="Скачать оригинал"
          >
            <Icon name="download" />
          </a>
        </div>
      </header>
      <div
        className={`viewer-stage ${zoom > 1 ? "is-zoomed" : ""}`}
        ref={stage}
        onDoubleClick={() => {
          if (loaded) changeZoom(zoomRef.current > 1 ? 1 : 2);
        }}
        onPointerDown={(e) => {
          if (
            e.button !== 0 ||
            (e.target !== e.currentTarget && e.target !== image.current)
          )
            return;
          drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, pan };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d && d.id === e.pointerId && zoomRef.current > 1)
            setPan(
              clampPan(
                { x: d.pan.x + e.clientX - d.x, y: d.pan.y + e.clientY - d.y },
                zoomRef.current,
              ),
            );
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          drag.current = null;
          if (
            zoomRef.current === 1 &&
            Math.abs(e.clientX - d.x) > 60 &&
            Math.abs(e.clientY - d.y) < 80
          )
            move(e.clientX < d.x ? 1 : -1);
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {!loaded && !failed && (
          <span className="viewer-message" role="status">
            Загрузка фотографии…
          </span>
        )}
        {failed ? (
          <div className="viewer-message" role="alert">
            <Icon name="image" size={40} />
            <p>Не удалось загрузить фотографию</p>
            <a href={`/api/photos/${photo.id}/original`}>Скачать оригинал</a>
          </div>
        ) : (
          <img
            key={photo.id}
            ref={image}
            src={`/api/photos/${photo.id}/preview?size=screen`}
            alt={photo.description || photo.filename}
            draggable={false}
            style={{
              transform: `translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
              opacity: loaded ? 1 : 0,
            }}
            onLoad={() => setLoaded(true)}
            onError={() => setFailed(true)}
          />
        )}
        {photos.length > 1 && (
          <>
            <button
              className="viewer-previous"
              onClick={() => move(-1)}
              disabled={index === 0}
              aria-label="Предыдущая фотография"
              title="Предыдущая · ←"
            >
              <Icon name="left" size={30} />
            </button>
            <button
              className="viewer-next"
              onClick={() => move(1)}
              disabled={index === photos.length - 1}
              aria-label="Следующая фотография"
              title="Следующая · →"
            >
              <Icon name="right" size={30} />
            </button>
          </>
        )}
      </div>
      <footer className="viewer-caption">
        <p>{photo.description || photo.filename}</p>
        <span>
          ← → — переключить · Колесо или + − — масштаб · Двойной щелчок —
          увеличить · Esc — закрыть
        </span>
      </footer>
    </div>,
    document.body,
  );
}
