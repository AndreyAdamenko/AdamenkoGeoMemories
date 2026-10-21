import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api, count, date, post } from "./api";
import { Icon } from "./Icon";
import { PointPicker } from "./MapView";
import type { ClusterSelection } from "./MapView";
import type { Album, Photo } from "./types";

export function Modal({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null),
    closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const focusable = () =>
      Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select,textarea,a[href],[tabindex="0"]',
        ) || [],
      ).filter((el) => el.getClientRects().length);
    focusable()[0]?.focus();
    const handler = (e: KeyboardEvent) => {
      const allDialogs = document.querySelectorAll(".modal");
      if (allDialogs[allDialogs.length - 1] !== dialog.current) return;
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        closeRef.current();
      }
      if (e.key === "Tab") {
        const all = focusable(),
          first = all[0],
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
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handler, true);
    return () => {
      document.removeEventListener("keydown", handler, true);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={dialog}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
export function PhotoImage({
  id,
  large = false,
  className = "",
}: {
  id: string;
  large?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [id, large]);
  return failed ? (
    <div className={`image-fallback ${className}`}>
      <Icon name="image" size={32} />
      <span>Превью недоступно</span>
    </div>
  ) : (
    <img
      className={className}
      src={`/api/photos/${id}/preview${large ? "?size=large" : ""}`}
      alt=""
      loading={large ? "eager" : "lazy"}
      onError={() => setFailed(true)}
    />
  );
}
export function ClusterDialog({
  cluster,
  onClose,
  onPhoto,
  onEdit,
}: {
  cluster: ClusterSelection;
  onClose: () => void;
  onPhoto: (id: string) => void;
  onEdit: (ids: string[]) => void;
}) {
  const [photos, setPhotos] = useState<Photo[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const load = async (offset: number) => {
    setBusy(true);
    try {
      const result = await api<{ photos: Photo[] }>(
        `/api/map/leaves?snapshot=${cluster.snapshot}&clusterId=${cluster.clusterId}&offset=${offset}`,
      );
      setPhotos((p) => (offset ? [...p, ...result.photos] : result.photos));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    load(0);
  }, []);
  return (
    <Modal
      title={`Фотографии в этом месте · ${count(cluster.count)}`}
      onClose={onClose}
      wide
    >
      <div className="cluster-dialog-content">
        <div className="cluster-photo-grid">
          {photos.map((p) => (
            <button key={p.id} onClick={() => onPhoto(p.id)}>
              <PhotoImage id={p.id} />
              <span>{p.description || p.filename}</span>
              <small>{date(p.taken_at)}</small>
            </button>
          ))}
        </div>
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button
            className="text-button"
            disabled={!photos.length}
            onClick={() => onEdit(photos.map((p) => p.id))}
          >
            Редактировать загруженные ({photos.length})
          </button>
          {photos.length < cluster.count && (
            <button
              className="button"
              disabled={busy}
              onClick={() => load(photos.length)}
            >
              {busy ? "Загрузка…" : "Загрузить ещё"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
function LocationModal({
  initial,
  onClose,
  onPick,
}: {
  initial?: { lat: number; lon: number };
  onClose: () => void;
  onPick: (p: { lat: number; lon: number }) => void;
}) {
  const [point, setPoint] = useState(initial);
  return (
    <Modal title="Выберите место на карте" onClose={onClose} wide>
      <p className="modal-intro">
        Нажмите на карту, чтобы поставить точку. Координаты сохранятся в
        каталоге приложения.
      </p>
      <PointPicker initial={initial} onChange={setPoint} />
      <div className="modal-actions">
        <span className="coordinates">
          {point
            ? `${point.lat.toFixed(6)}, ${point.lon.toFixed(6)}`
            : "Точка ещё не выбрана"}
        </span>
        <button
          className="button primary"
          disabled={!point}
          onClick={() => {
            if (point) onPick(point);
          }}
        >
          Использовать это место
        </button>
      </div>
    </Modal>
  );
}
export function AlbumDialog({
  album,
  onClose,
  onSaved,
}: {
  album?: Album;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(album?.name || ""),
    [description, setDescription] = useState(album?.description || ""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <Modal
      title={album ? "Редактировать альбом" : "Новый альбом"}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(album ? `/api/albums/${album.id}` : "/api/albums", {
              method: album ? "PATCH" : "POST",
              body: JSON.stringify({ name, description }),
            });
            onSaved();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Название
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={200}
            required
            placeholder="Например, лето на Иссык-Куле"
          />
        </label>
        <label>
          История альбома
          <textarea
            rows={5}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={20000}
            placeholder="Что хочется запомнить об этой поездке?"
          />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="modal-actions">
          <button type="button" className="button" onClick={onClose}>
            Отмена
          </button>
          <button className="button primary" disabled={busy || !name.trim()}>
            {busy ? "Сохраняю…" : "Сохранить альбом"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
export function EditDialog({
  ids,
  photo,
  albums,
  onClose,
  onSaved,
}: {
  ids: string[];
  photo?: Photo;
  albums: Album[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [description, setDescription] = useState(photo?.description || ""),
    [replaceDescription, setReplaceDescription] = useState(!!photo);
  const [tags, setTags] = useState(photo?.tags.join(", ") || ""),
    [removeTags, setRemoveTags] = useState(""),
    [album, setAlbum] = useState("");
  const [latitude, setLatitude] = useState(photo?.lat?.toString() || ""),
    [longitude, setLongitude] = useState(photo?.lon?.toString() || ""),
    [locationChanged, setLocationChanged] = useState(false);
  const [picking, setPicking] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [resetLocation, setResetLocation] = useState(false);
  const split = (s: string) => [
    ...new Set(
      s
        .split(",")
        .map((s) => s.trim().normalize("NFKC").toLocaleLowerCase("ru-RU"))
        .filter(Boolean),
    ),
  ];
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      let location: undefined | null | { lat: number; lon: number };
      if (locationChanged) {
        if (resetLocation || (!latitude.trim() && !longitude.trim()))
          location = null;
        else {
          const lat = Number(latitude.replace(",", ".")),
            lon = Number(longitude.replace(",", "."));
          if (
            !latitude.trim() ||
            !longitude.trim() ||
            !Number.isFinite(lat) ||
            !Number.isFinite(lon) ||
            Math.abs(lat) > 90 ||
            Math.abs(lon) > 180
          )
            throw Error(
              "Введите широту от −90 до 90 и долготу от −180 до 180.",
            );
          location = { lat, lon };
        }
      }
      const newTags = split(tags);
      await post("/api/photos/edit", {
        ids,
        description: replaceDescription ? description : undefined,
        addTags: newTags,
        removeTags: photo
          ? photo.tags.filter((t) => !newTags.includes(t))
          : split(removeTags),
        location,
        albumId: album || undefined,
      });
      onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Modal
        title={
          photo
            ? "История фотографии"
            : `Редактирование · ${count(ids.length)} фото`
        }
        onClose={onClose}
        wide
      >
        <form
          onSubmit={save}
          className={photo ? "photo-editor" : "bulk-editor"}
        >
          {photo && (
            <div className="photo-preview">
              <PhotoImage id={photo.id} large />
              <div className="photo-preview-caption">
                <strong>{photo.filename}</strong>
                <span>
                  {date(photo.taken_at)}
                  {photo.date_source === "folder" ? " · дата из папки" : ""}
                </span>
              </div>
            </div>
          )}
          <div className="editor-fields">
            {photo && (
              <div className="photo-technical">
                <span>
                  {photo.format} ·{" "}
                  {photo.width && photo.height
                    ? `${photo.width} × ${photo.height} · `
                    : ""}
                  {(photo.size / 1e6).toFixed(1)} МБ
                </span>
                <span className="path-text" title={photo.relative_path}>
                  {photo.relative_path}
                </span>
              </div>
            )}
            {!photo && (
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={replaceDescription}
                  onChange={(e) => setReplaceDescription(e.target.checked)}
                />
                Заменить описание у выбранных фотографий
              </label>
            )}
            <label>
              Описание
              <textarea
                rows={photo ? 4 : 3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={!replaceDescription}
                maxLength={20000}
                placeholder="Люди, события и детали, которые хочется сохранить…"
              />
            </label>
            <label>
              {photo ? "Теги" : "Добавить теги"}
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="путешествие, семья, горы"
              />
              <small>Разделяйте теги запятыми</small>
            </label>
            {!photo && (
              <label>
                Убрать теги
                <input
                  value={removeTags}
                  onChange={(e) => setRemoveTags(e.target.value)}
                  placeholder="Названия через запятую"
                />
              </label>
            )}
            <label>
              Добавить в альбом
              <select value={album} onChange={(e) => setAlbum(e.target.value)}>
                <option value="">Не добавлять</option>
                {albums.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            {photo && photo.albums.length > 0 && (
              <div className="tag-list">
                {photo.albums.map((a) => (
                  <span key={a.id} className="tag">
                    <Icon name="album" size={13} />
                    {a.name}
                  </span>
                ))}
              </div>
            )}
            <div className="field-heading">
              <span>Место съёмки</span>
              <button
                type="button"
                className="text-button"
                onClick={() => setPicking(true)}
              >
                <Icon name="pin" size={15} />
                Выбрать на карте
              </button>
            </div>
            <div className="coordinate-inputs">
              <label>
                Широта
                <input
                  inputMode="decimal"
                  value={latitude}
                  onChange={(e) => {
                    setLatitude(e.target.value);
                    setLocationChanged(true);
                    setResetLocation(false);
                  }}
                  placeholder="43.238949"
                />
              </label>
              <label>
                Долгота
                <input
                  inputMode="decimal"
                  value={longitude}
                  onChange={(e) => {
                    setLongitude(e.target.value);
                    setLocationChanged(true);
                    setResetLocation(false);
                  }}
                  placeholder="76.889709"
                />
              </label>
            </div>
            <div className="location-note">
              <span>
                {photo?.manual_lat !== null && photo?.manual_lat !== undefined
                  ? "Место назначено вручную"
                  : photo?.original_lat !== null &&
                      photo?.original_lat !== undefined
                    ? "Координаты из EXIF"
                    : "Можно назначить место вручную"}
              </span>
              {((photo?.manual_lat !== null &&
                photo?.manual_lat !== undefined) ||
                locationChanged) && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setLatitude(photo?.original_lat?.toString() || "");
                    setLongitude(photo?.original_lon?.toString() || "");
                    setLocationChanged(true);
                    setResetLocation(true);
                  }}
                >
                  Вернуть исходные
                </button>
              )}
            </div>
            {error && (
              <p className="error-text" role="alert">
                {error}
              </p>
            )}
            <div className="modal-actions">
              {photo && (
                <a
                  className="text-button original-link"
                  href={`/api/photos/${photo.id}/original`}
                >
                  <Icon name="download" size={16} />
                  Скачать оригинал
                </a>
              )}
              <button type="button" className="button" onClick={onClose}>
                Отмена
              </button>
              <button className="button primary" disabled={busy}>
                {busy ? "Сохраняю…" : "Сохранить"}
              </button>
            </div>
          </div>
        </form>
      </Modal>
      {picking && (
        <LocationModal
          initial={
            latitude &&
            longitude &&
            Number.isFinite(Number(latitude)) &&
            Number.isFinite(Number(longitude))
              ? { lat: Number(latitude), lon: Number(longitude) }
              : undefined
          }
          onClose={() => setPicking(false)}
          onPick={(p) => {
            setLatitude(p.lat.toString());
            setLongitude(p.lon.toString());
            setLocationChanged(true);
            setResetLocation(false);
            setPicking(false);
          }}
        />
      )}
    </>
  );
}
