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

(function () {
  var nav = document.querySelector(".nav");
  if (!nav || typeof IntersectionObserver === "undefined") return;

  var links = Array.prototype.filter.call(nav.querySelectorAll("a[href^='#']"), function (link) {
    return document.getElementById(link.getAttribute("href").slice(1));
  });
  if (!links.length) return;

  var sections = links.map(function (link) {
    return document.getElementById(link.getAttribute("href").slice(1));
  });
  var header = document.querySelector(".site-header");
  var end = document.getElementById("page-end");
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var visible = Object.create(null);
  var atBottom = false;
  var pinnedId = null;
  var currentId = null;
  var sectionObserver = null;
  var bottomObserver = null;
  var line = 80;
  var frame = 0;

  function headerHeight() {
    return header ? Math.ceil(header.getBoundingClientRect().height) : 64;
  }

  function setActive(id) {
    var next = id || null;
    if (next === currentId) return;
    currentId = next;
    links.forEach(function (link) {
      if (link.getAttribute("href") === "#" + next) link.setAttribute("aria-current", "true");
      else link.removeAttribute("aria-current");
    });
    var current = next ? nav.querySelector('[aria-current="true"]') : null;
    if (!current || nav.scrollWidth <= nav.clientWidth + 1) return;
    var linkBox = current.getBoundingClientRect();
    var barBox = nav.getBoundingClientRect();
    var delta = linkBox.left - barBox.left - (barBox.width - linkBox.width) / 2;
    if (Math.abs(delta) < 8) return;
    nav.scrollTo({
      left: nav.scrollLeft + delta,
      behavior: reduceMotion.matches ? "auto" : "smooth"
    });
  }

  function sectionOnLine() {
    var id = null;
    sections.forEach(function (section) {
      if (visible[section.id]) id = section.id;
    });
    return id;
  }

  function sync() {
    var last = sections[sections.length - 1];
    if (pinnedId) {
      var pinned = document.getElementById(pinnedId);
      var top = pinned ? pinned.getBoundingClientRect().top : 0;
      var bottom = pinned ? pinned.getBoundingClientRect().bottom : 0;
      var arrived = top <= line && bottom > line;
      var bottomSettled = atBottom && pinnedId === last.id;
      if (arrived || bottomSettled) pinnedId = null;
      else {
        setActive(pinnedId);
        return;
      }
    }

    var onLine = sectionOnLine();
    var needed = last.getBoundingClientRect().top - line;
    var remaining = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
    if (atBottom && window.scrollY > 2 && needed > remaining + 2) {
      setActive(last.id);
      return;
    }
    setActive(onLine);
  }

  function observe() {
    var bar = headerHeight();
    var margin = bar + 8;
    line = Math.min(margin + 12, Math.max(0, window.innerHeight - 2));
    document.documentElement.style.setProperty("--header-offset", margin + "px");
    var bottomInset = Math.max(0, window.innerHeight - line - 1);
    if (sectionObserver) sectionObserver.disconnect();
    if (bottomObserver) bottomObserver.disconnect();
    visible = Object.create(null);

    sectionObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        visible[entry.target.id] = entry.isIntersecting;
      });
      sync();
    }, {
      root: null,
      rootMargin: "-" + line + "px 0px -" + bottomInset + "px 0px",
      threshold: [0, 1]
    });
    sections.forEach(function (section) { sectionObserver.observe(section); });

    if (end) {
      bottomObserver = new IntersectionObserver(function (entries) {
        atBottom = entries.some(function (entry) { return entry.isIntersecting; });
        sync();
      }, { root: null, threshold: 0 });
      bottomObserver.observe(end);
    }
  }

  function schedule() {
    if (frame) return;
    frame = window.requestAnimationFrame(function () {
      frame = 0;
      observe();
    });
  }

  links.forEach(function (link) {
    link.addEventListener("click", function () {
      pinnedId = link.getAttribute("href").slice(1);
      setActive(pinnedId);
    });
  });

  function releasePin() {
    if (!pinnedId) return;
    pinnedId = null;
    sync();
  }

  window.addEventListener("wheel", releasePin, { passive: true });
  window.addEventListener("touchmove", releasePin, { passive: true });
  window.addEventListener("keydown", function (event) {
    var keys = ["ArrowDown", "ArrowUp", "PageDown", "PageUp", "Home", "End", " "];
    if (keys.indexOf(event.key) !== -1) releasePin();
  });

  observe();
  window.addEventListener("resize", schedule);
  window.addEventListener("hashchange", sync);
  if (window.ResizeObserver && header) new ResizeObserver(schedule).observe(header);
})();
