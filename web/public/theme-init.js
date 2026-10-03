(() => {
  let saved;
  try {
    saved = localStorage.getItem("shelfwise-theme");
  } catch {
    // System preference is still available when storage is blocked.
  }
  const theme = saved === "light" || saved === "dark"
    ? saved
    : (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
})();
