export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw Error(body.error || "Ошибка запроса");
  }
  return res.json();
}
export const post = <T = unknown>(url: string, body: unknown = {}) =>
  api<T>(url, { method: "POST", body: JSON.stringify(body) });
export function params(filters: Record<string, string>) {
  return new URLSearchParams(
    Object.entries(filters).filter(([, v]) => v !== ""),
  ).toString();
}
export function count(value: number | null | undefined) {
  return new Intl.NumberFormat("ru-RU").format(value || 0);
}
export function date(value: string | null) {
  if (!value) return "Дата неизвестна";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "Дата неизвестна";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(parsed);
}
