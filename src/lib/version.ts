export const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "0.0.0";

export function formatAppVersionLabel(version: string = APP_VERSION): string {
  return `v${version}`;
}