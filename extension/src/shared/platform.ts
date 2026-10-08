import descriptors from "../platforms.json";

export interface PlatformDescriptor {
  id: string;
  name: string;
  hosts: string[];
  /** Без неё звонком считается любая страница хоста. */
  callPath?: string;
}

export const PLATFORMS: PlatformDescriptor[] = descriptors;

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
  if (!platform.callPath) return true;
  try {
    return new URL(url).pathname.includes(platform.callPath);
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
