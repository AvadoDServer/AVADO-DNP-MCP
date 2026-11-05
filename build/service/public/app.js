// AVADO AI Connect page. Plain JS, no dependencies; loaded under a strict CSP (script-src 'self').
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var theme = params.get("theme");
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  document.documentElement.setAttribute("data-theme", theme);

  var REFRESH_MS = 5000;
  var state = null;
  var chosenClient = null;

  var CLIENT_NAMES = {
    "claude-code": "Claude Code",
    "claude-desktop": "Claude Desktop",
    chatgpt: "ChatGPT",
    codex: "Codex",
    cursor: "Cursor",
    other: "My assistant",
  };

  var TOOL_WORDS = {
    box_overview: "looked at the box overview",
    list_apps: "looked at the installed apps",
    health_check: "ran the health check",
    app_logs: "read a log",
    ethereum_status: "looked at node sync and peers",
    store_apps: "looked at the AVADO store",
    action_status: "checked install progress",
    restart_app: "restart an app",
    install_app: "install an app",
    update_app: "update an app",
    connect: "tried to connect",
    "new connection": "connection created",
    "remove connection": "connection removed",
    settings: "settings changed",
    "pin set": "PIN chosen",
    "wrong pin": "a wrong PIN was entered",
    "pin reset": "PIN reset",
  };

  var PAGE_TOOLS = { "pin set": 1, "wrong pin": 1, "pin reset": 1 };

  var OUTCOME_WORDS = {
    ok: "Done",
    started: "Started",
    error: "Did not work",
    refused: "Not allowed",
    declined: "Not done",
    waiting: "Waiting for your OK",
  };

  function $(id) {
    return document.getElementById(id);
  }

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "text") e.textContent = attrs[k];
        else if (k === "class") e.className = attrs[k];
        else e.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c) e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return e;
  }

  function ago(iso) {
    if (!iso) return "never";
    var s = Math.round((Date.now() - Date.parse(iso)) / 1000);
    if (!isFinite(s)) return "never";
    if (s < 60) return "just now";
    var m = Math.round(s / 60);
    if (m < 60) return m === 1 ? "1 minute ago" : m + " minutes ago";
    var h = Math.round(m / 60);
    if (h < 48) return h === 1 ? "1 hour ago" : h + " hours ago";
    return Math.round(h / 24) + " days ago";
  }

  function when(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function api(method, path, body) {
    var opts = { method: method, headers: { Accept: "application/json" } };
    if (method !== "GET") {
      opts.headers["Content-Type"] = "application/json";
      opts.headers["X-Avado-Request"] = "1";
      opts.body = JSON.stringify(body || {});
    }
    return fetch(path, opts).then(function (r) {
      return r.json().then(
        function (j) {
          if (!r.ok) {
            var err = new Error(j && j.error ? j.error : "Something went wrong (" + r.status + ")");
            err.status = r.status;
            // the page locked itself (or was locked on another tab): show the PIN form again
            if (r.status === 401 && path.indexOf("/api/pin/") !== 0) refresh();
            throw err;
          }
          return j;
        },
        function () {
          throw new Error("Something went wrong (" + r.status + ")");
        },
      );
    });
  }

  function clock(iso) {
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function localUrl() {
    return "https://mcp.my.ava.do/mcp";
  }

  function tailscaleUrl() {
    var t = state && state.tailscale;
    return t && t.state === "running" && t.mcpShared && typeof t.mcpUrl === "string" ? t.mcpUrl : null;
  }

  function publicUrl() {
    var t = state && state.tailscale;
    return t && t.funnel && typeof t.publicMcpUrl === "string" ? t.publicMcpUrl : null;
  }

  /** The /k/<key>/mcp form, for apps that only take a link. */
  function linkWithKey(base, key) {
    return base.replace(/\/mcp\/?$/, "") + "/k/" + key + "/mcp";
  }

  function codeBlock(text) {
    var id = "c" + Math.random().toString(36).slice(2);
    return el("div", { class: "copyrow" }, [el("pre", { id: id, text: text }), el("button", { type: "button", class: "button small", "data-copy": id, text: "Copy" })]);
  }

  function steps(items) {
    return el(
      "ol",
      { class: "steps" },
      items.map(function (i) {
        return el("li", null, Array.isArray(i) ? i : [i]);
      }),
    );
  }

  function stepsFor(client, key) {
    var url = tailscaleUrl() || localUrl();
    var where = tailscaleUrl()
      ? "This uses your Tailscale address, so it works wherever Tailscale is on."
      : "This works on a computer connected to your AVADO through AVADO Remote Access (or the AVADO WiFi).";
    var box = el("div", { class: "made-steps" });
    if (client === "claude-code") {
      box.appendChild(
        steps([
          "Open a terminal on the computer where you use Claude Code.",
          ["Paste this and press Enter:", codeBlock('claude mcp add --transport http avado ' + url + ' --header "Authorization: Bearer ' + key + '"')],
          "Start Claude Code and ask: “How is my AVADO doing?”",
        ]),
      );
    } else if (client === "claude-desktop") {
      box.appendChild(
        steps([
          "In Claude Desktop open Settings, then Developer, then Edit Config. This opens a file called claude_desktop_config.json.",
          [
            "Replace what is in it with this (if you already have other entries under mcpServers, add only the “avado” part). It needs Node.js on your computer (nodejs.org).",
            codeBlock(
              JSON.stringify(
                { mcpServers: { avado: { command: "npx", args: ["-y", "mcp-remote@0.15.2", url, "--header", "Authorization:${AVADO_KEY}"], env: { AVADO_KEY: "Bearer " + key } } } },
                null,
                2,
              ),
            ),
          ],
          "Save the file, quit Claude Desktop completely and open it again. Then ask: “How is my AVADO doing?”",
        ]),
      );
    } else if (client === "chatgpt") {
      var pub = publicUrl();
      if (!pub) {
        box.appendChild(
          el("p", {
            class: "notice",
            text:
              "ChatGPT runs on the internet, so it needs a public address for AI Connect. Install the Tailscale app from the AVADO store, connect it, and under More options switch on “Share AI Connect on the internet”. Then come back here and make a new ChatGPT key: the steps will include the address.",
          }),
        );
      } else {
        box.appendChild(
          steps([
            "In ChatGPT open Settings, then Apps & Connectors, then Advanced settings, and switch on Developer mode.",
            "Go back to Apps & Connectors and choose Create (or Add a connector).",
            "Name: AVADO. Authentication: No authentication (the key is part of the address below).",
            ["Connector URL: paste this private address. It contains your key, so do not share it.", codeBlock(linkWithKey(pub, key))],
            "Save, then in a new chat turn on the AVADO connector and ask: “How is my AVADO doing?”",
          ]),
        );
      }
    } else if (client === "codex") {
      box.appendChild(
        steps([
          ["Open the file .codex/config.toml in your home folder (create it if it is not there) and add:", codeBlock('[mcp_servers.avado]\nurl = "' + url + '"\nbearer_token_env_var = "AVADO_KEY"')],
          ["Make the key available to Codex, for example by adding this line to your shell profile:", codeBlock("export AVADO_KEY=" + key)],
          "Start Codex and ask: “How is my AVADO doing?”",
        ]),
      );
    } else if (client === "cursor") {
      box.appendChild(
        steps([
          ["In Cursor open Settings, then MCP, then Add new MCP server (this opens mcp.json). Add:", codeBlock(JSON.stringify({ mcpServers: { avado: { url: url, headers: { Authorization: "Bearer " + key } } } }, null, 2))],
          "Save. AVADO appears in the MCP list; ask the chat: “How is my AVADO doing?”",
        ]),
      );
    } else {
      box.appendChild(
        steps([
          ["Address (MCP over “Streamable HTTP”):", codeBlock(url)],
          ["Send this header with every request:", codeBlock("Authorization: Bearer " + key)],
          ["If your app can only take an address, use this one (it contains the key):", codeBlock(linkWithKey(url, key))],
        ]),
      );
    }
    box.appendChild(el("p", { class: "muted small", text: where }));
    return box;
  }

  function scopeWords(scopes) {
    var out = ["look"];
    if (scopes.indexOf("restart") >= 0) out.push("restart apps");
    if (scopes.indexOf("install") >= 0) out.push("install and update apps");
    return out;
  }

  function renderApprovals() {
    var list = $("approval-list");
    list.textContent = "";
    var items = (state && state.approvals) || [];
    $("approvals").hidden = items.length === 0;
    items.forEach(function (a) {
      var allow = el("button", { type: "button", class: "button", text: "Allow" });
      var deny = el("button", { type: "button", class: "button ghost", text: "Don't allow" });
      function decide(decision) {
        allow.disabled = deny.disabled = true;
        api("POST", "/api/approvals/" + a.id, { decision: decision })
          .catch(function (e) {
            alert(e.message);
          })
          .then(refresh);
      }
      allow.addEventListener("click", function () {
        decide("allow");
      });
      deny.addEventListener("click", function () {
        decide("deny");
      });
      list.appendChild(
        el("li", null, [
          el("div", { class: "row" }, [el("span", { class: "name", text: a.who + " wants to: " + a.summary })]),
          el("span", { class: "muted small", text: "Waits until " + when(a.expiresAt) + ". If you do nothing, it does not happen." }),
          el("div", { class: "actions" }, [allow, deny]),
        ]),
      );
    });
  }

  function renderTokens() {
    var list = $("token-list");
    list.textContent = "";
    var tokens = (state && state.tokens) || [];
    $("tokens-empty").hidden = tokens.length > 0;
    tokens.forEach(function (t) {
      var remove = el("button", { type: "button", class: "button small ghost", text: "Remove" });
      remove.addEventListener("click", function () {
        if (!confirm("Remove “" + t.name + "”? Its key stops working right away.")) return;
        remove.disabled = true;
        api("POST", "/api/tokens/" + t.id + "/revoke")
          .catch(function (e) {
            alert(e.message);
          })
          .then(refresh);
      });
      var hasActions = t.scopes.indexOf("restart") >= 0 || t.scopes.indexOf("install") >= 0;
      var children = [
        el("div", { class: "row" }, [el("span", { class: "name", text: t.name }), remove]),
        el(
          "div",
          null,
          [el("span", { class: "tag", text: CLIENT_NAMES[t.client] || "Other" })].concat(
            scopeWords(t.scopes).map(function (w) {
              return el("span", { class: "tag", text: w });
            }),
          ),
        ),
        el("span", { class: "muted small", text: "Made " + ago(t.createdAt) + " · last used " + ago(t.lastUsedAt) + " · key starts with " + t.hint + "…" }),
      ];
      if (hasActions) {
        var box = el("input", { type: "checkbox" });
        box.checked = t.confirmActions !== false;
        box.addEventListener("change", function () {
          api("POST", "/api/tokens/" + t.id + "/confirm", { confirmActions: box.checked })
            .catch(function (e) {
              alert(e.message);
            })
            .then(refresh);
        });
        children.push(el("label", { class: "check small" }, [box, "Ask me on this page before it restarts, installs or updates anything"]));
      }
      list.appendChild(el("li", null, children));
    });
  }

  function renderActivity() {
    var list = $("activity-list");
    list.textContent = "";
    var items = (state && state.activity) || [];
    $("activity-empty").hidden = items.length > 0;
    items.slice(0, 60).forEach(function (a) {
      var what = TOOL_WORDS[a.tool] || a.tool;
      var line = (a.who || (PAGE_TOOLS[a.tool] ? "This page" : "Unknown")) + ": " + what + (a.target ? " (" + a.target + ")" : "");
      list.appendChild(
        el("li", { "data-outcome": a.outcome }, [
          el("div", { class: "row" }, [el("span", { text: line }), el("span", { class: "muted small", text: when(a.at) })]),
          el("span", { class: "muted small", text: (OUTCOME_WORDS[a.outcome] || a.outcome) + (a.detail ? ". " + a.detail : "") }),
        ]),
      );
    });
  }

  function renderUrls() {
    var ts = state && state.tailscale;
    var dd = $("url-tailscale");
    dd.textContent = "";
    if (!ts) {
      dd.textContent = "Install the Tailscale app from the AVADO store to use AI Connect from anywhere.";
    } else if (ts.state !== "running") {
      dd.textContent = "The Tailscale app is installed but not connected yet. Open it and follow step 1.";
    } else if (!tailscaleUrl()) {
      dd.textContent = "Open the Tailscale app, open More options and switch on “Make AI Connect reachable from my Tailscale devices”.";
    } else {
      dd.appendChild(el("code", { text: tailscaleUrl() }));
      if (publicUrl()) dd.appendChild(el("div", { class: "muted small", text: "Also shared on the internet (for ChatGPT): " + publicUrl() }));
    }
    var h = state && state.https;
    $("https-state").textContent =
      h && h.on
        ? "Secure connection (https) is on" + (h.validTo ? ", certificate valid until " + new Date(h.validTo).toLocaleDateString() : "") + "."
        : "Secure connection (https) is not ready yet: the box could not download the my.ava.do certificate. Until then use http://mcp.my.ava.do/mcp.";
  }

  // the same words as waitWords in src/pin.ts
  function waitWords(seconds) {
    var m = Math.ceil(seconds / 60);
    var when = seconds <= 60 ? (seconds === 1 ? "1 second" : seconds + " seconds") : m === 1 ? "1 minute" : m + " minutes";
    return "Too many wrong PINs from this device. Try again in " + when + ".";
  }

  function renderPin() {
    var p = state.pin || { set: false, unlocked: false };
    var unlocked = !!p.unlocked;
    Array.prototype.forEach.call(document.querySelectorAll(".needs-pin"), function (sec) {
      if (sec.id !== "approvals") sec.hidden = !unlocked;
    });
    $("pin-card").hidden = unlocked;
    $("pin-new").hidden = unlocked || p.set;
    $("pin-enter").hidden = unlocked || !p.set;
    if (unlocked) {
      $("pin-session").textContent = p.expiresAt
        ? "The page is unlocked. It locks again by itself at " + clock(p.expiresAt) + " (sooner after 10 minutes without a click)."
        : "The page is unlocked.";
      return;
    }
    $("create-form").hidden = true;
    var waiting = state.waiting || 0;
    $("pin-waiting").hidden = !p.set || waiting === 0;
    $("pin-waiting").textContent =
      waiting === 1 ? "Your assistant is waiting for your OK. Enter your PIN to see what it wants to do." : waiting + " requests from your assistants wait for your OK. Enter your PIN to see them.";
    var wait = p.retryAfter || 0;
    $("pin-enter-button").disabled = wait > 0;
    if (wait > 0) $("pin-enter-msg").textContent = waitWords(wait);
    else if (/Too many wrong PINs/.test($("pin-enter-msg").textContent)) $("pin-enter-msg").textContent = "";
    $("pin-slow").hidden = !p.slow;
    $("pin-reset-open").hidden = !p.resetUntil;
    $("pin-reset-closed").hidden = !!p.resetUntil;
    if (p.resetUntil) {
      $("pin-reset-until").textContent = clock(p.resetUntil);
      $("pin-forgot").open = true;
    }
  }

  function render() {
    if (!state) return;
    $("version").textContent = state.version ? "Version " + state.version : "";
    renderPin();
    renderUrls();
    if (!(state.pin && state.pin.unlocked)) {
      $("approvals").hidden = true;
      return;
    }
    renderApprovals();
    renderTokens();
    renderActivity();
  }

  function refresh() {
    return api("GET", "/api/state")
      .then(function (s) {
        state = s;
        render();
      })
      .catch(function () {
        /* keep the last view; try again later */
      });
  }

  // ---- the PIN ----
  $("pin-new-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var a = $("pin-new-1").value.trim();
    var b = $("pin-new-2").value.trim();
    if (!/^[0-9]{6,12}$/.test(a)) {
      $("pin-new-msg").textContent = "Use 6 to 12 digits, nothing else.";
      return;
    }
    if (a !== b) {
      $("pin-new-msg").textContent = "The two PINs are not the same. Please type them again.";
      return;
    }
    $("pin-new-button").disabled = true;
    $("pin-new-msg").textContent = "Saving…";
    api("POST", "/api/pin/set", { pin: a })
      .then(function () {
        $("pin-new-1").value = $("pin-new-2").value = "";
        $("pin-new-msg").textContent = "";
        return refresh();
      })
      .catch(function (e) {
        $("pin-new-msg").textContent = e.message;
        return refresh();
      })
      .then(function () {
        $("pin-new-button").disabled = false;
      });
  });

  $("pin-enter-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var v = $("pin-value").value.trim();
    if (!v) return;
    $("pin-enter-button").disabled = true;
    $("pin-enter-msg").textContent = "Checking…";
    api("POST", "/api/pin/unlock", { pin: v })
      .then(function () {
        $("pin-enter-msg").textContent = "";
      })
      .catch(function (e) {
        $("pin-enter-msg").textContent = e.message;
      })
      .then(function () {
        $("pin-value").value = "";
        $("pin-enter-button").disabled = false;
        return refresh();
      });
  });

  $("pin-reset-button").addEventListener("click", function () {
    if (!confirm("Reset the PIN? All your connections are removed and their keys stop working. You then choose a new PIN and connect your assistants again.")) return;
    $("pin-reset-button").disabled = true;
    api("POST", "/api/pin/reset")
      .then(function (r) {
        $("pin-reset-msg").textContent = "";
        $("pin-new-msg").textContent = "The PIN was reset" + (r.removed ? " and " + (r.removed === 1 ? "1 connection was" : r.removed + " connections were") + " removed" : "") + ". Choose a new PIN.";
        $("pin-forgot").open = false;
      })
      .catch(function (e) {
        $("pin-reset-msg").textContent = e.message;
      })
      .then(function () {
        $("pin-reset-button").disabled = false;
        return refresh();
      });
  });

  $("pin-lock").addEventListener("click", function () {
    api("POST", "/api/pin/lock")
      .catch(function () {
        /* locked either way once the session is gone */
      })
      .then(refresh);
  });

  // choose a client -> form
  Array.prototype.forEach.call(document.querySelectorAll(".choice"), function (b) {
    b.addEventListener("click", function () {
      chosenClient = b.getAttribute("data-client");
      Array.prototype.forEach.call(document.querySelectorAll(".choice"), function (x) {
        x.setAttribute("aria-pressed", x === b ? "true" : "false");
      });
      $("made").hidden = true;
      $("create-form").hidden = false;
      $("token-name").value = (CLIENT_NAMES[chosenClient] || "My assistant") + " on my computer";
      $("create-msg").textContent = "";
      $("token-name").focus();
    });
  });

  $("create-cancel").addEventListener("click", function () {
    $("create-form").hidden = true;
  });

  $("create-form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var scopes = ["read"];
    if ($("scope-restart").checked) scopes.push("restart");
    if ($("scope-install").checked) scopes.push("install");
    $("create-button").disabled = true;
    $("create-msg").textContent = "Creating…";
    api("POST", "/api/tokens", { name: $("token-name").value, client: chosenClient, scopes: scopes, confirmActions: $("confirm-actions").checked })
      .then(function (made) {
        $("create-form").hidden = true;
        $("made").hidden = false;
        $("made-key").textContent = made.token;
        var stepsBox = $("made-steps");
        stepsBox.textContent = "";
        stepsBox.appendChild(stepsFor(chosenClient, made.token));
        $("create-msg").textContent = "";
        return refresh();
      })
      .catch(function (e) {
        $("create-msg").textContent = e.message;
      })
      .then(function () {
        $("create-button").disabled = false;
      });
  });

  $("made-done").addEventListener("click", function () {
    $("made").hidden = true;
    $("made-key").textContent = "";
    $("made-steps").textContent = "";
  });

  // copy buttons (also inside generated steps)
  document.addEventListener("click", function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest("[data-copy]") : null;
    if (!b) return;
    var src = $(b.getAttribute("data-copy"));
    if (!src) return;
    var text = src.textContent;
    var done = function () {
      var old = b.textContent;
      b.textContent = "Copied";
      setTimeout(function () {
        b.textContent = old;
      }, 1500);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () {
        selectText(src);
      });
    } else {
      selectText(src);
      try {
        document.execCommand("copy");
        done();
      } catch (e) {
        /* the text is selected; the owner can copy it by hand */
      }
    }
  });

  function selectText(node) {
    var range = document.createRange();
    range.selectNodeContents(node);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  refresh();
  setInterval(function () {
    if (!document.hidden) refresh();
  }, REFRESH_MS);
})();
