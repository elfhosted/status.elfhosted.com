/* ==========================================================================
   ElfHosted status page — availability enhancements
   --------------------------------------------------------------------------
   Loaded via status-website.scripts in .upptimerc.yml.

   Upptime's status page is a Svelte app that renders client-side, so this
   script can't just run once on load — it watches for the cards to appear and
   re-runs whenever they're re-rendered (the 24h/7d/30d/1y/all picker rebuilds
   the whole list). Everything it does is additive and idempotent.

   What it does:
     1. Draws a 90-day availability strip on each service card, from the
        dailyMinutesDown map Upptime already publishes in history/summary.json.
     2. Removes the "Average response time" line — availability is the metric
        this page is about. (Upstream's per-site showAverageResponseTime flag
        does NOT work: summary.ts never copies it into summary.json, so the
        Svelte check always sees undefined.)
     3. Colour-grades the uptime figure.
     4. Adds the recurring glow-up maintenance window, in the reader's local
        time, and a legend for the bar colours.
     5. On a service page, replaces the response-time chart with a full
        90-day strip.

   Fails soft: any error here leaves the page as CSS alone renders it.
   ========================================================================== */

(function () {
  "use strict";

  var OWNER = "elfhosted";
  var REPO = "status.elfhosted.com";
  var BRANCH = "master";
  var RAW = "https://raw.githubusercontent.com/" + OWNER + "/" + REPO + "/" + BRANCH;
  var SUMMARY_URL = RAW + "/history/summary.json";
  /* summary.json has no startTime, so days before a service was first
     monitored would otherwise render as green "no downtime" — inventing
     history. This map is published by .github/workflows/service-start-times.yml.
     If it fails to load we grey out nothing rather than block the page. */
  var START_TIMES_URL = RAW + "/assets/start-times.json";

  var DAYS = 90;
  var DAY_MINUTES = 1440;

  /* The elfhosted.com cluster reboots and updates for an hour every day. Every
     publicly monitored service runs there. Kept in UTC and rendered in the
     reader's own timezone — see cluster-vars/elfhosted.com (kured window) and
     cronjobs/reconcile-myprecious--flux-system in the infra repo. */
  var GLOWUP_START_UTC_HOUR = 2;
  var GLOWUP_DURATION_HOURS = 1;

  var summary = null;
  var startTimes = {};
  /* If the start-times map can't be fetched we can't tell "clean day" from
     "didn't exist yet" for ANY service, so we draw no strips at all rather
     than a wall of grey or a wall of invented green. The cards fall back to
     name + uptime %, which is degraded but true. */
  var startTimesOk = false;
  var pending = false;

  /* --- data ------------------------------------------------------------ */

  function dayKey(d) {
    return (
      d.getUTCFullYear() + "-" +
      String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
      String(d.getUTCDate()).padStart(2, "0")
    );
  }

  /* Downtime is always a fraction of the minutes actually OBSERVED, not of a
     nominal 1440. Today's bucket only covers the minutes elapsed so far, and a
     service's first day only covers the minutes since it was added — dividing
     either by a whole day turns a live 3-hour outage at 06:00 UTC into a
     reassuring "87.5% up" when the honest figure is 50%. */
  function tierFor(day) {
    if (day.mins === null) return "nodata";
    if (day.mins <= 0) return "up";
    var pct = day.mins / Math.max(1, day.observed);
    if (pct < 0.01) return "minor";
    if (pct < 0.05) return "major";
    return "outage";
  }

  function describe(day) {
    if (day.mins === null) return "not yet monitored";
    var partial = day.observed < DAY_MINUTES;
    var suffix = partial ? " (so far today)" : "";
    if (day.mins <= 0) return "no downtime" + suffix;
    if (day.mins >= day.observed) return "down for the whole period" + suffix;

    var pct = (100 - (day.mins / Math.max(1, day.observed)) * 100).toFixed(2) + "% up";
    var amount = day.mins >= 60
      ? Math.floor(day.mins / 60) + "h " + (day.mins % 60) + "m down"
      : day.mins + "m down";
    return amount + " · " + pct + suffix;
  }

  /* A date missing from dailyMinutesDown is a clean day — but only once the
     service was actually being monitored. Before startTime it's "no data",
     which must not be dressed up as 100%. */
  function daysFor(site, count) {
    // No start time means we cannot tell "clean day" from "didn't exist yet",
    // so every day is unknown. Silently defaulting to "monitored forever" is
    // what invents 90 green days for a service that is a week old.
    var iso = startTimes[site.slug];
    var start = iso ? new Date(iso) : null;

    var now = new Date();
    var todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    var elapsedToday = Math.max(0, Math.round((now.getTime() - todayStart) / 60000));

    var out = [];
    for (var i = count - 1; i >= 0; i--) {
      var d = new Date(todayStart);
      d.setUTCDate(d.getUTCDate() - i);
      var dayStart = d.getTime();
      var dayEnd = dayStart + DAY_MINUTES * 60000;

      if (!start || start.getTime() >= dayEnd) {
        out.push({ key: dayKey(d), mins: null, observed: 0 });
        continue;
      }

      // Minutes of this day that were actually watched: clipped at the front by
      // the service's start time, and at the back by "now" for today.
      var from = Math.max(dayStart, start.getTime());
      var to = Math.min(dayEnd, now.getTime());
      var observed = Math.max(0, Math.round((to - from) / 60000));
      if (dayStart === todayStart) observed = Math.min(observed, elapsedToday);

      out.push({
        key: dayKey(d),
        mins: observed > 0 ? (site.dailyMinutesDown || {})[dayKey(d)] || 0 : null,
        observed: observed
      });
    }
    return out;
  }

  /* --- rendering -------------------------------------------------------- */

  function barsElement(site, count) {
    var wrap = document.createElement("div");
    wrap.className = "elf-bars";
    wrap.setAttribute("role", "img");

    var rows = daysFor(site, count);
    var bad = 0;
    rows.forEach(function (r) {
      if (r.mins) bad++;
      var bar = document.createElement("div");
      bar.className = "elf-bar";
      bar.setAttribute("data-tier", tierFor(r));
      // Hover detail only — deliberately NOT focusable. 90 bars per card
      // across 49 cards would put 4,410 tab stops ahead of the rest of the
      // page; the strip carries a summary aria-label instead.
      bar.setAttribute("data-tip", r.key + " UTC\n" + describe(r));
      wrap.appendChild(bar);
    });

    wrap.setAttribute(
      "aria-label",
      count + " day availability for " + site.name + ": " +
        (bad === 0 ? "no downtime recorded" : bad + " days with downtime")
    );
    return { el: wrap, daysWithDowntime: bad };
  }

  function axisElement(count, bad) {
    var ax = document.createElement("div");
    ax.className = "elf-axis";
    // The strip spans `count` days INCLUDING today, so the leftmost bar is
    // count-1 days ago. Buckets are UTC days, which is not necessarily the
    // reader's today — say so rather than quietly mislabel it.
    var left = document.createElement("span");
    left.textContent = "last " + count + " days";
    var mid = document.createElement("span");
    mid.textContent = bad === 0 ? "no downtime" : bad + " days with downtime";
    var right = document.createElement("span");
    right.textContent = "today (UTC)";
    ax.appendChild(left);
    ax.appendChild(mid);
    ax.appendChild(right);
    return ax;
  }

  /* Removes the bare text nodes around <span class="data">, leaving the figure
     alone. Upstream builds these from config.i18n, so the wording varies. */
  function stripLabels(container) {
    Array.prototype.slice.call(container.childNodes).forEach(function (node) {
      if (node.nodeType === 3) container.removeChild(node);
    });
  }

  /* Must be idempotent down to the attribute: this runs on every observer
     pass, and a remove()+add() of a class that's already correct still counts
     as two attribute mutations — which would retrigger the observer and spin
     the page at one pass per frame. Only touch the class list on a real
     change. */
  function gradeUptime(el) {
    var n = parseFloat(el.textContent);
    var want = isNaN(n) ? "" : n < 99 ? "elf-bad" : n < 99.9 ? "elf-warn" : "";
    var has = el.classList.contains("elf-bad")
      ? "elf-bad"
      : el.classList.contains("elf-warn") ? "elf-warn" : "";
    if (has === want) return;
    if (has) el.classList.remove(has);
    if (want) el.classList.add(want);
  }

  function slugFromCard(article) {
    var link = article.querySelector('h4 a[href*="/history/"]');
    if (!link) return null;
    var parts = link.getAttribute("href").split("/history/");
    return parts.length > 1 ? parts[1].replace(/[/#?].*$/, "") : null;
  }

  function enhanceCards() {
    var cards = document.querySelectorAll("section.live-status article");
    if (!cards.length) return false;

    Array.prototype.forEach.call(cards, function (article) {
      var slug = slugFromCard(article);
      if (!slug) return;
      var site = summary.find(function (s) { return s.slug === slug; });
      if (!site) return;

      // The uptime figure is the first <div>; the response-time line is the
      // second. Svelte re-renders these, so re-check every pass.
      var uptimeDiv = null;
      var divs = article.querySelectorAll(":scope > div");
      for (var i = 0; i < divs.length; i++) {
        if (divs[i].classList.contains("elf-bars") ||
            divs[i].classList.contains("elf-top")) continue;
        var data = divs[i].querySelector(".data");
        if (!data) continue;
        if (/ms\s*$/.test(data.textContent.trim())) {
          divs[i].remove();
        } else {
          gradeUptime(data);
          // Drop the "Overall uptime" label — a percentage beside a service
          // name on a status page needs no caption, and the range is already
          // named on the picker above.
          stripLabels(divs[i]);
          uptimeDiv = divs[i];
        }
      }

      // Put the name and the figure in one row, explicitly. Relying on
      // flex-wrap here means long service names shove the percentage onto its
      // own line, and the cards stop lining up.
      var head = article.querySelector(":scope > .elf-top");
      var h4 = article.querySelector(":scope > h4");
      if (!head && h4 && uptimeDiv) {
        head = document.createElement("div");
        head.className = "elf-top";
        article.insertBefore(head, h4);
        head.appendChild(h4);
        head.appendChild(uptimeDiv);
      }

      // Upstream sets --background to the response-time PNG inline; drop it so
      // nothing fetches an image we never show.
      article.style.removeProperty("--background");

      if (!startTimesOk) return; // see startTimesOk
      if (article.querySelector(".elf-bars")) return; // already done
      article.appendChild(barsElement(site, DAYS).el);
    });

    return true;
  }

  function localWindow() {
    var now = new Date();
    var start = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), GLOWUP_START_UTC_HOUR
    ));
    var end = new Date(start.getTime() + GLOWUP_DURATION_HOURS * 3600 * 1000);
    var fmt = function (d) {
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    };
    return fmt(start) + "–" + fmt(end);
  }

  /* The "Live Status" header row. Do NOT match on `.f.changed` — LiveStatus
     .svelte sets that class only until onMount fires, then removes it, so it
     exists for a few frames on first paint and never again. Anchor on the
     range picker instead, which is always there, and tag the row so the
     stylesheet has something stable to target too. */
  function statusHeader() {
    var form = document.querySelector("main.container form.r");
    if (!form) return null;
    var head = form.closest(".f") || form.parentElement;
    if (head && !head.classList.contains("elf-head")) head.classList.add("elf-head");
    return head;
  }

  function addGlowupNotice() {
    var head = statusHeader();
    if (!head || document.querySelector(".elf-glowup")) return;

    var box = document.createElement("div");
    box.className = "elf-glowup";
    box.innerHTML =
      '<b>Daily glow-up</b>' +
      '<span class="elf-when">' + localWindow() + " your time</span>" +
      '<span class="elf-note">We apply OS and app updates every day in this window. ' +
      "Services may restart briefly.</span>";
    head.parentNode.insertBefore(box, head);
  }

  function addLegend() {
    var head = statusHeader();
    if (!head || document.querySelector(".elf-legend")) return;

    var tiers = [
      ["up", "no downtime"],
      ["minor", "under 1% of the day"],
      ["major", "under 5%"],
      ["outage", "over 5%"],
      ["nodata", "not monitored"]
    ];
    var box = document.createElement("div");
    box.className = "elf-legend";
    box.innerHTML = tiers.map(function (t) {
      return '<span><i style="background:var(--elf-bar-' +
        (t[0] === "outage" ? "down" : t[0]) + ')"></i>' + t[1] + "</span>";
    }).join("") + "<span>each bar is one day · " + DAYS + " days</span>";
    head.parentNode.insertBefore(box, head.nextSibling);
  }

  /* --- service page ------------------------------------------------------ */

  function enhanceServicePage() {
    var match = window.location.pathname.match(/\/history\/([^/?#]+)/);
    if (!match) return;
    var site = summary.find(function (s) { return s.slug === match[1]; });
    if (!site) return;

    // Hide the response-time chart section (Graph.svelte renders a <canvas>).
    var canvas = document.querySelector("main.container canvas");
    if (canvas) {
      var section = canvas.closest("section");
      if (section) section.classList.add("elf-hide");
    }

    // Drop the "Average response time" row from the summary list.
    var dts = document.querySelectorAll("main.container dl dt");
    Array.prototype.forEach.call(dts, function (dt) {
      if (/response/i.test(dt.textContent)) {
        var dd = dt.nextElementSibling;
        dt.remove();
        if (dd && dd.tagName === "DD") dd.remove();
      }
    });

    // Sapper navigates client-side, and this section isn't owned by Svelte, so
    // route teardown leaves it behind. Without the slug check, moving from one
    // service to another shows the PREVIOUS service's availability under the
    // new service's name.
    if (!startTimesOk) return; // see startTimesOk

    var existing = document.querySelector("section[data-elf-slug]");
    if (existing) {
      if (existing.getAttribute("data-elf-slug") === site.slug) return;
      existing.remove();
    }

    var anchor = document.querySelector("main.container dl");
    if (!anchor) return;

    var built = barsElement(site, DAYS);
    var box = document.createElement("section");
    box.setAttribute("data-elf-slug", site.slug);
    var heading = document.createElement("h2");
    heading.textContent = "Availability";
    box.appendChild(heading);
    box.appendChild(built.el);
    box.appendChild(axisElement(DAYS, built.daysWithDowntime));
    anchor.parentNode.insertBefore(box, anchor.nextSibling);
  }

  /* --- incidents --------------------------------------------------------- */

  /* Upstream renders "🛑 Foo is down" + "Resolved after 172 minutes."; this
     rewrites each row to lead with the duration and drop the boilerplate. */
  function enhanceIncidents() {
    var articles = document.querySelectorAll("main.container article.down, main.container article.degraded");
    Array.prototype.forEach.call(articles, function (article) {
      if (article.classList.contains("elf-incident")) return;
      if (article.closest("section.live-status")) return;
      // ActiveIncidents/ActiveScheduled render ongoing events as
      // .down-active/.degraded-active. Those carry the scheduled window and
      // the live summary — the two things a visitor most needs during a
      // glow-up — and this function rebuilds innerHTML, which would destroy
      // them. Leave anything currently happening alone.
      if (article.classList.contains("down-active") ||
          article.classList.contains("degraded-active")) return;

      var h4 = article.querySelector("h4");
      var link = article.querySelector('a[href*="/incident/"]');
      if (!h4 || !link) return;

      var body = h4.parentNode;
      var minutesText = "";
      Array.prototype.forEach.call(body.querySelectorAll("div"), function (div) {
        var m = div.textContent.match(/(\d+)\s*minutes/);
        if (m) minutesText = m[1];
      });

      var mins = parseInt(minutesText, 10);
      var duration = isNaN(mins)
        ? ""
        : mins >= 60
          ? Math.floor(mins / 60) + "h " + (mins % 60) + "m"
          : mins + "m";

      var title = h4.textContent
        .replace(/\s+is down$/i, "")
        .replace(/\s+has degraded performance$/i, "")
        .trim();

      article.classList.add("elf-incident");
      article.innerHTML = "";

      if (duration) {
        var dur = document.createElement("span");
        dur.className = "elf-dur";
        dur.textContent = duration;
        article.appendChild(dur);
      }

      var name = document.createElement("h4");
      name.textContent = title;
      article.appendChild(name);

      var meta = document.createElement("a");
      meta.className = "elf-meta";
      meta.href = link.getAttribute("href");
      meta.textContent = link.textContent.replace(/[^#]*#/, "#").trim() || "report";
      article.appendChild(meta);
    });
  }

  /* --- run --------------------------------------------------------------- */

  function apply() {
    pending = false;
    if (!summary) return;
    try {
      var isHome = !!document.querySelector("section.live-status");
      if (isHome) {
        enhanceCards();
        addGlowupNotice();
        addLegend();
      }
      enhanceServicePage();
      enhanceIncidents();
    } catch (error) {
      // Never let a rendering bug take the page down with it.
      console.error("[elfhosted] availability enhancement failed", error);
    }
  }

  function schedule() {
    if (pending) return;
    pending = true;
    window.requestAnimationFrame(apply);
  }

  function start() {
    var observer = new MutationObserver(schedule);
    // The range picker updates existing text nodes in place rather than
    // rebuilding the card list, so childList alone would leave a card showing
    // last range's warning colour beside this range's percentage. Watching
    // characterData and style is safe because every mutation this script makes
    // is idempotent — see gradeUptime.
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["style"]
    });
    schedule();
  }

  Promise.all([
    fetch(SUMMARY_URL).then(function (res) { return res.json(); }),
    // Non-fatal, but without it no strip is drawn at all — see startTimesOk.
    fetch(START_TIMES_URL)
      .then(function (res) { return res.ok ? res.json() : {}; })
      .catch(function () { return {}; })
  ])
    .then(function (results) {
      summary = results[0];
      startTimes = results[1] || {};
      startTimesOk = Object.keys(startTimes).length > 0;
      if (document.body) start();
      else document.addEventListener("DOMContentLoaded", start);
    })
    .catch(function (error) {
      console.error("[elfhosted] could not load summary.json", error);
    });
})();
