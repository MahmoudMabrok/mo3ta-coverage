(function () {
  var key = "mo3ta-theme";
  var root = document.documentElement;
  var button = document.querySelector("[data-theme-toggle]");

  function currentTheme() {
    var set = root.getAttribute("data-theme");
    if (set === "light" || set === "dark") return set;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function paint() {
    if (!button) return;
    var theme = currentTheme();
    button.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
    button.textContent = theme === "dark" ? "Light mode" : "Dark mode";
  }

  try {
    var stored = localStorage.getItem(key);
    if (stored === "light" || stored === "dark") root.setAttribute("data-theme", stored);
  } catch (error) {
    /* private mode */
  }

  paint();

  if (button) {
    button.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem(key, next); } catch (error) { /* ignore */ }
      paint();
    });
  }

  document.querySelectorAll("[data-copy]").forEach(function (control) {
    control.addEventListener("click", function () {
      var block = document.getElementById(control.getAttribute("data-copy"));
      if (!block || !navigator.clipboard) return;
      navigator.clipboard.writeText(block.innerText).then(function () {
        var previous = control.textContent;
        control.textContent = "Copied";
        window.setTimeout(function () { control.textContent = previous; }, 1200);
      }).catch(function () { /* leave the snippet selectable */ });
    });
  });
})();
