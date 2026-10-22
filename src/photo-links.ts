export function photoLink(id: string, origin: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
    throw Error("Некорректный ID фотографии");
  const url = new URL("/", origin);
  if (!["http:", "https:"].includes(url.protocol))
    throw Error("Некорректный адрес галереи");
  url.username = "";
  url.password = "";
  url.hash = new URLSearchParams({ photo: id }).toString();
  return url.toString();
}

export function linkedPhotoId(hash: string): string | null {
  const id = new URLSearchParams(hash.replace(/^#/, "")).get("photo");
  return id && /^[a-zA-Z0-9_-]{1,128}$/.test(id) ? id : null;
}

export function photoMapTarget(photo: {
  id: string;
  lat: number | null;
  lon: number | null;
}) {
  const { lat, lon } = photo;
  return lat !== null &&
    lon !== null &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180
    ? { id: photo.id, lat, lon, zoom: 17 }
    : null;
}
