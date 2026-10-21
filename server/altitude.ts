import fs from "node:fs/promises";
import type { ExifTool } from "exiftool-vendored";

export const FLIGHT_ALTITUDE = 6000;
export function validAltitude(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= -12000 &&
    value <= 100000
  );
}
export function signedAltitude(raw: unknown, ref: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  return ref === 1 || ref === 3 || /below/i.test(String(ref))
    ? -Math.abs(raw)
    : raw;
}

// JPEG EXIF is in the header. Read only APP segments, never image pixels.
// Other formats and XMP are delegated to ExifTool. This makes a one-time
// pass over a large JPEG archive substantially cheaper than a full import.
export async function readAltitude(
  file: string,
  format: string,
  tool: ExifTool,
): Promise<number | null> {
  if (format === "JPEG") {
    try {
      const result = await jpegAltitude(file);
      if (result !== undefined) return result;
    } catch {
      /* Let ExifTool handle unusual or damaged EXIF structures. */
    }
  }
  const tags = await tool.readRaw(file, {
    readArgs: ["-n", "-GPSAltitude", "-GPSAltitudeRef"],
  });
  if (tags.errors?.length) throw Error(tags.errors.join("; "));
  return signedAltitude(tags.GPSAltitude, tags.GPSAltitudeRef);
}

async function jpegAltitude(file: string): Promise<number | null | undefined> {
  const handle = await fs.open(file, "r");
  try {
    const size = (await handle.stat()).size;
    const prefix = Buffer.alloc(Math.min(size, 65536));
    const { bytesRead: prefixBytes } = await handle.read(
      prefix,
      0,
      prefix.length,
      0,
    );
    const read = async (offset: number, count: number) => {
      if (offset < 0 || offset + count > size)
        throw Error("Truncated JPEG header");
      if (offset + count <= prefixBytes)
        return prefix.subarray(offset, offset + count);
      const b = Buffer.alloc(count);
      const { bytesRead } = await handle.read(b, 0, count, offset);
      if (bytesRead !== count) throw Error("Truncated JPEG header");
      return b;
    };
    const signature = await read(0, 2);
    if (signature.readUInt16BE() !== 0xffd8) return undefined;
    let offset = 2,
      xmp = false;
    for (let segments = 0; segments < 512 && offset < size; segments++) {
      const marker = await read(offset, 2);
      if (marker[0] !== 0xff) return undefined;
      if (marker[1] === 0xff) {
        offset++;
        continue;
      }
      if (marker[1] === 0xda || marker[1] === 0xd9)
        return xmp ? undefined : null;
      if (marker[1] === 0x01 || (marker[1] >= 0xd0 && marker[1] <= 0xd7)) {
        offset += 2;
        continue;
      }
      const length = (await read(offset + 2, 2)).readUInt16BE();
      if (length < 2 || offset + 2 + length > size) return undefined;
      if (marker[1] === 0xe1) {
        const app = await read(offset + 4, length - 2);
        if (app.subarray(0, 6).equals(Buffer.from("Exif\0\0"))) {
          const altitude = tiffAltitude(app.subarray(6));
          if (altitude !== null) return altitude;
        } else if (app.includes(Buffer.from("http://ns.adobe.com/")))
          xmp = true;
      }
      offset += 2 + length;
    }
    return undefined;
  } finally {
    await handle.close();
  }
}

function tiffAltitude(b: Buffer): number | null {
  const order = b.toString("ascii", 0, 2);
  if (order !== "II" && order !== "MM") throw Error("Unknown TIFF byte order");
  const u16 = (p: number) =>
    order === "II" ? b.readUInt16LE(p) : b.readUInt16BE(p);
  const u32 = (p: number) =>
    order === "II" ? b.readUInt32LE(p) : b.readUInt32BE(p);
  if (u16(2) !== 42) throw Error("Unknown TIFF structure");
  const entries = (offset: number) => {
    const count = u16(offset),
      result = new Map<number, number>();
    if (count > 4096 || offset + 2 + count * 12 > b.length)
      throw Error("Invalid TIFF directory");
    for (let i = 0; i < count; i++) {
      const p = offset + 2 + i * 12;
      result.set(u16(p), p);
    }
    return result;
  };
  const gps = entries(u32(4)).get(0x8825);
  if (gps === undefined) return null;
  if (u16(gps + 2) !== 4 || u32(gps + 4) !== 1)
    throw Error("Invalid GPS pointer");
  const tags = entries(u32(gps + 8)),
    altitude = tags.get(6),
    reference = tags.get(5);
  if (altitude === undefined) return null;
  if (u16(altitude + 2) !== 5 || u32(altitude + 4) !== 1)
    throw Error("Invalid altitude rational");
  const p = u32(altitude + 8),
    denominator = u32(p + 4);
  if (!denominator) throw Error("Invalid altitude denominator");
  let ref = 0;
  if (reference !== undefined) {
    if (u16(reference + 2) !== 1 || u32(reference + 4) !== 1)
      throw Error("Invalid altitude reference");
    ref = b[reference + 8];
  }
  return signedAltitude(u32(p) / denominator, ref);
}
