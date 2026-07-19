/**
 * Shared browser logout — same POST /api/auth/logout used by the shell footer.
 * Redirects to /login on success. Returns an error message string on failure.
 */
export async function performClientLogout(): Promise<string | null> {
  try {
    const response = await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store"
    });
    if (!response.ok) {
      return "خروج ناموفق بود. دوباره تلاش کنید.";
    }
    window.location.replace("/login");
    return null;
  } catch {
    return "خروج ناموفق بود. دوباره تلاش کنید.";
  }
}
