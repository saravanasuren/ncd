/**
 * Minimal ZIP writer — stored (uncompressed) entries only.
 *
 * The one thing we ever put in a zip is a bundle of PDFs, which are already
 * compressed, so deflating them would spend CPU to save almost nothing. Storing
 * them keeps this to a header format and a CRC, which is why there is no new
 * dependency in the tree for it.
 *
 * Writes the classic 32-bit format: a local header plus data per entry, then a
 * central directory, then the end-of-central-directory record. Zip64 is not
 * implemented, so the guards below refuse anything that would overflow the
 * 32-bit fields rather than emit a file that silently unpacks wrong.
 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Date/time in the DOS format the zip headers use. */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = d.getFullYear();
  // The format cannot represent anything before 1980.
  if (year < 1980) return { time: 0, date: (1 << 5) | 1 };
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface ZipEntry {
  /** Path inside the archive. */
  name: string;
  data: Buffer;
}

const MAX_U32 = 0xffffffff;
/** Flag bit 11: the name is UTF-8 — customer names are not all ASCII. */
const FLAG_UTF8 = 0x0800;

/** Build a zip archive from entries, in the order given. */
export function makeZip(entries: ZipEntry[], now: Date = new Date()): Buffer {
  const { time, date } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  const seen = new Set<string>();

  for (const entry of entries) {
    let name = entry.name;
    // Two customers can share a name; a duplicate entry would make one of the
    // two unreachable after unpacking, so disambiguate instead.
    if (seen.has(name)) {
      const dot = name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : '';
      let n = 2;
      while (seen.has(`${stem} (${n})${ext}`)) n++;
      name = `${stem} (${n})${ext}`;
    }
    seen.add(name);

    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.length;
    if (size > MAX_U32) throw new Error(`"${name}" is too large for a 32-bit zip`);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(0, 8);            // method 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);        // compressed
    local.writeUInt32LE(size, 22);        // uncompressed
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // extra length
    locals.push(local, nameBuf, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);         // version made by
    central.writeUInt16LE(20, 6);         // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(0, 10);         // method
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // extra
    central.writeUInt16LE(0, 32);         // comment
    central.writeUInt16LE(0, 34);         // disk number start
    central.writeUInt16LE(0, 36);         // internal attrs
    central.writeUInt32LE(0, 38);         // external attrs
    central.writeUInt32LE(offset, 42);    // local header offset
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + size;
    if (offset > MAX_U32) throw new Error('the archive is too large for a 32-bit zip');
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);                       // this disk
  end.writeUInt16LE(0, 6);                       // disk with central dir
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);                      // comment length

  if (entries.length > 0xffff) throw new Error('too many files for a 32-bit zip');
  return Buffer.concat([...locals, centralBuf, end]);
}

/** Make a string safe to use as a filename on Windows, macOS and Linux. */
export function safeFilename(s: string, fallback = 'letter'): string {
  const cleaned = s
    .replace(/[\\/:*?"<>|]/g, ' ')   // reserved on Windows
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')             // no leading dots
    .replace(/\.+$/, '');            // Windows strips trailing dots
  const out = cleaned.slice(0, 120).trim();
  return out || fallback;
}
