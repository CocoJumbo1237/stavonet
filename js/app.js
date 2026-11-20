// Stavonet – objednávkový systém stavebnin (MVP).
// Katalog: data/katalog.json (skripty/strom.py ze skladových karet Money S3) – jen pro zobrazení.
// Produkt = [kód, název, MJ, cena bez DPH | null, cena s DPH | null, množství skladem, nadkategorie, kategorie, podkategorie]
// Účty, objednávky a výpočet cen: Supabase (RPC vytvor_objednavku počítá ceny na serveru). Košík je v localStorage.

const CONFIG = {
  dph: 21,
  supabaseUrl: "https://amtjxsvmtqgddzsnobfp.supabase.co",
  supabaseKey: "sb_publishable__vp8QYLb3ZtCxkM6SCvjIQ_E6zfdtBG", // veřejný klíč; data chrání RLS v databázi
  ucet: "",            // číslo účtu pro platbu převodem [doplnit]
  prodejna: "Prodejna Stavonet [adresa doplnit], Po–Pá 7:00–15:30",
};
const sb = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseKey);

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $("#app");
const PAGE = 48;

// ---------------------------------------------------------------- utility
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const r2 = (n) => Math.round(n * 100) / 100;
const kc = (n, dec) => n.toLocaleString("cs-CZ", { minimumFractionDigits: dec ? 2 : 0, maximumFractionDigits: dec ? 2 : 0 }) + " Kč";
const kcAuto = (n) => kc(n, n % 1 !== 0);
const num = (n) => n.toLocaleString("cs-CZ", { maximumFractionDigits: 3 });

const store = {
  get(k, d) { try { const v = localStorage.getItem("stanovet-" + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("stanovet-" + k, JSON.stringify(v)); } catch {} },
};

function icoOk(ico) {
  if (!/^\d{8}$/.test(ico)) return false;
  let s = 0;
  for (let i = 0; i < 7; i++) s += +ico[i] * (8 - i);
  const c = (11 - (s % 11)) % 10;
  return c === +ico[7];
}

let toastT;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("on"), 2400);
}

// ---------------------------------------------------------------- ikony nadkategorií
// klíče = slugy kategorií ze starého stavonet.cz (skripty/strom.py)
const ICONS = {
  "suche-maltove-smesi": '<path d="M6 4h12l-1 4H7z M7 8l-1 12h12L17 8"/><path d="M9 13h6"/>',
  "zatepleni-budov": '<path d="M3 5h18v14H3z M3 9h18 M3 13h18 M3 17h18"/>',
  "povrchove-upravy": '<path d="M4 4h12v5H4z M16 6h3v6h-8v3 M10 15h2v6h-2z"/>',
  "sanace-budov": '<path d="M3 21h18 M5 21V9l7-5 7 5v12"/><path d="M9 14c1-1 2 1 3 0s2 1 3 0"/>',
  "zdici-material": '<path d="M3 6h18v4H3zM3 14h18v4H3z M9 6v4 M15 10v4 M7 14v4 M15 14v4"/>',
  "sucha-vystavba": '<path d="M4 4h7v16H4z M13 4h7v16h-7z M7.5 4v16 M16.5 4v16"/>',
  "hutni-material": '<path d="M4 5h16 M4 19h16 M12 5v14 M8 5v2 M16 5v2 M8 19v-2 M16 19v-2"/>',
  "stavebni-chemie": '<path d="M9 3h6 M10 3v5L5 19a1.5 1.5 0 001.4 2h11.2A1.5 1.5 0 0019 19L14 8V3"/><path d="M7.5 14h9"/>',
  naradi: '<path d="M14 6a4 4 0 015 5l-9 9-5-5z M5 15l-2 6 6-2"/>',
  hydroizolace: '<path d="M12 3c4 5 6 8 6 11a6 6 0 01-12 0c0-3 2-6 6-11z"/>',
  zarubne: '<path d="M5 21V3h14v18 M3 21h18 M8 21V6h8v15"/>',
  kominy: '<path d="M8 21V6h8v15 M6 6h12V3H6z M3 21h18"/><path d="M10 10h4 M10 14h4"/>',
  parapety: '<path d="M4 4h16v10H4z M2 14h20v3H2z M12 4v10"/>',
};
const ico = (id, size = 24) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[id] || ICONS.naradi}</svg>`;

// ---------------------------------------------------------------- data
let STROM = [], P = [], byKod = new Map(), nadById = new Map(), searchIdx = [];
const katOf = (p) => nadById.get(p[6])?.kat.find((k) => k.slug === p[7]);

// ---------------------------------------------------------------- účty
let PROFIL = null; // profil přihlášeného uživatele z tabulky profily
const currentUser = () => PROFIL;
const isFirm = (u = PROFIL) => !!u && u.typ === "firma";
const firmOk = (u = PROFIL) => isFirm(u) && u.schvaleno;
const isAdmin = () => !!PROFIL?.je_admin;

async function loadProfile() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { PROFIL = null; return; }
  const { data } = await sb.from("profily").select("*").eq("id", session.user.id).maybeSingle();
  PROFIL = data || null;
}

function updateHeader() {
  const u = currentUser();
  $("#accLabel").textContent = u ? (u.firma || u.jmeno || u.email).split(" ").slice(0, 3).join(" ") : "Přihlášení";
  $("#accBtn").href = u ? "#/ucet" : "#/prihlaseni";
  $("#adminBtn").hidden = !isAdmin();
  const t = cartTotals();
  $("#cartCount").textContent = t.count;
  $("#cartTotal").textContent = isFirm() ? kc(t.bez) + " bez DPH" : kc(t.s);
}

// ---------------------------------------------------------------- ceny
function price(p) {
  const [, , , bez, s] = p;
  if (bez == null) return null;
  const sleva = firmOk() ? +currentUser().sleva || 0 : 0;
  // stejný výpočet jako na serveru (vytvor_objednavku): maloobchod s DPH zaokrouhlený na koruny
  const bezU = r2(bez * (1 - sleva / 100));
  const sU = sleva ? r2(bezU * (1 + CONFIG.dph / 100)) : Math.round(bez * (1 + CONFIG.dph / 100));
  return { bez: bezU, s: sU, sleva, listBez: bez, listS: s };
}

function priceHtml(p) {
  const c = price(p);
  const mj = esc(p[2]);
  if (!c) return `<div class="price ask"><div class="main">Cena na dotaz</div><div class="alt">nacenime v objednávce</div></div>`;
  const tag = c.sleva ? `<span class="yourprice">Vaše cena −${c.sleva} %</span>` : "";
  if (isFirm())
    return `<div class="price">${tag}<div class="main">${kcAuto(c.bez)} <small>/ ${mj} bez DPH</small>${c.sleva ? `<span class="old">${kcAuto(c.listBez)}</span>` : ""}</div><div class="alt">${kcAuto(c.s)} s DPH</div></div>`;
  return `<div class="price"><div class="main">${kcAuto(c.s)} <small>/ ${mj} s DPH</small></div><div class="alt">${kcAuto(c.bez)} bez DPH</div></div>`;
}

function stockHtml(p) {
  return p[5] > 0
    ? `<div class="stock">Skladem ${num(p[5])} ${esc(p[2])}</div>`
    : `<div class="stock no">Na objednávku</div>`;
}

// ---------------------------------------------------------------- košík
const cart = () => store.get("cart", {});
function setCart(c) { store.set("cart", c); updateHeader(); }
function addToCart(kod, qty) {
  const c = cart();
  c[kod] = r2((c[kod] || 0) + qty);
  setCart(c);
  toast(`Do košíku: ${qty} × ${byKod.get(kod)[1]}`);
}
function cartLines() {
  return Object.entries(cart()).filter(([k]) => byKod.has(k)).map(([k, q]) => {
    const p = byKod.get(k), c = price(p);
    return { p, q, c, bez: c ? r2(c.bez * q) : 0, s: c ? r2(c.s * q) : 0 };
  });
}
function cartTotals(lines = cartLines()) {
  return {
    count: lines.length,
    bez: r2(lines.reduce((a, l) => a + l.bez, 0)),
    s: r2(lines.reduce((a, l) => a + l.s, 0)),
    bezCeny: lines.filter((l) => !l.c).length,
  };
}

// ---------------------------------------------------------------- komponenty
function card(p) {
  const [kod, nazev, mj, , , , nad] = p;
  return `<article class="p">
    <a class="p-ico" href="#/p/${esc(kod)}" aria-hidden="true" tabindex="-1">${ico(nad, 36)}</a>
    <a class="p-name" href="#/p/${esc(kod)}">${esc(nazev)}</a>
    <div class="p-code">Kód ${esc(kod)}</div>
    ${stockHtml(p)}
    ${priceHtml(p)}
    <form class="buy" data-kod="${esc(kod)}">
      <input class="qty" type="number" min="0.001" step="any" value="1" aria-label="Množství v ${esc(mj)}">
      <button class="btn flex" type="submit">Do košíku</button>
    </form>
  </article>`;
}

function buildMega() {
  $("#mega").innerHTML = `<div class="mega-bar">${STROM.map((n) => `
    <div class="mega-item" data-id="${n.id}">
      <a href="#/k/${n.slug}">${esc(n.nazev)}</a>
      <div class="mega-panel"><div class="mega-panel-in">
        ${n.kat.map((k) => `<div><h4><a href="#/k/${n.slug}/${k.slug}">${esc(k.nazev)}</a></h4>
          ${k.pod.length ? `<ul>${k.pod.map((pd) => `<li><a href="#/k/${n.slug}/${k.slug}/${pd.slug}">${esc(pd.nazev)}</a></li>`).join("")}</ul>` : ""}</div>`).join("")}
        <div><h4><a href="#/k/${n.slug}">Vše: ${esc(n.nazev)} (${n.pocet}) →</a></h4></div>
      </div></div>
    </div>`).join("")}</div>`;
  const mobile = () => matchMedia("(max-width: 1000px)").matches;
  $$(".mega-item > a").forEach((a) => a.addEventListener("click", (e) => {
    if (!mobile()) return;
    e.preventDefault();
    a.parentElement.classList.toggle("exp");
  }));
  $("#mega").addEventListener("click", (e) => {
    if (e.target.closest(".mega-panel a")) { $("#mega").classList.remove("open"); }
  });
  $("#burger").onclick = () => {
    const open = $("#mega").classList.toggle("open");
    $("#burger").setAttribute("aria-expanded", open);
  };
}
function markMega(nadId) {
  $$(".mega-item").forEach((m) => m.classList.toggle("on", m.dataset.id === nadId));
}

// ---------------------------------------------------------------- stránky
function home() {
  markMega();
  const skladem = P.filter((p) => p[5] > 0).length;
  const u = currentUser();
  app.innerHTML = `
    <section class="hero">
      <h1>Stavebniny Stavonet</h1>
      <p>${P.length.toLocaleString("cs-CZ")} položek, z toho ${skladem.toLocaleString("cs-CZ")} skladem. Objednejte online s osobním odběrem nebo dovozem na stavbu.</p>
      <div class="btns">
        <a class="btn big" href="#/k/suche-maltove-smesi">Nakupovat</a>
        ${u ? "" : `<a class="btn big light" href="#/registrace?typ=firma">Registrace pro firmy</a>`}
      </div>
    </section>
    <div class="usp">
      <div><b>Osobní odběr</b>na prodejně, připravíme předem</div>
      <div><b>Doprava na stavbu</b>dovezeme materiál až na místo</div>
      <div><b>Firemní ceny</b>pro registrované firmy, platba na fakturu</div>
      <div><b>Poradíme</b>s výběrem materiálu i výpočtem množství</div>
    </div>
    <h2 class="section-title">Sortiment</h2>
    <div class="tiles">${STROM.map((n) => `
      <a class="tile" href="#/k/${n.slug}">
        <div class="tile-ico">${ico(n.id, 26)}</div>
        <div><h3>${esc(n.nazev)}</h3><small>${n.pocet.toLocaleString("cs-CZ")} položek</small></div>
        <ul>${n.kat.slice(0, 4).map((k) => `<li>${esc(k.nazev)}</li>`).join("")}</ul>
      </a>`).join("")}
    </div>
    ${isFirm() ? "" : `<section class="b2b">
      <div>
        <h2>Nakupujete pro firmu?</h2>
        <ul>
          <li>firemní ceny podle vašeho objemu</li>
          <li>ceny zobrazené bez DPH</li>
          <li>nákup na fakturu se splatností</li>
          <li>historie objednávek a opakovaný nákup jedním klikem</li>
        </ul>
        <a class="btn big" href="#/registrace?typ=firma">Založit firemní účet</a>
      </div>
      <div class="b2b-side" style="padding:30px 32px"><b>B2B</b><p style="margin:6px 0 0">Firemní účet ověří náš obchodník.</p></div>
    </section>`}
    <div style="height:40px"></div>`;
}

const listState = { sort: "dop", skladem: false, shown: PAGE };
function sortRows(rows) {
  const s = listState.sort;
  const pr = (p) => p[3] ?? null;
  if (s === "dop") return rows.slice().sort((a, b) => (b[5] > 0) - (a[5] > 0) || a[1].localeCompare(b[1], "cs"));
  if (s === "nazev") return rows.slice().sort((a, b) => a[1].localeCompare(b[1], "cs"));
  if (s === "levne") return rows.slice().sort((a, b) => (pr(a) ?? 1e12) - (pr(b) ?? 1e12));
  if (s === "drahe") return rows.slice().sort((a, b) => (pr(b) ?? -1) - (pr(a) ?? -1));
  return rows;
}

function listing({ title, crumbs, items, side, subtiles }) {
  let rows = items;
  if (listState.skladem) rows = rows.filter((p) => p[5] > 0);
  rows = sortRows(rows);
  app.innerHTML = `
    <div class="crumbs">${crumbs}</div>
    <div class="list-head"><h1>${esc(title)}</h1><span class="muted">${rows.length.toLocaleString("cs-CZ")} položek</span></div>
    ${subtiles || ""}
    <div class="layout" style="${side ? "" : "grid-template-columns:1fr"}">
      ${side || ""}
      <section>
        <div class="tools">
          <label>Řadit <select id="sort">
            <option value="dop">doporučené</option>
            <option value="nazev">podle názvu</option>
            <option value="levne">od nejlevnějšího</option>
            <option value="drahe">od nejdražšího</option>
          </select></label>
          <label class="chip"><input type="checkbox" id="skl" ${listState.skladem ? "checked" : ""}> Jen skladem</label>
        </div>
        ${rows.length ? `<div class="products">${rows.slice(0, listState.shown).map(card).join("")}</div>`
          : `<div class="empty">Nic jsme nenašli. Zkuste jiný výraz nebo nám zavolejte – zboží rádi objednáme.</div>`}
        ${rows.length > listState.shown ? `<div class="more"><button class="btn dark" id="more">Zobrazit další (${(rows.length - listState.shown).toLocaleString("cs-CZ")})</button></div>` : ""}
      </section>
    </div>`;
  $("#sort").value = listState.sort;
  $("#sort").onchange = (e) => { listState.sort = e.target.value; listState.shown = PAGE; route(); };
  $("#skl").onchange = (e) => { listState.skladem = e.target.checked; listState.shown = PAGE; route(); };
  const more = $("#more");
  if (more) more.onclick = () => { listState.shown += PAGE; route(true); };
}

function category(nadSlug, katSlug, podSlug) {
  const nad = nadById.get(nadSlug);
  if (!nad) return notFound();
  const kat = katSlug ? nad.kat.find((k) => k.slug === katSlug) : null;
  if (katSlug && !kat) return notFound();
  const pod = podSlug ? kat.pod.find((x) => x.slug === podSlug) : null;
  markMega(nad.id);
  const items = P.filter((p) => p[6] === nad.id && (!kat || p[7] === kat.slug) && (!pod || p[8] === pod.slug));
  const base = `#/k/${nad.slug}`;
  const crumbs = [`<a href="#/">Úvod</a>`, kat ? `<a href="${base}">${esc(nad.nazev)}</a>` : esc(nad.nazev)];
  if (kat) crumbs.push(pod ? `<a href="${base}/${kat.slug}">${esc(kat.nazev)}</a>` : esc(kat.nazev));
  if (pod) crumbs.push(esc(pod.nazev));

  const side = `<aside class="side">
    <div class="grp">${esc(nad.nazev)}</div>
    <a href="${base}" class="${kat ? "" : "on"}">Vše <span>${nad.pocet}</span></a>
    ${nad.kat.map((k) => `
      <a href="${base}/${k.slug}" class="${k === kat && !pod ? "on" : ""}">${esc(k.nazev)} <span>${k.pocet}</span></a>
      ${k === kat ? k.pod.map((x) => `<a class="sub ${x === pod ? "on" : ""}" href="${base}/${k.slug}/${x.slug}">${esc(x.nazev)} <span>${x.pocet}</span></a>`).join("") : ""}`).join("")}
  </aside>`;

  let subtiles = "";
  if (!kat) subtiles = `<div class="subtiles">${nad.kat.map((k) => `<a href="${base}/${k.slug}">${esc(k.nazev)}<span>${k.pocet}</span></a>`).join("")}</div>`;
  else if (kat.pod.length) subtiles = `<div class="subtiles"><a href="${base}/${kat.slug}" class="${pod ? "" : "on"}">Vše<span>${kat.pocet}</span></a>${kat.pod.map((x) => `<a href="${base}/${kat.slug}/${x.slug}" class="${x === pod ? "on" : ""}">${esc(x.nazev)}<span>${x.pocet}</span></a>`).join("")}</div>`;

  listing({ title: (pod || kat || nad).nazev, crumbs: crumbs.join(" / "), items, side, subtiles });
}

function search(q) {
  markMega();
  $("#q").value = q;
  const terms = norm(q).split(/\s+/).filter(Boolean);
  const items = terms.length ? P.filter((p, i) => terms.every((t) => searchIdx[i].includes(t))) : [];
  listing({ title: `Hledání: ${q}`, crumbs: `<a href="#/">Úvod</a> / Hledání`, items });
}

function product(kod) {
  const p = byKod.get(kod);
  if (!p) return notFound();
  const [, nazev, mj, , , sklad, nadId] = p;
  const nad = nadById.get(nadId), kat = katOf(p), pod = kat?.pod.find((x) => x.slug === p[8]);
  markMega(nadId);
  const base = `#/k/${nad.slug}`;
  const related = P.filter((x) => x !== p && x[6] === p[6] && x[7] === p[7] && x[8] === p[8]).sort((a, b) => (b[5] > 0) - (a[5] > 0)).slice(0, 8);
  app.innerHTML = `
    <div class="crumbs"><a href="#/">Úvod</a> / <a href="${base}">${esc(nad.nazev)}</a>${kat ? ` / <a href="${base}/${kat.slug}">${esc(kat.nazev)}</a>` : ""}${pod ? ` / <a href="${base}/${kat.slug}/${pod.slug}">${esc(pod.nazev)}</a>` : ""}</div>
    <div class="pd">
      <div class="pd-img">${ico(nadId, 120)}</div>
      <div>
        <h1>${esc(nazev)}</h1>
        <div class="box">
          ${stockHtml(p)}
          ${priceHtml(p)}
          <form class="buy" data-kod="${esc(kod)}">
            <input class="qty" type="number" min="0.001" step="any" value="1" aria-label="Množství v ${esc(mj)}">
            <span style="align-self:center" class="muted">${esc(mj)}</span>
            <button class="btn flex big" type="submit">Do košíku</button>
          </form>
          ${sklad > 0 ? "" : `<p class="note">Zboží objednáme u dodavatele, termín dodání potvrdíme.</p>`}
          <table class="facts">
            <tr><td>Kód zboží</td><td>${esc(kod)}</td></tr>
            <tr><td>Měrná jednotka</td><td>${esc(mj)}</td></tr>
            <tr><td>Kategorie</td><td>${esc(nad.nazev)}${kat ? " › " + esc(kat.nazev) : ""}${pod ? " › " + esc(pod.nazev) : ""}</td></tr>
            <tr><td>Sazba DPH</td><td>${CONFIG.dph} %</td></tr>
          </table>
        </div>
      </div>
    </div>
    ${related.length ? `<h2 class="section-title">Podobné zboží</h2><div class="products">${related.map(card).join("")}</div>` : ""}
    <div style="height:40px"></div>`;
}

function cartPage() {
  markMega();
  const lines = cartLines();
  const t = cartTotals(lines);
  const firm = isFirm();
  if (!lines.length) {
    app.innerHTML = `<div class="crumbs"><a href="#/">Úvod</a> / Košík</div><div class="list-head"><h1>Košík</h1></div>
      <div class="empty" style="margin:18px 0 40px">Košík je prázdný. <a href="#/">Pokračovat v nákupu</a></div>`;
    return;
  }
  app.innerHTML = `
    <div class="crumbs"><a href="#/">Úvod</a> / Košík</div>
    <div class="list-head"><h1>Košík</h1></div>
    <div class="cols">
      <div>
        <table class="items">
          <thead><tr><th>Zboží</th><th class="num">Množství</th><th class="num">Cena / MJ ${firm ? "bez DPH" : "s DPH"}</th><th class="num">Celkem</th><th></th></tr></thead>
          <tbody>${lines.map(({ p, q, c, bez, s }) => `<tr>
            <td><a href="#/p/${esc(p[0])}"><strong>${esc(p[1])}</strong></a><br><span class="note">Kód ${esc(p[0])} · ${p[5] >= q ? "skladem" : p[5] > 0 ? `skladem ${num(p[5])} ${esc(p[2])}, zbytek objednáme` : "na objednávku"}</span></td>
            <td class="num"><input class="qty" type="number" min="0.001" step="any" value="${q}" data-kod="${esc(p[0])}"> ${esc(p[2])}</td>
            <td class="num">${c ? kcAuto(firm ? c.bez : c.s) : "na dotaz"}</td>
            <td class="num"><strong>${c ? kc(firm ? bez : s, true) : "–"}</strong></td>
            <td><button class="x" data-del="${esc(p[0])}" aria-label="Odebrat">×</button></td>
          </tr>`).join("")}</tbody>
        </table>
        <p style="margin-top:10px"><a href="#/">← Pokračovat v nákupu</a></p>
      </div>
      <div class="box">
        <h2>Souhrn</h2>
        ${sumTable(t)}
        ${t.bezCeny ? `<p class="note">${t.bezCeny} ${t.bezCeny === 1 ? "položka nemá" : "položky nemají"} cenu na webu – doplníme ji v potvrzení objednávky.</p>` : ""}
        <a class="btn big" style="width:100%;margin-top:12px" href="#/pokladna">Pokračovat k objednávce</a>
        ${currentUser() ? "" : `<p class="note" style="margin-top:10px">Máte firemní účet? <a href="#/prihlaseni?zpet=kosik">Přihlaste se</a> pro firemní ceny.</p>`}
      </div>
    </div>`;
  $$("input.qty[data-kod]").forEach((i) => (i.onchange = () => {
    const c = cart(); const v = r2(+i.value);
    if (v > 0) c[i.dataset.kod] = v; else delete c[i.dataset.kod];
    setCart(c); cartPage();
  }));
  $$("[data-del]").forEach((b) => (b.onclick = () => { const c = cart(); delete c[b.dataset.del]; setCart(c); cartPage(); }));
}

function sumTable(t, extra = "") {
  const dph = r2(t.s - t.bez);
  return `<table class="sum">
    <tr><td>Zboží bez DPH</td><td>${kc(t.bez, true)}</td></tr>
    <tr><td>DPH ${CONFIG.dph} %</td><td>${kc(dph, true)}</td></tr>
    ${extra}
    <tr class="total"><td>Celkem s DPH</td><td>${kc(t.s, true)}</td></tr>
  </table>`;
}

// ---------------------------------------------------------------- pokladna
const DOPRAVA = [
  { id: "odber", nazev: "Osobní odběr na prodejně", popis: CONFIG.prodejna + " – připravíme a pošleme SMS", cena: "zdarma" },
  { id: "doprava", nazev: "Doprava na stavbu", popis: "Cenu podle vzdálenosti a hmotnosti potvrdíme.", cena: "dle dohody" },
];
const PLATBA = [
  { id: "prodejna", nazev: "Hotově nebo kartou při převzetí", popis: "Na prodejně nebo řidiči při dovozu" },
  { id: "prevod", nazev: "Bankovním převodem předem", popis: "Platební údaje a QR kód dostanete po odeslání objednávky" },
  { id: "faktura", nazev: "Na fakturu", popis: "Pro ověřené firemní zákazníky", jenFirma: true },
];

function checkout() {
  markMega();
  const lines = cartLines();
  if (!lines.length) { location.hash = "#/kosik"; return; }
  const u = currentUser() || {};
  const firm = firmOk();
  const t = cartTotals(lines);
  app.innerHTML = `
    <div class="crumbs"><a href="#/">Úvod</a> / <a href="#/kosik">Košík</a> / Objednávka</div>
    <div class="list-head"><h1>Dokončení objednávky</h1></div>
    ${currentUser() ? "" : `<p class="muted">Nakupujete bez přihlášení. <a href="#/prihlaseni?zpet=pokladna">Přihlásit se</a> nebo pokračujte jako host.</p>`}
    <form class="cols" id="co" novalidate>
      <div class="steps">
        <div class="box step"><h2><i>1</i>Doprava</h2>
          ${DOPRAVA.map((d, i) => `<label class="opt"><input type="radio" name="doprava" value="${d.id}" ${i === 0 ? "checked" : ""}><div><b>${esc(d.nazev)}</b><span>${esc(d.popis)}</span></div><div class="r">${esc(d.cena)}</div></label>`).join("")}
          <div id="adrStavby" class="form" style="margin-top:8px;display:none">
            <label class="full">Adresa stavby / místo vykládky *<input name="stavba" placeholder="Ulice, obec, PSČ"></label>
            <label class="full">Pokyny pro řidiče<input name="ridic" placeholder="např. příjezd jen pro auto do 12 t, vykládka rukou"></label>
          </div>
        </div>
        <div class="box step"><h2><i>2</i>Platba</h2>
          ${PLATBA.map((pl) => {
            const dis = pl.jenFirma && !firm;
            return `<label class="opt ${dis ? "dis" : ""}"><input type="radio" name="platba" value="${pl.id}" ${pl.id === "prodejna" ? "checked" : ""} ${dis ? "disabled" : ""}><div><b>${esc(pl.nazev)}</b><span>${esc(pl.popis)}${pl.id === "faktura" && firm ? ` – splatnost ${u.splatnost || 14} dní` : ""}${dis ? (isFirm() ? " – po ověření účtu" : " – nutný firemní účet") : ""}</span></div></label>`;
          }).join("")}
        </div>
        <div class="box step"><h2><i>3</i>Kontaktní a fakturační údaje</h2>
          <div class="form">
            <label>Jméno a příjmení *<input name="jmeno" required value="${esc(u.jmeno)}" autocomplete="name"></label>
            <label>Telefon *<input name="telefon" type="tel" required value="${esc(u.telefon)}" autocomplete="tel"></label>
            <label class="full">E-mail *<input name="email" type="email" required value="${esc(u.email)}" autocomplete="email"></label>
            <label class="full">Firma<input name="firma" value="${esc(u.firma)}" autocomplete="organization"></label>
            <label>IČ<input name="ico" inputmode="numeric" value="${esc(u.ico)}"></label>
            <label>DIČ<input name="dic" value="${esc(u.dic)}"></label>
            <label class="full">Ulice a č. p. *<input name="ulice" required value="${esc(u.ulice)}" autocomplete="street-address"></label>
            <label>Obec *<input name="mesto" required value="${esc(u.mesto)}" autocomplete="address-level2"></label>
            <label>PSČ *<input name="psc" required value="${esc(u.psc)}" inputmode="numeric" autocomplete="postal-code"></label>
            <label class="full">Poznámka k objednávce<textarea name="poznamka" placeholder="Termín, číslo zakázky, další požadavky…"></textarea></label>
          </div>
        </div>
      </div>
      <div class="box" style="position:sticky;top:140px">
        <h2>Souhrn</h2>
        <p class="muted" style="margin-top:-6px">${lines.length} ${lines.length === 1 ? "položka" : lines.length < 5 ? "položky" : "položek"}</p>
        ${sumTable(t, `<tr><td>Doprava</td><td id="sDoprava">zdarma</td></tr>`)}
        ${t.bezCeny ? `<p class="note">+ ${t.bezCeny} bez ceny – doplníme v potvrzení.</p>` : ""}
        <label class="check"><input type="checkbox" name="vop" required> <span>Souhlasím s obchodními podmínkami <em>[doplnit]</em> a se zpracováním osobních údajů.</span></label>
        <div class="err" id="coErr"></div>
        <button class="btn big" style="width:100%" type="submit">Odeslat objednávku</button>
      </div>
    </form>`;

  const f = $("#co");
  const sync = () => {
    const d = f.doprava.value;
    $("#adrStavby").style.display = d === "doprava" ? "grid" : "none";
    $("#sDoprava").textContent = d === "doprava" ? "dle dohody" : "zdarma";
  };
  f.addEventListener("change", sync);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    const chyby = [];
    for (const [k, n] of [["jmeno", "jméno"], ["telefon", "telefon"], ["email", "e-mail"], ["ulice", "ulice"], ["mesto", "obec"], ["psc", "PSČ"]]) if (!String(v[k] || "").trim()) chyby.push(n);
    if (v.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) chyby.push("platný e-mail");
    if (v.doprava === "doprava" && !String(v.stavba || "").trim()) chyby.push("adresa stavby");
    if (v.ico && !icoOk(v.ico.trim())) chyby.push("platné IČ");
    if (!v.vop) chyby.push("souhlas s obchodními podmínkami");
    if (!v.platba) chyby.push("způsob platby");
    if (chyby.length) { $("#coErr").textContent = "Doplňte prosím: " + chyby.join(", ") + "."; return; }
    const btn = f.querySelector("button[type=submit]");
    btn.disabled = true; btn.textContent = "Odesílám…";
    try {
      const o = await createOrder(v, lines);
      location.hash = `#/objednavka/${o.cislo}`;
    } catch (err) {
      btn.disabled = false; btn.textContent = "Odeslat objednávku";
      $("#coErr").textContent = "Objednávku se nepodařilo odeslat: " + err.message;
    }
  };
}

// Objednávka se zakládá na serveru (ceny a slevu počítá databáze), pak se pošlou e-maily.
async function createOrder(v, lines) {
  const payload = {
    doprava: v.doprava, platba: v.platba,
    kontakt: { jmeno: v.jmeno, telefon: v.telefon, email: v.email, firma: v.firma, ico: v.ico, dic: v.dic, ulice: v.ulice, mesto: v.mesto, psc: v.psc },
    stavba: v.stavba || "", ridic: v.ridic || "", poznamka: v.poznamka || "",
    polozky: lines.map(({ p, q }) => ({ kod: p[0], nazev: p[1], mnozstvi: q })),
  };
  const { data, error } = await sb.rpc("vytvor_objednavku", { p: payload });
  if (error) throw new Error(error.message);
  // potvrzení zobrazíme i hostovi (nemá přístup k tabulce objednávek)
  const moje = store.get("moje-objednavky", {});
  moje[data.cislo] = data;
  store.set("moje-objednavky", moje);
  setCart({});
  sb.functions.invoke("objednavka-email", { body: { cislo: data.cislo } }).catch(() => {});
  return data;
}

async function fetchOrder(cislo) {
  if (currentUser()) {
    const { data } = await sb.from("objednavky").select("*, polozky:objednavky_polozky(*)").eq("cislo", cislo).maybeSingle();
    if (data) { data.polozky.sort((a, b) => a.id - b.id); return data; }
  }
  return store.get("moje-objednavky", {})[cislo] || null;
}

const STAVY = ["nová", "čeká na platbu", "zaplaceno", "vyřizuje se", "připraveno k odběru", "na cestě", "dokončeno", "zrušeno"];
const stavBadge = (s) => `<span class="badge ${["zaplaceno", "dokončeno", "připraveno k odběru"].includes(s) ? "ok" : ["čeká na platbu", "nová"].includes(s) ? "warn" : ""}">${esc(s)}</span>`;
const loading = () => { app.innerHTML = `<div class="empty" style="margin:30px 0">Načítám…</div>`; };

async function orderPage(cislo) {
  markMega();
  loading();
  const o = await fetchOrder(cislo);
  if (!o) return notFound();
  const pl = PLATBA.find((x) => x.id === o.platba), dop = DOPRAVA.find((x) => x.id === o.doprava);
  let platbaInfo = "";
  if (o.platba === "prevod") platbaInfo = `<div class="box" style="margin-top:14px"><h2>Platba převodem</h2>
      <table class="sum"><tr><td>Číslo účtu</td><td>${esc(CONFIG.ucet || "[doplnit]")}</td></tr><tr><td>Variabilní symbol</td><td><b>${esc(o.cislo)}</b></td></tr><tr><td>Částka</td><td><b>${kc(+o.s, true)}</b></td></tr></table>
      <p class="note">Objednávku vyřídíme po připsání platby.${o.doprava === "doprava" ? " Cenu dopravy vám pošleme zvlášť." : ""}</p></div>`;
  if (o.platba === "faktura") platbaInfo = `<p>Fakturu se splatností ${o.splatnost} dní pošleme e-mailem po vyřízení objednávky.</p>`;
  app.innerHTML = `
    <div class="crumbs"><a href="#/">Úvod</a> / Objednávka ${esc(o.cislo)}</div>
    <div class="list-head"><h1>Objednávka ${esc(o.cislo)}</h1></div>
    <div class="cols">
      <div>
        <p>Děkujeme. Potvrzení posíláme na <b>${esc(o.kontakt.email)}</b>. ${o.doprava === "odber" ? "Až bude zboží připravené k odběru, dáme vám vědět." : "Termín a cenu dopravy vám potvrdíme telefonicky."}</p>
        ${platbaInfo}
        <h2 class="section-title" style="font-size:24px">Položky</h2>
        ${orderItems(o)}
      </div>
      <div class="box">
        <h2>Shrnutí</h2>
        <table class="sum">
          <tr><td>Stav</td><td>${stavBadge(o.stav)}</td></tr>
          <tr><td>Datum</td><td>${new Date(o.vytvoreno).toLocaleString("cs-CZ")}</td></tr>
          <tr><td>Doprava</td><td>${esc(dop?.nazev)}</td></tr>
          ${o.stavba ? `<tr><td>Místo</td><td>${esc(o.stavba)}</td></tr>` : ""}
          <tr><td>Platba</td><td>${esc(pl?.nazev)}</td></tr>
          ${+o.sleva ? `<tr><td>Firemní sleva</td><td>${+o.sleva} %</td></tr>` : ""}
          <tr><td>Bez DPH</td><td>${kc(+o.bez, true)}</td></tr>
          <tr><td>DPH</td><td>${kc(+o.dph, true)}</td></tr>
          <tr class="total"><td>Celkem s DPH</td><td>${kc(+o.s, true)}</td></tr>
        </table>
        ${o.bez_ceny ? `<p class="note">${o.bez_ceny} položek bez ceny – doplníme v potvrzení.</p>` : ""}
        <a class="btn ghost" style="width:100%;margin-top:14px" href="#/">Zpět do obchodu</a>
      </div>
    </div>`;
}

function orderItems(o) {
  return `<table class="items"><thead><tr><th>Zboží</th><th class="num">Množství</th><th class="num">Cena / MJ bez DPH</th><th class="num">Celkem bez DPH</th></tr></thead><tbody>
    ${o.polozky.map((i) => `<tr><td>${esc(i.nazev)}<br><span class="note">Kód ${esc(i.kod)}</span></td><td class="num">${num(+i.mnozstvi)} ${esc(i.mj)}</td><td class="num">${i.cena_bez != null ? kcAuto(+i.cena_bez) : "na dotaz"}</td><td class="num">${i.bez != null ? kc(+i.bez, true) : "–"}</td></tr>`).join("")}
  </tbody></table>`;
}

// ---------------------------------------------------------------- účet
function loginPage(params) {
  markMega();
  if (currentUser()) { location.hash = "#/ucet"; return; }
  app.innerHTML = `<div class="auth box">
    <h1 style="font-size:34px;margin:0 0 6px">Přihlášení</h1>
    <p class="muted" style="margin-top:0">Pro zákazníky i firmy. Firmy po přihlášení vidí své ceny.</p>
    <form class="form" id="lf">
      <label class="full">E-mail<input name="email" type="email" required autocomplete="username"></label>
      <label class="full">Heslo<input name="heslo" type="password" required autocomplete="current-password"></label>
      <div class="err full" id="lErr"></div>
      <button class="btn big full" type="submit">Přihlásit</button>
    </form>
    <p>Nemáte účet? <a href="#/registrace">Registrovat</a> · <a href="#/registrace?typ=firma">Firemní účet</a></p>
  </div>`;
  $("#lf").onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    const btn = e.target.querySelector("button"); btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: v.email.trim(), password: v.heslo });
    btn.disabled = false;
    if (error) { $("#lErr").textContent = /confirm/i.test(error.message) ? "E-mail ještě není potvrzený – klikněte na odkaz v e-mailu." : "Nesprávný e-mail nebo heslo."; return; }
    await loadProfile();
    updateHeader();
    toast(`Přihlášeno: ${PROFIL?.firma || PROFIL?.jmeno || v.email}`);
    const zpet = params.get("zpet");
    location.hash = zpet === "kosik" ? "#/kosik" : zpet === "pokladna" ? "#/pokladna" : isAdmin() ? "#/admin" : "#/ucet";
  };
}

function registerPage(params) {
  markMega();
  let typ = params.get("typ") === "firma" ? "firma" : "osoba";
  const draw = () => {
    app.innerHTML = `<div class="auth box" style="max-width:640px">
      <h1 style="font-size:34px;margin:0 0 10px">Registrace</h1>
      <div class="seg"><button type="button" data-t="osoba" class="${typ === "osoba" ? "on" : ""}">Soukromá osoba</button><button type="button" data-t="firma" class="${typ === "firma" ? "on" : ""}">Firma / živnostník</button></div>
      ${typ === "firma" ? `<p class="note" style="margin-top:0">Po ověření firmy vám nastavíme firemní ceny a povolíme nákup na fakturu.</p>` : ""}
      <form class="form" id="rf" novalidate>
        ${typ === "firma" ? `
          <label class="full">Název firmy *<input name="firma" required autocomplete="organization"></label>
          <label>IČ *<input name="ico" required inputmode="numeric" maxlength="8"></label>
          <label>DIČ<input name="dic" placeholder="CZ…"></label>` : ""}
        <label>Jméno a příjmení *<input name="jmeno" required autocomplete="name"></label>
        <label>Telefon *<input name="telefon" type="tel" required autocomplete="tel"></label>
        <label class="full">Ulice a č. p. *<input name="ulice" required autocomplete="street-address"></label>
        <label>Obec *<input name="mesto" required autocomplete="address-level2"></label>
        <label>PSČ *<input name="psc" required inputmode="numeric" autocomplete="postal-code"></label>
        <label class="full">E-mail *<input name="email" type="email" required autocomplete="username"></label>
        <label>Heslo * (min. 8 znaků)<input name="heslo" type="password" required minlength="8" autocomplete="new-password"></label>
        <label>Heslo znovu *<input name="heslo2" type="password" required autocomplete="new-password"></label>
        <label class="check full"><input type="checkbox" name="vop"> <span>Souhlasím s obchodními podmínkami a zpracováním osobních údajů.</span></label>
        <div class="err full" id="rErr"></div>
        <button class="btn big full" type="submit">Vytvořit účet</button>
      </form>
      <p>Máte účet? <a href="#/prihlaseni">Přihlásit se</a></p>
    </div>`;
    $$(".seg button").forEach((b) => (b.onclick = () => { typ = b.dataset.t; draw(); }));
    $("#rf").onsubmit = async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(e.target));
      const email = (v.email || "").trim().toLowerCase();
      const ch = [];
      const req = ["jmeno", "telefon", "ulice", "mesto", "psc"].concat(typ === "firma" ? ["firma", "ico"] : []);
      if (req.some((k) => !String(v[k] || "").trim())) ch.push("vyplňte povinná pole");
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) ch.push("zadejte platný e-mail");
      if (typ === "firma" && v.ico && !icoOk(v.ico.trim())) ch.push("IČ není platné");
      if ((v.heslo || "").length < 8) ch.push("heslo musí mít aspoň 8 znaků");
      if (v.heslo !== v.heslo2) ch.push("hesla se neshodují");
      if (!v.vop) ch.push("potvrďte souhlas s podmínkami");
      if (ch.length) { $("#rErr").textContent = ch.join(", ") + "."; return; }
      const meta = { typ, jmeno: v.jmeno.trim(), telefon: v.telefon.trim(), ulice: v.ulice.trim(), mesto: v.mesto.trim(), psc: v.psc.trim() };
      if (typ === "firma") Object.assign(meta, { firma: v.firma.trim(), ico: v.ico.trim(), dic: (v.dic || "").trim() });
      const btn = e.target.querySelector("button[type=submit]"); btn.disabled = true;
      const { data, error } = await sb.auth.signUp({ email, password: v.heslo, options: { data: meta, emailRedirectTo: location.origin + location.pathname + "#/ucet" } });
      btn.disabled = false;
      if (error) { $("#rErr").textContent = /registered|exists/i.test(error.message) ? "Účet s tímto e-mailem už existuje." : "Registrace se nezdařila: " + error.message; return; }
      if (!data.session) {
        app.innerHTML = `<div class="auth box"><h1 style="font-size:32px;margin:0 0 8px">Potvrďte e-mail</h1><p>Na <b>${esc(email)}</b> jsme poslali odkaz pro potvrzení registrace. Po potvrzení se můžete přihlásit.</p></div>`;
        return;
      }
      await loadProfile();
      updateHeader();
      toast("Účet je vytvořený.");
      location.hash = "#/ucet";
    };
  };
  draw();
}

async function accountPage() {
  markMega();
  const u = currentUser();
  if (!u) { location.hash = "#/prihlaseni"; return; }
  loading();
  const { data: orders = [] } = await sb.from("objednavky").select("cislo, vytvoreno, stav, bez, s").eq("user_id", u.id).order("vytvoreno", { ascending: false });
  app.innerHTML = `
    <div class="crumbs"><a href="#/">Úvod</a> / Můj účet</div>
    <div class="list-head"><h1>${esc(u.firma || u.jmeno || u.email)}</h1><button class="btn ghost" id="logout">Odhlásit</button></div>
    <div class="cols">
      <div>
        <h2 class="section-title" style="margin-top:14px;font-size:26px">Moje objednávky</h2>
        ${orders.length ? `<table class="items"><thead><tr><th>Číslo</th><th>Datum</th><th>Stav</th><th class="num">Celkem ${isFirm(u) ? "bez DPH" : "s DPH"}</th><th></th></tr></thead><tbody>
          ${orders.map((o) => `<tr>
            <td><a href="#/objednavka/${esc(o.cislo)}"><b>${esc(o.cislo)}</b></a></td>
            <td>${new Date(o.vytvoreno).toLocaleDateString("cs-CZ")}</td>
            <td>${stavBadge(o.stav)}</td>
            <td class="num">${kc(+(isFirm(u) ? o.bez : o.s), true)}</td>
            <td class="num"><button class="btn ghost" data-re="${esc(o.cislo)}">Objednat znovu</button></td>
          </tr>`).join("")}</tbody></table>`
          : `<div class="empty">Zatím žádné objednávky. <a href="#/">Jít nakupovat</a></div>`}
      </div>
      <div class="box">
        <h2>Údaje účtu</h2>
        ${isFirm(u) ? `<p>${u.schvaleno ? `<span class="badge ok">Ověřená firma</span>` : `<span class="badge warn">Čeká na ověření</span>`}</p>` : ""}
        <table class="sum">
          ${isFirm(u) ? `<tr><td>IČ / DIČ</td><td>${esc(u.ico)} / ${esc(u.dic || "–")}</td></tr>
            <tr><td>Firemní sleva</td><td>${u.schvaleno ? `${+u.sleva} %` : "po ověření"}</td></tr>
            <tr><td>Platba na fakturu</td><td>${u.schvaleno ? `splatnost ${u.splatnost} dní` : "po ověření"}</td></tr>` : ""}
          <tr><td>Kontakt</td><td>${esc(u.jmeno)}</td></tr>
          <tr><td>E-mail</td><td>${esc(u.email)}</td></tr>
          <tr><td>Telefon</td><td>${esc(u.telefon)}</td></tr>
          <tr><td>Adresa</td><td>${esc(u.ulice)}, ${esc(u.psc)} ${esc(u.mesto)}</td></tr>
        </table>
        ${isFirm(u) && !u.schvaleno ? `<p class="note">Firemní účet zkontroluje obchodník a nastaví vám ceny. Do té doby nakupujete za běžné ceny.</p>` : ""}
      </div>
    </div>`;
  $("#logout").onclick = async () => { await sb.auth.signOut(); PROFIL = null; updateHeader(); toast("Odhlášeno."); location.hash = "#/"; };
  $$("[data-re]").forEach((b) => (b.onclick = async () => {
    const o = await fetchOrder(b.dataset.re);
    const c = cart();
    let n = 0;
    for (const i of o.polozky) if (byKod.has(i.kod)) { c[i.kod] = r2((c[i.kod] || 0) + +i.mnozstvi); n++; }
    setCart(c);
    toast(`Do košíku přidáno ${n} položek z objednávky ${o.cislo}.`);
    location.hash = "#/kosik";
  }));
}

// ---------------------------------------------------------------- administrace
const adminNav = (on) => `<div class="subtiles" style="margin-top:4px">
  <a href="#/admin" class="${on === "o" ? "on" : ""}">Objednávky</a>
  <a href="#/admin/firmy" class="${on === "f" ? "on" : ""}">Zákazníci a firmy</a></div>`;

async function adminOrders(params) {
  markMega();
  if (!isAdmin()) return notFound();
  loading();
  const stav = params.get("stav") || "";
  const q = (params.get("q") || "").trim();
  let query = sb.from("objednavky").select("cislo, vytvoreno, stav, doprava, platba, kontakt, s, bez, sleva").order("vytvoreno", { ascending: false }).limit(200);
  if (stav) query = query.eq("stav", stav);
  if (q) query = /^\d+$/.test(q) ? query.like("cislo", `%${q}%`) : query.or(`kontakt->>jmeno.ilike.%${q}%,kontakt->>firma.ilike.%${q}%,kontakt->>email.ilike.%${q}%`);
  const { data: orders = [], error } = await query;
  app.innerHTML = `
    <div class="crumbs"><a href="#/">Úvod</a> / Administrace</div>
    <div class="list-head"><h1>Objednávky</h1></div>
    ${adminNav("o")}
    <form class="tools" id="af" style="margin-top:14px">
      <select name="stav"><option value="">Všechny stavy</option>${STAVY.map((s) => `<option ${s === stav ? "selected" : ""}>${s}</option>`).join("")}</select>
      <input type="text" name="q" value="${esc(q)}" placeholder="Číslo, jméno, firma, e-mail">
      <button class="btn dark" type="submit">Filtrovat</button>
    </form>
    ${error ? `<div class="empty">${esc(error.message)}</div>` : orders.length ? `<table class="items"><thead><tr><th>Číslo</th><th>Datum</th><th>Zákazník</th><th>Doprava / platba</th><th>Stav</th><th class="num">Celkem s DPH</th></tr></thead><tbody>
      ${orders.map((o) => `<tr>
        <td><a href="#/admin/o/${esc(o.cislo)}"><b>${esc(o.cislo)}</b></a></td>
        <td>${new Date(o.vytvoreno).toLocaleString("cs-CZ", { dateStyle: "short", timeStyle: "short" })}</td>
        <td>${esc(o.kontakt.firma || o.kontakt.jmeno)}<br><span class="note">${esc(o.kontakt.telefon)}</span></td>
        <td>${esc(DOPRAVA.find((d) => d.id === o.doprava)?.nazev)}<br><span class="note">${esc(PLATBA.find((p) => p.id === o.platba)?.nazev)}</span></td>
        <td>${stavBadge(o.stav)}</td>
        <td class="num">${kc(+o.s, true)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="empty">Žádné objednávky.</div>`}
    <div style="height:40px"></div>`;
  $("#af").onsubmit = (e) => {
    e.preventDefault();
    const v = new URLSearchParams(new FormData(e.target));
    location.hash = "#/admin?" + v.toString();
  };
}

async function adminOrder(cislo) {
  markMega();
  if (!isAdmin()) return notFound();
  loading();
  const o = await fetchOrder(cislo);
  if (!o) return notFound();
  const k = o.kontakt;
  app.innerHTML = `
    <div class="crumbs"><a href="#/">Úvod</a> / <a href="#/admin">Administrace</a> / ${esc(o.cislo)}</div>
    <div class="list-head"><h1>Objednávka ${esc(o.cislo)}</h1><span class="muted">${new Date(o.vytvoreno).toLocaleString("cs-CZ")}</span></div>
    <div class="cols">
      <div>
        ${orderItems(o)}
        <table class="sum" style="margin-top:12px;max-width:340px;margin-left:auto">
          ${+o.sleva ? `<tr><td>Firemní sleva</td><td>${+o.sleva} %</td></tr>` : ""}
          <tr><td>Bez DPH</td><td>${kc(+o.bez, true)}</td></tr><tr><td>DPH</td><td>${kc(+o.dph, true)}</td></tr>
          <tr class="total"><td>Celkem s DPH</td><td>${kc(+o.s, true)}</td></tr>
        </table>
        ${o.poznamka ? `<div class="box" style="margin-top:14px"><b>Poznámka zákazníka:</b><br>${esc(o.poznamka)}</div>` : ""}
      </div>
      <div class="steps">
        <form class="box" id="sf">
          <h2>Stav</h2>
          <select name="stav" style="width:100%">${STAVY.map((s) => `<option ${s === o.stav ? "selected" : ""}>${s}</option>`).join("")}</select>
          <label style="display:block;margin-top:10px;font-size:13px;font-weight:500">Interní poznámka<textarea name="interni" style="width:100%;min-height:70px">${esc(o.interni_poznamka)}</textarea></label>
          <button class="btn" style="width:100%;margin-top:10px" type="submit">Uložit</button>
        </form>
        <div class="box">
          <h2>Zákazník</h2>
          <table class="sum">
            <tr><td>Jméno</td><td>${esc(k.jmeno)}</td></tr>
            ${k.firma ? `<tr><td>Firma</td><td>${esc(k.firma)}</td></tr>` : ""}
            ${k.ico ? `<tr><td>IČ / DIČ</td><td>${esc(k.ico)} / ${esc(k.dic || "–")}</td></tr>` : ""}
            <tr><td>Telefon</td><td><a href="tel:${esc(k.telefon)}">${esc(k.telefon)}</a></td></tr>
            <tr><td>E-mail</td><td><a href="mailto:${esc(k.email)}">${esc(k.email)}</a></td></tr>
            <tr><td>Adresa</td><td>${esc(k.ulice)}, ${esc(k.psc)} ${esc(k.mesto)}</td></tr>
            <tr><td>Účet</td><td>${o.user_id ? "registrovaný" : "host"}</td></tr>
            <tr><td>Doprava</td><td>${esc(DOPRAVA.find((d) => d.id === o.doprava)?.nazev)}</td></tr>
            ${o.stavba ? `<tr><td>Místo</td><td>${esc(o.stavba)}</td></tr>` : ""}
            ${o.ridic ? `<tr><td>Řidič</td><td>${esc(o.ridic)}</td></tr>` : ""}
            <tr><td>Platba</td><td>${esc(PLATBA.find((p) => p.id === o.platba)?.nazev)}${o.splatnost ? `, ${o.splatnost} dní` : ""}</td></tr>
            <tr><td>E-mail odeslán</td><td>${o.email_odeslan ? "ano" : "ne"}</td></tr>
          </table>
        </div>
      </div>
    </div>`;
  $("#sf").onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(e.target));
    const { error } = await sb.from("objednavky").update({ stav: v.stav, interni_poznamka: v.interni || null }).eq("cislo", o.cislo);
    toast(error ? "Chyba: " + error.message : "Uloženo.");
  };
}

async function adminCustomers(params) {
  markMega();
  if (!isAdmin()) return notFound();
  loading();
  const jen = params.get("jen") || "cekajici";
  let query = sb.from("profily").select("*").order("vytvoreno", { ascending: false }).limit(300);
  if (jen === "cekajici") query = query.eq("typ", "firma").eq("schvaleno", false);
  if (jen === "firmy") query = query.eq("typ", "firma");
  const { data: rows = [] } = await query;
  app.innerHTML = `
    <div class="crumbs"><a href="#/">Úvod</a> / <a href="#/admin">Administrace</a> / Zákazníci</div>
    <div class="list-head"><h1>Zákazníci a firmy</h1></div>
    ${adminNav("f")}
    <div class="subtiles">
      <a href="#/admin/firmy?jen=cekajici" class="${jen === "cekajici" ? "on" : ""}">Firmy čekající na ověření</a>
      <a href="#/admin/firmy?jen=firmy" class="${jen === "firmy" ? "on" : ""}">Všechny firmy</a>
      <a href="#/admin/firmy?jen=vse" class="${jen === "vse" ? "on" : ""}">Všichni zákazníci</a>
    </div>
    ${rows.length ? `<table class="items" style="margin-top:12px"><thead><tr><th>Zákazník</th><th>IČ</th><th>Kontakt</th><th>Ověřeno</th><th class="num">Sleva %</th><th class="num">Splatnost</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr data-id="${r.id}">
        <td><b>${esc(r.firma || r.jmeno)}</b>${r.firma ? `<br><span class="note">${esc(r.jmeno)}</span>` : ""}${r.je_admin ? ` <span class="badge">admin</span>` : ""}</td>
        <td>${r.ico ? `<a href="https://ares.gov.cz/ekonomicke-subjekty?ico=${esc(r.ico)}" target="_blank" rel="noopener">${esc(r.ico)}</a>` : "–"}</td>
        <td>${esc(r.email)}<br><span class="note">${esc(r.telefon)}</span></td>
        <td>${r.typ === "firma" ? `<input type="checkbox" name="schvaleno" ${r.schvaleno ? "checked" : ""}>` : "–"}</td>
        <td class="num">${r.typ === "firma" ? `<input class="qty" type="number" name="sleva" min="0" max="99" step="0.5" value="${+r.sleva}">` : "–"}</td>
        <td class="num">${r.typ === "firma" ? `<input class="qty" type="number" name="splatnost" min="0" max="120" value="${r.splatnost}">` : "–"}</td>
        <td class="num">${r.typ === "firma" ? `<button class="btn" data-save>Uložit</button>` : ""}</td>
      </tr>`).join("")}</tbody></table>`
      : `<div class="empty" style="margin-top:12px">Nic tu není.</div>`}
    <p class="note">Firma po ověření uvidí ceny se slevou a může platit na fakturu. IČ se otevře v registru ARES.</p>
    <div style="height:40px"></div>`;
  $$("[data-save]").forEach((b) => (b.onclick = async () => {
    const tr = b.closest("tr");
    const upd = {
      schvaleno: tr.querySelector("[name=schvaleno]").checked,
      sleva: Math.min(99, Math.max(0, +tr.querySelector("[name=sleva]").value || 0)),
      splatnost: Math.min(120, Math.max(0, parseInt(tr.querySelector("[name=splatnost]").value) || 0)),
    };
    const { error } = await sb.from("profily").update(upd).eq("id", tr.dataset.id);
    toast(error ? "Chyba: " + error.message : "Uloženo.");
  }));
}

function notFound() {
  markMega();
  app.innerHTML = `<div class="empty" style="margin:30px 0">Stránka nenalezena. <a href="#/">Zpět na úvod</a></div>`;
}

// ---------------------------------------------------------------- router
let lastPath = "";
function route(keepScroll) {
  const h = location.hash.slice(1) || "/";
  const [rawPath, query = ""] = h.split("?");
  const path = decodeURIComponent(rawPath);
  const params = new URLSearchParams(query);
  if (path !== lastPath) { listState.shown = PAGE; lastPath = path; }
  const parts = path.split("/").filter(Boolean);
  if (parts[0] !== "hledat") $("#q").value = "";
  $("#mega").classList.remove("open");
  switch (parts[0]) {
    case undefined: home(); break;
    case "k": category(parts[1], parts[2], parts[3]); break;
    case "p": product(parts[1]); break;
    case "hledat": search(params.get("q") || ""); break;
    case "kosik": cartPage(); break;
    case "pokladna": checkout(); break;
    case "objednavka": orderPage(parts[1]); break;
    case "prihlaseni": loginPage(params); break;
    case "registrace": registerPage(params); break;
    case "ucet": accountPage(); break;
    case "admin":
      if (parts[1] === "o") adminOrder(parts[2]);
      else if (parts[1] === "firmy") adminCustomers(params);
      else adminOrders(params);
      break;
    default: notFound();
  }
  if (!keepScroll) window.scrollTo(0, 0);
}

app.addEventListener("submit", (e) => {
  const f = e.target.closest("form.buy");
  if (!f) return;
  e.preventDefault();
  const q = r2(+f.querySelector(".qty").value);
  if (!(q > 0)) { toast("Zadejte množství."); return; }
  addToCart(f.dataset.kod, q);
});
$("#search").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#q").value.trim();
  if (q) location.hash = `#/hledat?q=${encodeURIComponent(q)}`;
});
window.addEventListener("hashchange", () => route());

(async () => {
  try {
    const d = await (await fetch("data/katalog.json?v=5")).json();
    STROM = d.strom;
    P = d.produkty;
    STROM.forEach((n) => nadById.set(n.id, n));
    P.forEach((p) => byKod.set(p[0], p));
    searchIdx = P.map((p) => norm(`${p[1]} ${p[0]} ${katOf(p)?.nazev || ""}`));
    await loadProfile();
    buildMega();
    updateHeader();
    route();
    sb.auth.onAuthStateChange((ev) => {
      if (ev === "SIGNED_OUT" || ev === "USER_UPDATED") loadProfile().then(updateHeader);
    });
  } catch (err) {
    console.error(err);
    app.innerHTML = `<div class="empty" style="margin:30px 0">Katalog se nepodařilo načíst. Spusťte web přes lokální server (viz README).</div>`;
  }
})();
