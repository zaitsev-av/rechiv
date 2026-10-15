import descriptors from "../platforms.json";

export interface PlatformCapabilities {
  /** slots — дорожки по числу громких говорящих, автора называет площадка (Meet). */
  audio: "mixed" | "per-participant" | "slots";
  /** sender — писать свой голос с отправляемого трека: площадка сама убирает эхо и мьютит его. */
  localAudio?: "microphone" | "sender";
}

export interface PlatformDescriptor {
  id: string;
  name: string;
  hosts: string[];
  capabilities: PlatformCapabilities;
  /** Без неё звонком считается любая страница хоста. */
  callPath?: string;
  /** Регулярное выражение для пути, когда у звонка нет общего префикса. */
  callPathPattern?: string;
}

export const PLATFORMS: PlatformDescriptor[] = descriptors as PlatformDescriptor[];

export const platformForUrl = (url: string | undefined): PlatformDescriptor | null => {
  if (!url) return null;

  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }
  return platformForHost(host);
};

export const platformForHost = (host: string): PlatformDescriptor | null => {
  return PLATFORMS.find((platform) => platform.hosts.includes(host)) ?? null;
};

export const isCallPage = (url: string): boolean => {
  const platform = platformForUrl(url);
  if (!platform) return false;
  if (!platform.callPath && !platform.callPathPattern) return true;
  try {
    const { pathname } = new URL(url);
    if (platform.callPathPattern) return new RegExp(platform.callPathPattern).test(pathname);
    return pathname.includes(platform.callPath ?? "");
  } catch {
    return false;
  }
};

export const ALL_MATCHES: string[] = PLATFORMS.flatMap((platform) =>
  platform.hosts.map((host) => `https://${host}/*`),
);

export const ALL_ORIGINS: string[] = PLATFORMS.flatMap((platform) =>
  platform.hosts.map((host) => `https://${host}`),
);
