export type Photo = {
  id: string;
  filename: string;
  relative_path: string;
  folder: string;
  size: number;
  format: string | null;
  width: number | null;
  height: number | null;
  taken_at: string | null;
  date_source: string | null;
  lat: number | null;
  lon: number | null;
  original_lat: number | null;
  original_lon: number | null;
  manual_lat: number | null;
  manual_lon: number | null;
  altitude: number | null;
  original_altitude: number | null;
  manual_altitude: number | null;
  altitude_checked: number;
  altitude_error: string | null;
  description: string;
  status: string;
  error: string | null;
  tags: string[];
  albums: { id: string; name: string }[];
  metadata_json?: string;
  source_root?: string;
};
export type Album = {
  id: string;
  name: string;
  description: string;
  count: number;
  cover_id: string | null;
};
export type Facets = {
  folders: { folder: string; count: number }[];
  tags: { id: number; name: string; count: number }[];
  albums: Album[];
};
export type Job = {
  state: string;
  discovered: number;
  processed: number;
  imported: number;
  unchanged: number;
  empty: number;
  failed: number;
  unsupported: number;
  current: string;
  discoveryErrors: string[];
  error?: string;
};
export type Status = {
  sourceRoot: string;
  dataDir: string;
  stats: {
    total: number;
    ready: number;
    located: number;
    issues: number;
    empty: number;
    missing: number;
    manual: number;
  };
  job: Job;
  version: number;
  altitudeJob: {
    state: string;
    total: number;
    pending: number;
    checked: number;
    failed: number;
    found: number;
    invalid: number;
    current: string;
    error: string;
  };
};
export type Filters = {
  q: string;
  folder: string;
  tag: string;
  album: string;
  gps: string;
  from: string;
  to: string;
  issues: string;
};
export const emptyFilters: Filters = {
  q: "",
  folder: "",
  tag: "",
  album: "",
  gps: "",
  from: "",
  to: "",
  issues: "",
};
