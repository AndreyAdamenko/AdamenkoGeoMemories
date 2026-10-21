import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { api, count, params } from "./api";
import { Icon } from "./Icon";
import type { Filters } from "./types";

type MapFeature = {
  geometry: { coordinates: [number, number] };
  properties: {
    id?: string;
    cluster?: boolean;
    cluster_id?: number;
    point_count?: number;
    expansionZoom?: number;
    altitude?: number | null;
    flightCount?: number;
  };
};
export type ClusterSelection = {
  clusterId: number;
  snapshot: string;
  count: number;
};
function baseMap(element: HTMLElement, center: [number, number], zoom: number) {
  const map = L.map(element, { zoomControl: false, maxZoom: 20 }).setView(
    center,
    zoom,
  );
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxNativeZoom: 19,
    maxZoom: 20,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  return map;
}
export function MapView({
  filters,
  revision,
  onPhoto,
  onCluster,
  onBoundsChange,
}: {
  filters: Filters;
  revision: number;
  onPhoto: (id: string) => void;
  onCluster: (cluster: ClusterSelection) => void;
  onBoundsChange: (bounds: string) => void;
}) {
  const element = useRef<HTMLDivElement>(null),
    map = useRef<L.Map | null>(null),
    markers = useRef<L.LayerGroup | null>(null);
  const callback = useRef(onPhoto);
  callback.current = onPhoto;
  const clusterCallback = useRef(onCluster);
  clusterCallback.current = onCluster;
  const boundsCallback = useRef(onBoundsChange);
  boundsCallback.current = onBoundsChange;
  const [error, setError] = useState(""),
    [visible, setVisible] = useState(0);
  const query = params(filters);
  useEffect(() => {
    const m = baseMap(element.current!, [43.3, 76.8], 5);
    map.current = m;
    markers.current = L.layerGroup().addTo(m);
    const reportBounds = () => {
      const b = m.getBounds();
      boundsCallback.current(
        [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(","),
      );
    };
    m.on("moveend resize", reportBounds);
    reportBounds();
    const observer = new ResizeObserver(() => m.invalidateSize());
    observer.observe(element.current!);
    return () => {
      observer.disconnect();
      m.remove();
      map.current = null;
    };
  }, []);
  useEffect(() => {
    const m = map.current!;
    let controller: AbortController | undefined,
      timeout: ReturnType<typeof setTimeout>;
    const load = () => {
      clearTimeout(timeout);
      controller?.abort();
      timeout = setTimeout(async () => {
        const requestController = new AbortController();
        controller = requestController;
        const b = m.getBounds();
        try {
          const response = await api<{
            features: MapFeature[];
            snapshot: string;
            visibleCount: number;
          }>(
            `/api/map?${query}&zoom=${m.getZoom()}&bbox=${[b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",")}`,
            { signal: requestController.signal },
          );
          if (requestController.signal.aborted) return;
          markers.current!.clearLayers();
          setError("");
          let n = 0;
          for (const feature of response.features) {
            const p = feature.properties,
              [lon, lat] = feature.geometry.coordinates;
            n += p.cluster ? p.point_count || 0 : 1;
            if (p.cluster) {
              const marker = L.marker([lat, lon], {
                icon: L.divIcon({
                  className: "cluster-shell",
                  html: `<span class="map-cluster ${Number(p.point_count) > 100 ? "big" : ""} ${p.flightCount ? "has-flights" : ""}">${count(p.point_count)}${p.flightCount ? '<small class="flight-badge">✈</small>' : ""}</span>`,
                  iconSize: [50, 50],
                  iconAnchor: [25, 25],
                }),
              });
              if (p.flightCount)
                marker.bindTooltip(
                  `${count(p.flightCount)} фото с высотой от 6 000 м`,
                );
              marker.on("click", () => {
                if (m.getZoom() >= 17 || (p.expansionZoom || 0) >= 19)
                  clusterCallback.current({
                    clusterId: p.cluster_id!,
                    snapshot: response.snapshot,
                    count: p.point_count!,
                  });
                else
                  m.setView(
                    [lat, lon],
                    Math.min(20, p.expansionZoom || m.getZoom() + 2),
                  );
              });
              marker.addTo(markers.current!);
            } else {
              const marker = L.marker([lat, lon], {
                icon: L.divIcon({
                  className: "photo-pin-shell",
                  html: p.flightCount
                    ? '<span class="photo-pin flight-pin"><svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor"><path d="M21 16v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5z"/></svg></span>'
                    : '<span class="photo-pin"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="m3 16 5-5 4 4 3-3 6 6"/></svg></span>',
                  iconSize: [34, 38],
                  iconAnchor: [17, 38],
                }),
              });
              if (p.altitude !== null && p.altitude !== undefined)
                marker.bindTooltip(
                  `Высота: ${Math.round(p.altitude).toLocaleString("ru-RU")} м${p.flightCount ? " · ✈" : ""}`,
                );
              marker.on("click", () => callback.current(p.id!));
              marker.addTo(markers.current!);
            }
          }
          setVisible(response.visibleCount ?? n);
        } catch (e) {
          if ((e as Error).name !== "AbortError")
            setError((e as Error).message);
        }
      }, 140);
    };
    m.on("moveend", load);
    load();
    return () => {
      m.off("moveend", load);
      clearTimeout(timeout);
      controller?.abort();
    };
  }, [query, revision]);
  return (
    <section className="map-panel">
      <div className="map-panel-heading">
        <div>
          <span className="eyebrow">ГЕОГРАФИЯ ВОСПОМИНАНИЙ</span>
          <h2>Места, где вы были</h2>
        </div>
        <button
          className="icon-button"
          aria-label="Показать мир"
          title="Показать мир"
          onClick={() => map.current?.setView([30, 30], 2)}
        >
          <Icon name="globe" />
        </button>
      </div>
      <div className="map-canvas" ref={element} />
      <div className="map-caption">
        <span className="status-dot" />
        {count(visible)} фото в этой области
        <span className="map-caption-hint">
          ✈ от 6 000 м · Приблизьте карту, чтобы увидеть снимки
        </span>
      </div>
      {error && <div className="map-error">{error}</div>}
    </section>
  );
}
export function PointPicker({
  initial,
  onChange,
}: {
  initial?: { lat: number; lon: number };
  onChange: (point: { lat: number; lon: number }) => void;
}) {
  const element = useRef<HTMLDivElement>(null),
    callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    const m = baseMap(
      element.current!,
      initial ? [initial.lat, initial.lon] : [43.25, 76.9],
      initial ? 12 : 6,
    );
    let marker: L.CircleMarker | undefined;
    const place = (lat: number, lon: number) => {
      marker?.remove();
      marker = L.circleMarker([lat, lon], {
        radius: 9,
        color: "#fff",
        weight: 3,
        fillColor: "#d96a40",
        fillOpacity: 1,
      }).addTo(m);
    };
    if (initial) place(initial.lat, initial.lon);
    m.on("click", (e: L.LeafletMouseEvent) => {
      const lat = Math.round(e.latlng.lat * 1e6) / 1e6,
        lon = Math.round(e.latlng.wrap().lng * 1e6) / 1e6;
      place(lat, lon);
      callback.current({ lat, lon });
    });
    const observer = new ResizeObserver(() => m.invalidateSize());
    observer.observe(element.current!);
    return () => {
      observer.disconnect();
      m.remove();
    };
  }, []);
  return <div ref={element} className="point-picker" />;
}
