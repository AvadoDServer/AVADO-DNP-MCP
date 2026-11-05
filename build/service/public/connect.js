// "Approve on your AVADO": the page an app opens when the owner presses Connect (OAuth). It waits
// for the owner's Allow on the AI Connect page, then sends the browser back to the app.
// Plain JS, no dependencies, strict CSP (script-src 'self').
(function () {
  "use strict";

  var theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", theme);

  var secret = new URLSearchParams(location.search).get("r") || "";
  var POLL_MS = 2000;
  var timer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function show(title, text, link, auto) {
    $("wait").hidden = true;
    $("done").hidden = false;
    $("done-title").textContent = title;
    $("done-text").textContent = text;
    if (link) {
      $("back").href = link;
      $("back").hidden = false;
      if (auto) setTimeout(function () { location.replace(link); }, 800);
    } else {
      $("back").hidden = true;
    }
  }

  function poll() {
    fetch("wait/status?r=" + encodeURIComponent(secret), { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, body: j };
        });
      })
      .then(function (res) {
        if (!res.ok) {
          show("This sign-in has ended", (res.body && res.body.error) || "Go back to your app and press Connect again.", null, false);
          return;
        }
        var s = res.body;
        if (s.state === "waiting") {
          $("who").textContent = s.name + " wants to connect to your AVADO.";
          $("code").textContent = s.code;
          if (s.avadoPage) $("open").href = s.avadoPage;
          timer = setTimeout(poll, POLL_MS);
        } else if (s.state === "allowed") {
          show("Connected", "You allowed it. Going back to " + s.name + "…", s.redirect, true);
        } else if (s.state === "declined") {
          show("Not connected", "It was not allowed on your AVADO. Going back to " + s.name + "…", s.redirect, true);
        } else {
          show("This took too long", "Go back to " + s.name + " and press Connect again.", s.redirect, false);
        }
      })
      .catch(function () {
        $("status").textContent = "Cannot reach your AVADO right now. Trying again…";
        timer = setTimeout(poll, POLL_MS * 2);
      });
  }

  // a tab in the background is checked again as soon as it is shown
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && timer) {
      clearTimeout(timer);
      poll();
    }
  });

  poll();
})();
