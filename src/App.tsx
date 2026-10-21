import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { api, count, date, params, post } from "./api";
import {
  AlbumDialog,
  AltitudeSettings,
  ClusterDialog,
  EditDialog,
  Modal,
  PhotoImage,
} from "./Dialogs";
import { Icon } from "./Icon";
import { MapView } from "./MapView";
import type { ClusterSelection } from "./MapView";
import { emptyFilters } from "./types";
import type { Album, Facets, Filters, Photo, Status } from "./types";
import { warmPreviews } from "./preview-cache";
import { PhotoViewer } from "./PhotoViewer";
import { isPublicHostname } from "./access";

const emptyFacets: Facets = { folders: [], tags: [], albums: [] };
const activeJob = (s?: Status) =>
  !!s && ["discovering", "running", "stopping"].includes(s.job.state);
export default function App() {
  const canEdit = !isPublicHostname(window.location.hostname);
  const [viewer, setViewer] = useState<{
    photos: Photo[];
    initialId: string;
  } | null>(null);
  const [status, setStatus] = useState<Status>(),
    [facets, setFacets] = useState<Facets>(emptyFacets),
    [filters, setFilters] = useState<Filters>(emptyFilters);
  const [search, setSearch] = useState(""),
    [view, setView] = useState<"split" | "grid" | "map">("split"),
    [section, setSection] = useState<"photos" | "albums">("photos");
  const [photos, setPhotos] = useState<Photo[]>([]),
    [total, setTotal] = useState(0),
    [loading, setLoading] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [selecting, setSelecting] = useState(false),
    [editing, setEditing] = useState<{ ids: string[]; photo?: Photo } | null>(
      null,
    );
  const [albumDialog, setAlbumDialog] = useState<Album | true | null>(null),
    [showImport, setShowImport] = useState(false),
    [showFilters, setShowFilters] = useState(false),
    [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [importBusy, setImportBusy] = useState(false),
    [deleteAlbum, setDeleteAlbum] = useState<Album | null>(null);
  const [cluster, setCluster] = useState<ClusterSelection | null>(null);
  const [mapBounds, setMapBounds] = useState<string | null>(null);
  const versionSeen = useRef(-1),
    lastRefresh = useRef(0),
    loadMoreRef = useRef<HTMLDivElement>(null),
    photoRequest = useRef(0),
    toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const photoFeedRef = useRef<HTMLElement>(null);
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const pendingScroll = useRef<{
    id?: string;
    offset: number;
    top: number;
  } | null>(null);
  const followsMap =
    view === "split" && section === "photos" && !filters.issues;
  const activeBounds = followsMap ? mapBounds : null;
  const query = params({
      ...filters,
      ...(activeBounds ? { bbox: activeBounds } : {}),
    }),
    currentAlbum = facets.albums.find((a) => a.id === filters.album);
  const activeQuery = useRef(query);
  activeQuery.current = query;
  const notify = (text: string) => {
    setNotice(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setNotice(""), 4000);
  };
  const reload = useCallback(() => {
    lastRefresh.current = Date.now();
    setRefresh((v) => v + 1);
  }, []);
  useEffect(() => {
    let stopped = false,
      controller: AbortController | undefined;
    const poll = async () => {
      controller = new AbortController();
      try {
        const next = await api<Status>("/api/status", {
          signal: controller.signal,
        });
        if (stopped) return;
        setStatus(next);
        if (
          next.version !== versionSeen.current &&
          (Date.now() - lastRefresh.current > 8000 ||
            versionSeen.current === -1)
        ) {
          versionSeen.current = next.version;
          reload();
        }
      } catch (e) {
        if (!stopped)
          setError(`Нет связи с локальным сервером. ${(e as Error).message}`);
      }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
      controller?.abort();
    };
  }, [reload]);
  useEffect(() => {
    const timer = setTimeout(
      () => setFilters((f) => ({ ...f, q: search })),
      300,
    );
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    let live = true;
    api<Facets>("/api/facets")
      .then((f) => {
        if (live) setFacets(f);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController(),
      request = ++photoRequest.current;
    setLoading(true);
    if (followsMap && !activeBounds) {
      setTotal(0);
      return () => controller.abort();
    }
    const limit = Math.min(200, Math.max(80, photosRef.current.length));
    const timer = setTimeout(
      () => {
        api<{ photos: Photo[]; total: number }>(
          `/api/photos?${query}&limit=${limit}`,
          {
            signal: controller.signal,
          },
        )
          .then(async (result) => {
            if (followsMap) {
              const existing = new Set(photosRef.current.map((p) => p.id));
              await warmPreviews(
                result.photos
                  .slice(0, 12)
                  .filter((p) => !existing.has(p.id))
                  .map((p) => p.id),
                controller.signal,
              );
            }
            if (
              request === photoRequest.current &&
              query === activeQuery.current &&
              !controller.signal.aborted
            ) {
              const feed = photoFeedRef.current;
              if (followsMap && feed) {
                const rect = feed.getBoundingClientRect();
                const anchor = Array.from(
                  feed.querySelectorAll<HTMLElement>("[data-photo-id]"),
                ).find((el) => {
                  const r = el.getBoundingClientRect();
                  return r.bottom > rect.top && r.top < rect.bottom;
                });
                pendingScroll.current = {
                  id: anchor?.dataset.photoId,
                  offset: anchor
                    ? anchor.getBoundingClientRect().top - rect.top
                    : 0,
                  top: feed.scrollTop,
                };
              }
              setPhotos(result.photos);
              setTotal(result.total);
            }
          })
          .catch((e) => {
            if (e.name !== "AbortError" && !controller.signal.aborted)
              setError(e.message);
          })
          .finally(() => {
            if (
              request === photoRequest.current &&
              query === activeQuery.current
            )
              setLoading(false);
          });
      },
      followsMap ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, refresh, followsMap, activeBounds]);
  useLayoutEffect(() => {
    const feed = photoFeedRef.current,
      saved = pendingScroll.current;
    pendingScroll.current = null;
    if (!followsMap || !feed || !saved) return;
    const anchor = Array.from(
      feed.querySelectorAll<HTMLElement>("[data-photo-id]"),
    ).find((el) => el.dataset.photoId === saved.id);
    if (anchor)
      feed.scrollTop +=
        anchor.getBoundingClientRect().top -
        feed.getBoundingClientRect().top -
        saved.offset;
    else feed.scrollTop = saved.top;
  }, [photos, followsMap]);
  useEffect(() => {
    setSelected(new Set());
    setSelecting(false);
  }, [query]);
  const loadMore = useCallback(async () => {
    if (query !== activeQuery.current || loading || photos.length >= total)
      return;
    const request = photoRequest.current;
    setLoading(true);
    try {
      const result = await api<{ photos: Photo[]; total: number }>(
        `/api/photos?${query}&offset=${photos.length}&limit=80`,
      );
      if (request === photoRequest.current && query === activeQuery.current) {
        setPhotos((p) => [
          ...p,
          ...result.photos.filter((n) => !p.some((o) => o.id === n.id)),
        ]);
        setTotal(result.total);
      }
    } catch (e) {
      if (request === photoRequest.current && query === activeQuery.current)
        setError((e as Error).message);
    } finally {
      if (request === photoRequest.current && query === activeQuery.current)
        setLoading(false);
    }
  }, [loading, photos.length, total, query]);
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { root: followsMap ? photoFeedRef.current : null, rootMargin: "400px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore, section, view, followsMap]);
  const openPhoto = async (id: string, context: Photo[] = photos) => {
    try {
      const photo = await api<Photo>(`/api/photos/${id}`);
      const sequence = context.some((p) => p.id === id)
        ? context.map((p) => (p.id === id ? photo : p))
        : [photo];
      setViewer({ photos: sequence, initialId: id });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const toggle = (id: string) =>
    setSelected((s) => {
      if (!canEdit) return s;
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const navigate = (
    next: Partial<Filters>,
    nextSection: "photos" | "albums" = "photos",
  ) => {
    setSearch("");
    setFilters({ ...emptyFilters, ...next });
    setSection(nextSection);
  };
  const importAction = async () => {
    if (!canEdit) return;
    setImportBusy(true);
    setError("");
    try {
      await post(activeJob(status) ? "/api/import/stop" : "/api/import/start");
      const next = await api<Status>("/api/status");
      setStatus(next);
      setShowImport(true);
      reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImportBusy(false);
    }
  };
  const saved = () => {
    reload();
    notify("Изменения сохранены в каталоге");
  };
  const title =
    section === "albums"
      ? "Ваши альбомы"
      : currentAlbum?.name ||
        (filters.issues
          ? "Результаты импорта"
          : filters.gps === "no"
            ? "Фото без координат"
            : filters.tag
              ? `Тег: ${filters.tag}`
              : "Все воспоминания");
  const folderRoots = Object.entries(
    facets.folders.reduce<Record<string, number>>((out, f) => {
      const root = f.folder.split("/")[0] || "Без папки";
      out[root] = (out[root] || 0) + f.count;
      return out;
    }, {}),
  ).sort((a, b) => a[0].localeCompare(b[0], "ru"));
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="AdamenkoGeoMemories">
          <span className="brand-symbol">
            <img src="/brand-mark.svg" width="38" height="38" alt="" />
          </span>
          <span>
            Adamenko<span className="brand-second">GeoMemories</span>
          </span>
        </a>
        <div className="sidebar-caption">ВАШ ЛИЧНЫЙ ФОТОАТЛАС</div>
        <nav className="main-nav" aria-label="Библиотека">
          <button
            aria-label="Все фотографии"
            className={
              section === "photos" &&
              !filters.gps &&
              !filters.album &&
              !filters.tag &&
              !filters.issues
                ? "active"
                : ""
            }
            onClick={() => navigate({})}
          >
            <Icon name="grid" />
            <span>Все фотографии</span>
            <small>{count(status?.stats.ready)}</small>
          </button>
          <button
            aria-label="Без координат"
            className={
              section === "photos" && filters.gps === "no" ? "active" : ""
            }
            onClick={() => navigate({ gps: "no" })}
          >
            <Icon name="pin" />
            <span>Без координат</span>
            <small>
              {count((status?.stats.ready || 0) - (status?.stats.located || 0))}
            </small>
          </button>
          <button
            aria-label="Альбомы"
            className={section === "albums" ? "active" : ""}
            onClick={() => navigate({}, "albums")}
          >
            <Icon name="album" />
            <span>Альбомы</span>
            <small>{facets.albums.length}</small>
          </button>
          {canEdit && (
            <button
              className="mobile-nav-settings"
              aria-label="Настройки и копии"
              onClick={() => setShowSettings(true)}
            >
              <Icon name="sliders" />
            </button>
          )}
        </nav>
        <div className="sidebar-section-title">
          <span>АЛЬБОМЫ</span>
          {canEdit && (
            <button
              className="icon-button"
              aria-label="Создать альбом"
              onClick={() => setAlbumDialog(true)}
            >
              <Icon name="plus" size={17} />
            </button>
          )}
        </div>
        <div className="sidebar-albums">
          {facets.albums.slice(0, 8).map((a) => (
            <button
              key={a.id}
              className={filters.album === a.id ? "active" : ""}
              onClick={() => navigate({ album: a.id })}
            >
              <span className="album-dot" />
              {a.name}
              <small>{count(a.count)}</small>
            </button>
          ))}
          {!facets.albums.length && (
            <p className="sidebar-hint">
              {canEdit
                ? "Соберите снимки в истории — создайте первый альбом."
                : "Альбомов пока нет."}
            </p>
          )}
        </div>
        <div className="sidebar-section-title">
          <span>ТЕГИ</span>
          <Icon name="tag" size={15} />
        </div>
        <div className="sidebar-tags">
          {facets.tags.slice(0, 15).map((t) => (
            <button
              key={t.id}
              className={filters.tag === t.name ? "active" : ""}
              onClick={() => navigate({ tag: t.name })}
            >
              #{t.name}
            </button>
          ))}
          {!facets.tags.length && (
            <p className="sidebar-hint">
              {canEdit
                ? "Добавляйте теги к одному снимку или целой группе."
                : "Тегов пока нет."}
            </p>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="local-badge">
            <span className="status-dot" />
            {canEdit ? "Локальная библиотека" : "Публичная галерея"}
          </div>
          <p>
            Ваши фотографии.
            <br />
            Ваши места. Ваши истории.
          </p>
          {canEdit && (
            <button
              className="sidebar-settings"
              onClick={() => setShowSettings(true)}
            >
              <Icon name="sliders" size={17} />
              Настройки и копии
            </button>
          )}
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            Библиотека <span>/</span>{" "}
            {section === "albums"
              ? "Альбомы"
              : currentAlbum
                ? "Альбом"
                : "Фотографии"}
          </div>
          <div className="topbar-actions">
            <span className="read-only-badge">
              <span className="status-dot" />
              {canEdit ? "Оригиналы только для чтения" : "Только просмотр"}
            </span>
            {canEdit && (
              <button
                className={`button import-button ${activeJob(status) ? "is-importing" : ""}`}
                onClick={() =>
                  activeJob(status) ? setShowImport(true) : importAction()
                }
                disabled={importBusy}
              >
                <Icon name="refresh" size={17} />
                {activeJob(status) ? "Идёт импорт" : "Импортировать"}
              </button>
            )}
          </div>
        </header>
        <div className="page-heading">
          <div>
            <span className="eyebrow">ЛИЧНАЯ КОЛЛЕКЦИЯ</span>
            <h1>
              {title}
              <span className="heading-dot">.</span>
            </h1>
            <p>
              {section === "albums"
                ? "Большие поездки и маленькие моменты — каждая история на своём месте."
                : currentAlbum?.description ||
                  `${count(status?.stats.ready)} изображений · ${count(status?.stats.located)} на карте`}
            </p>
          </div>
          {canEdit && (
            <div className="heading-actions">
              {currentAlbum ? (
                <button
                  className="button"
                  onClick={() => setAlbumDialog(currentAlbum)}
                >
                  <Icon name="edit" size={17} />
                  Об альбоме
                </button>
              ) : (
                <button className="button" onClick={() => setAlbumDialog(true)}>
                  <Icon name="plus" size={17} />
                  Новый альбом
                </button>
              )}
            </div>
          )}
        </div>
        {error && (
          <div className="error-banner" role="alert">
            <Icon name="alert" size={18} />
            <span>{error}</span>
            <button
              className="icon-button"
              aria-label="Скрыть ошибку"
              onClick={() => setError("")}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {canEdit && activeJob(status) && (
          <button className="import-strip" onClick={() => setShowImport(true)}>
            <span className="spinner" />
            <span>
              {status?.job.state === "discovering"
                ? "Поиск изображений"
                : status?.job.state === "stopping"
                  ? "Останавливаю импорт…"
                  : `Импортировано ${count(status?.job.processed)} из ${count(status?.job.discovered)}`}
            </span>
            <span className="import-strip-detail">
              Можно продолжать работать с каталогом
            </span>
            <Icon name="right" size={16} />
          </button>
        )}
        {canEdit &&
          status &&
          ["interrupted", "cancelled"].includes(status.job.state) && (
            <div className="resume-strip">
              <Icon name="refresh" size={17} />
              <span>
                Импорт остановлен. Сохранённые фотографии уже доступны.
              </span>
              <button className="text-button" onClick={importAction}>
                Продолжить импорт
              </button>
            </div>
          )}
        {section === "albums" ? (
          <div className="albums-grid">
            {canEdit && (
              <button
                className="new-album-card"
                onClick={() => setAlbumDialog(true)}
              >
                <span>
                  <Icon name="plus" size={28} />
                </span>
                <strong>Новая история</strong>
                <small>Создать альбом</small>
              </button>
            )}
            {facets.albums.map((a) => (
              <article key={a.id} className="album-card">
                <button
                  className="album-cover"
                  onClick={() => navigate({ album: a.id })}
                >
                  {a.cover_id ? (
                    <PhotoImage id={a.cover_id} />
                  ) : (
                    <div className="empty-album-cover">
                      <Icon name="album" size={42} />
                    </div>
                  )}
                  <span>{count(a.count)} фото</span>
                </button>
                <div className="album-card-info">
                  <div>
                    <button
                      className="album-title"
                      onClick={() => navigate({ album: a.id })}
                    >
                      {a.name}
                    </button>
                    <p>{a.description || "История ждёт ваших фотографий"}</p>
                  </div>
                  {canEdit && (
                    <button
                      className="icon-button"
                      aria-label={`Редактировать ${a.name}`}
                      onClick={() => setAlbumDialog(a)}
                    >
                      <Icon name="edit" size={17} />
                    </button>
                  )}
                  {canEdit && (
                    <button
                      className="icon-button muted"
                      aria-label={`Удалить альбом ${a.name}`}
                      onClick={() => setDeleteAlbum(a)}
                    >
                      <Icon name="trash" size={16} />
                    </button>
                  )}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <>
            <div className="collection-toolbar">
              <div className="search-field">
                <Icon name="search" size={18} />
                <input
                  aria-label="Поиск фотографий"
                  placeholder="Найти фото, место или воспоминание…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                {search && (
                  <button
                    className="icon-button"
                    aria-label="Очистить поиск"
                    onClick={() => setSearch("")}
                  >
                    <Icon name="close" size={15} />
                  </button>
                )}
              </div>
              <button
                className={`button filter-button ${showFilters ? "pressed" : ""}`}
                onClick={() => setShowFilters((v) => !v)}
              >
                <Icon name="sliders" size={17} />
                Фильтры
                {Object.entries(filters).some(
                  ([k, v]) => !["q", "album", "issues"].includes(k) && v,
                ) && <span className="filter-indicator" />}
              </button>
              {!filters.issues && (
                <div className="view-switch" aria-label="Вид библиотеки">
                  {(
                    [
                      ["grid", "grid", "Фотолента"],
                      ["split", "split", "Фото и карта"],
                      ["map", "map", "Карта"],
                    ] as const
                  ).map(([v, icon, label]) => (
                    <button
                      key={v}
                      className={view === v ? "active" : ""}
                      onClick={() => setView(v)}
                      title={label}
                      aria-label={label}
                      aria-pressed={view === v}
                    >
                      <Icon name={icon} size={18} />
                    </button>
                  ))}
                </div>
              )}
            </div>
            {showFilters && (
              <div className="filter-panel">
                <label>
                  Папка
                  <select
                    value={filters.folder}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, folder: e.target.value }))
                    }
                  >
                    <option value="">Все папки</option>
                    {folderRoots.map(([name, n]) => (
                      <option
                        key={name}
                        value={name === "Без папки" ? "" : name}
                      >
                        {name} ({count(n)})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Тег
                  <select
                    value={filters.tag}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, tag: e.target.value }))
                    }
                  >
                    <option value="">Все теги</option>
                    {facets.tags.map((t) => (
                      <option key={t.id}>{t.name}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Место
                  <select
                    value={filters.gps}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, gps: e.target.value }))
                    }
                  >
                    <option value="">Любое</option>
                    <option value="yes">Есть координаты</option>
                    <option value="no">Без координат</option>
                  </select>
                </label>
                <label>
                  С даты
                  <input
                    type="date"
                    value={filters.from}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, from: e.target.value }))
                    }
                  />
                </label>
                <label>
                  По дату
                  <input
                    type="date"
                    value={filters.to}
                    onChange={(e) =>
                      setFilters((f) => ({ ...f, to: e.target.value }))
                    }
                  />
                </label>
                <button
                  className="text-button"
                  onClick={() => {
                    setSearch("");
                    setFilters((f) => ({
                      ...emptyFilters,
                      album: f.album,
                      issues: f.issues,
                    }));
                  }}
                >
                  Сбросить
                </button>
              </div>
            )}
            <div className="results-heading">
              <span>
                <strong>{count(total)}</strong>{" "}
                {filters.issues
                  ? "файлов требуют внимания"
                  : followsMap
                    ? "изображений в области карты"
                    : "изображений"}
                {loading && <span className="subtle-loading"> · загрузка</span>}
              </span>
              <div>
                {canEdit && selecting && (
                  <button
                    className="text-button"
                    onClick={() =>
                      setSelected(new Set(photos.map((p) => p.id)))
                    }
                  >
                    Выбрать загруженные ({photos.length})
                  </button>
                )}
                {canEdit && !filters.issues && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setSelecting((v) => !v);
                      setSelected(new Set());
                    }}
                  >
                    <Icon name="check" size={15} />
                    {selecting ? "Отменить выбор" : "Выбрать фото"}
                  </button>
                )}
              </div>
            </div>
            {status && !status.stats.total && !activeJob(status) ? (
              !canEdit ? (
                <div className="empty-results">
                  <Icon name="image" size={40} />
                  <h2>Фотографий пока нет</h2>
                  <p>Владелец ещё не добавил снимки в галерею.</p>
                </div>
              ) : (
                <div className="welcome-state">
                  <div className="welcome-map-art">
                    <Icon name="map" size={80} />
                    <span>
                      <Icon name="image" size={30} />
                    </span>
                  </div>
                  <span className="eyebrow">
                    У КАЖДОГО СНИМКА ЕСТЬ СВОЁ МЕСТО
                  </span>
                  <h2>Соберите свою карту воспоминаний</h2>
                  <p>
                    Добавьте фотографии из архива. Мы прочитаем даты и
                    координаты,
                    <br />а вы сможете сохранить истории, теги и любимые места.
                  </p>
                  <code>{status.sourceRoot}</code>
                  <button
                    className="button primary"
                    onClick={importAction}
                    disabled={importBusy}
                  >
                    <Icon name="plus" size={18} />
                    Импортировать фотографии
                  </button>
                  <small>Оригиналы останутся без изменений</small>
                </div>
              )
            ) : filters.issues ? (
              <div className="issues-list">
                <div className="issues-intro">
                  <Icon name="alert" />
                  <p>
                    Эти файлы не входят в фотоленту. Оригиналы сохранены на
                    месте; здесь показан результат последнего чтения.
                  </p>
                </div>
                {photos.map((p) => (
                  <div className="issue-row" key={p.id}>
                    <Icon name={p.status === "empty" ? "image" : "alert"} />
                    <div>
                      <strong>{p.filename}</strong>
                      <span title={p.relative_path}>{p.relative_path}</span>
                    </div>
                    <span className="issue-type">
                      {p.status === "empty"
                        ? "Пустой файл"
                        : p.status === "missing"
                          ? "Не найден"
                          : p.status === "unsupported"
                            ? "Другой формат"
                            : "Ошибка чтения"}
                    </span>
                    <p>{p.error}</p>
                  </div>
                ))}
                <div ref={loadMoreRef} className="load-more">
                  {loading ? (
                    "Загрузка…"
                  ) : photos.length < total ? (
                    <button className="button" onClick={loadMore}>
                      Загрузить ещё
                    </button>
                  ) : !total ? (
                    "Проблемных файлов нет"
                  ) : (
                    ""
                  )}
                </div>
              </div>
            ) : (
              <div className={`workspace view-${view}`}>
                {view !== "map" && (
                  <section
                    ref={photoFeedRef}
                    className="photo-feed"
                    aria-label="Фотолента"
                    aria-busy={loading}
                  >
                    <div className="photo-grid">
                      {photos.map((p) => (
                        <article
                          key={p.id}
                          data-photo-id={p.id}
                          className={`photo-card ${selected.has(p.id) ? "selected" : ""}`}
                        >
                          <div className="photo-card-image">
                            <button
                              className="photo-open"
                              onClick={() =>
                                selecting ? toggle(p.id) : openPhoto(p.id)
                              }
                              aria-label={
                                selecting
                                  ? `Выбрать ${p.filename}`
                                  : `Открыть ${p.filename}`
                              }
                            >
                              <PhotoImage id={p.id} />
                            </button>
                            {canEdit && (
                              <button
                                className={`photo-checkbox ${selecting ? "visible" : ""}`}
                                aria-label={`${selected.has(p.id) ? "Убрать из выбора" : "Выбрать"} ${p.filename}`}
                                aria-pressed={selected.has(p.id)}
                                onClick={() => {
                                  setSelecting(true);
                                  toggle(p.id);
                                }}
                              >
                                {selected.has(p.id) && (
                                  <Icon name="check" size={15} />
                                )}
                              </button>
                            )}
                            {p.lat !== null && p.lon !== null && (
                              <span
                                className={`photo-location ${p.manual_lat !== null ? "manual" : ""}`}
                                title={
                                  p.manual_lat !== null
                                    ? "Место назначено вручную"
                                    : "Есть координаты"
                                }
                              >
                                <Icon name="pin" size={13} />
                              </span>
                            )}
                          </div>
                          <button
                            className="photo-caption"
                            onClick={() =>
                              selecting ? toggle(p.id) : openPhoto(p.id)
                            }
                          >
                            <span className="photo-date">
                              {date(p.taken_at)}
                            </span>
                            <strong title={p.description || p.filename}>
                              {p.description || p.filename}
                            </strong>
                            <span className="photo-tags">
                              {p.tags.length
                                ? p.tags
                                    .slice(0, 3)
                                    .map((t) => `#${t}`)
                                    .join("  ")
                                : p.folder.split("/")[0] || "Без папки"}
                            </span>
                          </button>
                        </article>
                      ))}
                    </div>
                    {!photos.length && !loading && (
                      <div className="empty-results">
                        <Icon name="image" size={40} />
                        <h3>
                          {followsMap
                            ? "В этой области нет фотографий"
                            : currentAlbum
                              ? "Пока ни одной фотографии"
                              : "Ничего не найдено"}
                        </h3>
                        <p>
                          {followsMap
                            ? "Переместите или отдалите карту, либо измените фильтры."
                            : currentAlbum
                              ? canEdit
                                ? "Откройте все фотографии, выделите снимки и добавьте их в этот альбом."
                                : "В этом альбоме пока нет снимков."
                              : "Попробуйте изменить фильтры или дождаться импорта."}
                        </p>
                        {currentAlbum && (
                          <button
                            className="button"
                            onClick={() => navigate({})}
                          >
                            Перейти к фотографиям
                          </button>
                        )}
                      </div>
                    )}
                    <div ref={loadMoreRef} className="load-more">
                      {loading ? (
                        <span className="spinner" />
                      ) : photos.length < total ? (
                        <button className="button" onClick={loadMore}>
                          Загрузить ещё
                        </button>
                      ) : total > 0 ? (
                        <span>Все {count(total)} изображений загружены</span>
                      ) : null}
                    </div>
                  </section>
                )}
                {view !== "grid" && (
                  <MapView
                    filters={filters}
                    revision={refresh}
                    onPhoto={openPhoto}
                    onCluster={setCluster}
                    onBoundsChange={setMapBounds}
                  />
                )}
              </div>
            )}
          </>
        )}
        <footer className="page-footer">
          <span>
            AdamenkoGeoMemories <span>·</span> Личный фотоатлас
          </span>
          {canEdit && (
            <button
              className="text-button"
              onClick={() => navigate({ issues: "1" })}
            >
              <Icon name="alert" size={14} />
              Результаты импорта
              {status?.stats.issues ? ` · ${count(status.stats.issues)}` : ""}
            </button>
          )}
        </footer>
      </main>
      {canEdit && selected.size > 0 && (
        <div className="selection-bar">
          <div>
            <span className="selection-count">{count(selected.size)}</span>
            <span>фото выбрано</span>
          </div>
          <button
            className="button primary"
            onClick={() => setEditing({ ids: [...selected] })}
          >
            <Icon name="edit" size={17} />
            Редактировать группу
          </button>
          {currentAlbum && (
            <button
              className="button"
              onClick={async () => {
                try {
                  await post("/api/photos/edit", {
                    ids: [...selected],
                    removeAlbumId: currentAlbum.id,
                  });
                  setSelected(new Set());
                  saved();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Убрать из альбома
            </button>
          )}
          <button
            className="icon-button"
            aria-label="Снять выделение"
            onClick={() => {
              setSelected(new Set());
              setSelecting(false);
            }}
          >
            <Icon name="close" />
          </button>
        </div>
      )}
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={18} />
          {notice}
        </div>
      )}
      {cluster && (
        <ClusterDialog
          cluster={cluster}
          onClose={() => setCluster(null)}
          onPhoto={(id, context) => {
            setCluster(null);
            openPhoto(id, context);
          }}
          onEdit={
            canEdit
              ? (ids) => {
                  setCluster(null);
                  setEditing({ ids });
                }
              : undefined
          }
        />
      )}
      {canEdit && editing && (
        <EditDialog
          ids={editing.ids}
          photo={editing.photo}
          albums={facets.albums}
          onClose={() => setEditing(null)}
          onSaved={saved}
        />
      )}
      {viewer && (
        <PhotoViewer
          key={viewer.initialId}
          photos={viewer.photos}
          initialId={viewer.initialId}
          onClose={() => setViewer(null)}
          onEdit={
            canEdit
              ? (photo) => {
                  setViewer(null);
                  setEditing({ ids: [photo.id], photo });
                }
              : undefined
          }
        />
      )}
      {canEdit && albumDialog && (
        <AlbumDialog
          album={albumDialog === true ? undefined : albumDialog}
          onClose={() => setAlbumDialog(null)}
          onSaved={saved}
        />
      )}
      {canEdit && deleteAlbum && (
        <Modal title="Удалить альбом?" onClose={() => setDeleteAlbum(null)}>
          <p className="modal-intro">
            Альбом «{deleteAlbum.name}» будет удалён. Фотографии, их описания и
            теги сохранятся.
          </p>
          <div className="modal-actions">
            <button className="button" onClick={() => setDeleteAlbum(null)}>
              Отмена
            </button>
            <button
              className="button danger"
              onClick={async () => {
                try {
                  await api(`/api/albums/${deleteAlbum.id}`, {
                    method: "DELETE",
                  });
                  if (filters.album === deleteAlbum.id) navigate({});
                  setDeleteAlbum(null);
                  saved();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              Удалить альбом
            </button>
          </div>
        </Modal>
      )}
      {canEdit && showImport && (
        <Modal title="Импорт фотографий" onClose={() => setShowImport(false)}>
          <p className="modal-intro">
            Каталог читает метаданные и сохраняет связь с оригиналами. Повторное
            сканирование пропускает неизменённые файлы.
          </p>
          <div className="source-path">
            <Icon name="folder" />
            <code>{status?.sourceRoot}</code>
          </div>
          <div className="import-state">
            <span className={activeJob(status) ? "spinner" : "status-dot"} />
            {status?.job.state === "discovering"
              ? "Поиск файлов…"
              : status?.job.state === "running"
                ? "Чтение метаданных…"
                : status?.job.state === "stopping"
                  ? "Завершаю текущие файлы…"
                  : status?.job.state === "completed"
                    ? "Сканирование завершено"
                    : status?.job.state === "error"
                      ? "Импорт завершился с ошибкой"
                      : status?.job.state === "idle"
                        ? "Готов к первому импорту"
                        : "Импорт остановлен"}
          </div>
          <progress
            max={status?.job.discovered || 1}
            value={status?.job.processed || 0}
          />
          <div className="import-counts">
            <div>
              <strong>{count(status?.job.processed)}</strong>
              <span>обработано</span>
            </div>
            <div>
              <strong>{count(status?.job.discovered)}</strong>
              <span>найдено</span>
            </div>
            <div>
              <strong>{count(status?.job.imported)}</strong>
              <span>добавлено / обновлено</span>
            </div>
            <div>
              <strong>{count(status?.job.unchanged)}</strong>
              <span>без изменений</span>
            </div>
          </div>
          <p className="import-current" title={status?.job.current}>
            {status?.job.current || " "}
          </p>
          {status?.job.error && (
            <p className="error-text">{status.job.error}</p>
          )}
          {!!status?.job.discoveryErrors.length && (
            <details className="discovery-errors">
              <summary>
                Ошибки доступа: {status.job.discoveryErrors.length}
              </summary>
              {status.job.discoveryErrors.slice(0, 50).map((e, i) => (
                <p key={i}>{e}</p>
              ))}
            </details>
          )}
          <div className="modal-actions">
            <button
              className="button"
              onClick={() => {
                setShowImport(false);
                navigate({ issues: "1" });
              }}
            >
              Проблемные файлы
            </button>
            <button
              className={`button ${activeJob(status) ? "" : "primary"}`}
              disabled={importBusy || status?.job.state === "stopping"}
              onClick={importAction}
            >
              <Icon name={activeJob(status) ? "stop" : "refresh"} size={17} />
              {activeJob(status)
                ? "Остановить"
                : status?.job.state === "idle"
                  ? "Начать импорт"
                  : "Сканировать снова"}
            </button>
          </div>
        </Modal>
      )}
      {canEdit && showSettings && (
        <Modal
          title="Локальная библиотека"
          onClose={() => setShowSettings(false)}
        >
          <div className="settings-info">
            <label>
              Папка оригиналов<code>{status?.sourceRoot}</code>
            </label>
            <label>
              Каталог и миниатюры<code>{status?.dataDir}</code>
            </label>
          </div>
          <p className="modal-intro">
            Все подписи, теги, альбомы и назначенные места хранятся в базе
            приложения. Карта использует интернет; фотографии и каталог доступны
            локально.
          </p>
          <div className="settings-links">
            <a className="button" href="/api/backup">
              <Icon name="download" size={17} />
              Скачать копию базы SQLite
            </a>
            <a className="button" href="/api/export">
              <Icon name="download" size={17} />
              Экспорт описаний и тегов в JSON
            </a>
          </div>
          <AltitudeSettings job={status?.altitudeJob} />
          <p className="settings-note">
            Для смены пути к архиву используйте config.local.json в папке
            приложения. Сделайте резервную копию базы перед переносом.
          </p>
        </Modal>
      )}
    </div>
  );
}
