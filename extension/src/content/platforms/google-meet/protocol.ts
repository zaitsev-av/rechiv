/** Источник звука из канала `collections`: CSRC в RTP указывает на устройство участника. */
export interface MeetAudioSource {
  csrc: number;
  deviceId: string;
  muted: boolean;
}

export interface MeetDevice {
  deviceId: string;
  name: string;
}

export interface CollectionsUpdate {
  sources: MeetAudioSource[];
  devices: MeetDevice[];
}

const AUDIO_SOURCE_TYPE = 1;
const MAX_DEPTH = 10;

type Field = { num: number; varint?: number; bytes?: Uint8Array };

const DEVICE_PATH = /^spaces\/[^/]+\/devices\/([^/]+)$/;

export async function decodeCollectionsMessage(data: ArrayBuffer): Promise<CollectionsUpdate> {
  let bytes = new Uint8Array(data);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }

  return decodeMessage(bytes);
}

export function decodeRpcResponse(data: ArrayBuffer): CollectionsUpdate {
  return decodeMessage(fromBase64Text(new Uint8Array(data)));
}

export function requestDeviceId(data: Uint8Array): string | null {
  const fields = parseFields(data);
  const device = fields?.find((field) => field.num === 1)?.bytes;
  const path = device && parseFields(device)?.find((field) => field.num === 1)?.bytes;

  return deviceIdOf(text(path));
}

function decodeMessage(bytes: Uint8Array): CollectionsUpdate {
  const update: CollectionsUpdate = { sources: [], devices: [] };
  collect(bytes, update, 0);

  return update;
}

function fromBase64Text(bytes: Uint8Array): Uint8Array {
  const body = new TextDecoder("latin1").decode(bytes).trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(body)) return bytes;

  try {
    const binary = atob(body.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return bytes;
  }
}

function collect(bytes: Uint8Array, update: CollectionsUpdate, depth: number): void {
  const fields = parseFields(bytes);
  if (!fields) return;

  const source = asAudioSource(fields);
  if (source) {
    update.sources.push(source);
    return;
  }

  const device = asDevice(fields);
  if (device) {
    update.devices.push(device);
    return;
  }

  if (depth >= MAX_DEPTH) return;
  for (const field of fields) {
    if (field.bytes && field.bytes.length > 1) collect(field.bytes, update, depth + 1);
  }
}

function asDevice(fields: Field[]): MeetDevice | null {
  const deviceId = deviceIdOf(text(fields.find((field) => field.num === 1)?.bytes));
  const name = text(fields.find((field) => field.num === 2)?.bytes)?.trim();

  return deviceId && name ? { deviceId, name } : null;
}

function deviceIdOf(path: string | null | undefined): string | null {
  const match = path?.match(DEVICE_PATH);

  return match ? match[1] : null;
}

function asAudioSource(fields: Field[]): MeetAudioSource | null {
  const first = (num: number) => fields.find((field) => field.num === num);
  if (first(2)?.varint !== AUDIO_SOURCE_TYPE) return null;

  const deviceId = deviceIdOf(text(first(6)?.bytes));
  const csrc = Number(text(first(4)?.bytes));
  if (!deviceId || !Number.isSafeInteger(csrc) || csrc <= 0) return null;

  const state = first(10)?.bytes;
  const muted = (state && parseFields(state)?.find((field) => field.num === 1)?.varint) === 1;

  return { csrc, deviceId, muted };
}

function parseFields(bytes: Uint8Array): Field[] | null {
  const fields: Field[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    if (!key) return null;

    offset = key.next;
    const num = Math.floor(key.value / 8);
    const wire = key.value % 8;
    if (num === 0) return null;

    if (wire === 0) {
      const value = readVarint(bytes, offset);
      if (!value) return null;

      fields.push({ num, varint: value.value });
      offset = value.next;
    } else if (wire === 2) {
      const length = readVarint(bytes, offset);
      if (!length || length.next + length.value > bytes.length) return null;
      fields.push({ num, bytes: bytes.subarray(length.next, length.next + length.value) });
      offset = length.next + length.value;
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 5) {
      offset += 4;
    } else {
      return null;
    }
  }
  return offset === bytes.length ? fields : null;
}

function readVarint(bytes: Uint8Array, start: number): { value: number; next: number } | null {
  let value = 0;
  let scale = 1;
  for (let offset = start; offset < bytes.length && offset - start < 10; offset++) {
    const byte = bytes[offset];
    value += (byte & 0x7f) * scale;

    if (byte < 0x80) return Number.isSafeInteger(value) ? { value, next: offset + 1 } : null;
    scale *= 128;
  }

  return null;
}

function text(bytes: Uint8Array | undefined): string | null {
  if (!bytes) return null;

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}
