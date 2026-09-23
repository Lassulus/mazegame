// Shows which build is actually serving the page; the server reads it from
// Cargo.toml at compile time, so HUD, package and flake can never disagree.

export async function showVersion(el) {
  if (!el) return;
  try {
    const res = await fetch("/api/version", { cache: "no-store" });
    const { version } = await res.json();
    el.textContent = `v${version}`;
  } catch {
    el.remove();
  }
}
