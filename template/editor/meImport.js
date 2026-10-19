// MOG editor: Import from MarginEdge (the Supabase editor only).
//
// A KM exports the Vendor Items list from MarginEdge (vendorItems.csv) and
// goes through two steps. Step 1, vendors: each MarginEdge vendor maps to a
// vendor the store already has, becomes a new one, or is skipped; every new
// vendor ticked here is added, even with no items. Step 2, items: the
// products those vendors sell. One MarginEdge product (the company's own name
// for it, e.g. "Butter, Unsalted") becomes one item; every ticked vendor that
// sells it becomes one of its vendors, the one bought from most recently its
// primary (R6: one par, several vendors). The same file serves a BOH and a
// FOH store: each ticks its own.
//
// The write is catalogEdit.js commitImportItems, sent by host.js like any
// other save (logged, and undone from Changes). Imported items have no
// storage area and no par yet, so they wait under Unassigned.
//
// Pure functions (parseCsv, readVendorItems, plan, resolve, payloadOf) also
// run under Node for tests/me_import.test.js; open() is the screen.
(function (root) {
  'use strict';

  const REQUIRED = ['Vendor', 'Vendor Item Name', 'Product', 'Category', 'Item Code', 'Last Purch Date'];
  const RECENT_DAYS = 60;   // ticked by default: bought in the file's last 60 days
  // MarginEdge categories that aren't restocked from an order guide:
  // equipment and furniture, repairs, linen service, office, back-office services.
  const NOT_STOCK = /furniture|equipment|repair|maintenance|linen|accounting|payroll|pest|office/i;
  const trim = v => String(v == null ? '' : v).trim();

  function fail(en, es) {
    const e = new Error(en);
    e.es = es;
    return e;
  }

  // The CSV reader is shared with Import Vendor (catalogEdit.js), loaded first.
  const CE = root.CatalogEdit || (typeof require === 'function' ? require('./catalogEdit.js') : null);
  const parseCsv = text => CE.parseCsv(text);

  // The Vendor Items export, as products: [{ name, category, sources }] in
  // name order, each source one vendor's item ({ vendor, itemName, code,
  // last 'YYYY-MM-DD' or '', orderGuide }). Throws (in both languages) on a
  // file that isn't that export.
  function readVendorItems(text) {
    const rows = parseCsv(text);
    if (!rows.length) throw fail('The file is empty.', 'El archivo está vacío.');
    const head = rows[0].map(trim);
    if (head.indexOf('Report By') >= 0 && head.indexOf('Restaurant') >= 0) {
      throw fail("That's MarginEdge's Purchase Report. Choose the Vendor Items export (vendorItems.csv) instead.",
                 'Ese es el Purchase Report de MarginEdge. Elige la exportación de Vendor Items (vendorItems.csv).');
    }
    const col = {};
    for (const name of REQUIRED) {
      col[name] = head.indexOf(name);
      if (col[name] < 0) {
        throw fail("This isn't MarginEdge's Vendor Items export: it has no \"" + name + '" column.',
                   'Este archivo no es la exportación de Vendor Items de MarginEdge: no tiene la columna "' + name + '".');
      }
    }
    const og = head.indexOf('Order Guide');
    const byKey = new Map(), vendors = new Set();
    let newest = '';
    for (const r of rows.slice(1)) {
      const vendor = trim(r[col['Vendor']]);
      const itemName = trim(r[col['Vendor Item Name']]);
      const name = trim(r[col['Product']]) || itemName;
      if (!vendor || !name) continue;
      const last = /^\d{4}-\d{2}-\d{2}$/.test(trim(r[col['Last Purch Date']])) ? trim(r[col['Last Purch Date']]) : '';
      if (last > newest) newest = last;
      vendors.add(vendor);
      const key = name.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, { name: name, category: '', sources: [] });
      const p = byKey.get(key);
      if (!p.category) p.category = trim(r[col['Category']]);
      p.sources.push({ vendor: vendor, itemName: itemName, code: trim(r[col['Item Code']]), last: last,
                       orderGuide: og >= 0 && /^yes$/i.test(trim(r[og])) });
    }
    if (!byKey.size) throw fail('No items found in the file.', 'No se encontraron artículos en el archivo.');
    const byName = (a, b) => a.localeCompare(b);
    return { products: [...byKey.values()].sort((a, b) => byName(a.name, b.name)),
             vendors: [...vendors].sort(byName), newest: newest };
  }

  function minusDays(ymd, days) {
    if (!ymd) return '';
    const d = new Date(ymd + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - days);
    return d.toISOString().substring(0, 10);
  }

  // The store's vendors by lower-case name (canonical name as the value).
  function storeVendors(tables) {
    const m = new Map();
    for (const v of tables.vendors) { const n = trim(v.name); if (n && !m.has(n.toLowerCase())) m.set(n.toLowerCase(), n); }
    return m;
  }

  // The starting choices for a file and a store's tables:
  //   vendors   [{ me, use, target, newName }]   target '' = a new vendor named newName
  //   products  [{ name (editable), meName, category, sources, last, inStore ('name' | 'sku' | ''), pick }]
  // A product is ticked when it isn't in the store yet, its category is one
  // that's restocked, and it was bought in the file's last RECENT_DAYS days.
  // A vendor is ticked when the store has it already or it sells a ticked product.
  function plan(file, tables) {
    const known = storeVendors(tables);
    const names = new Set(), skus = new Set();
    for (const it of tables.items) {
      if (trim(it.name)) names.add(trim(it.name).toLowerCase());
      if (trim(it.sku)) skus.add(trim(it.sku).toLowerCase());
    }
    const since = minusDays(file.newest, RECENT_DAYS);
    const products = file.products.map(p => {
      const last = p.sources.reduce((m, s) => (s.last > m ? s.last : m), '');
      const inStore = names.has(p.name.toLowerCase()) ? 'name'
        : p.sources.some(s => s.code && skus.has(s.code.toLowerCase())) ? 'sku' : '';
      return { name: p.name, meName: p.name, category: p.category, sources: p.sources, last: last, inStore: inStore,
               pick: !inStore && !!p.category && !NOT_STOCK.test(p.category) && !!last && last >= since };
    });
    const selling = new Set();
    for (const p of products) if (p.pick) for (const s of p.sources) selling.add(s.vendor);
    return {
      since: since,
      vendors: file.vendors.map(me => {
        const target = known.get(me.toLowerCase()) || '';
        return { me: me, use: !!target || selling.has(me), target: target, newName: me };
      }),
      products: products
    };
  }

  // A MarginEdge vendor's name in the store, or null when it's skipped or
  // still has no name. A new name that matches a store vendor is that vendor.
  function targetOf(state, known, me) {
    const v = state.vendors.find(x => x.me === me);
    if (!v || !v.use) return null;
    if (v.target) return v.target;
    const n = trim(v.newName);
    if (!n) return null;
    return known.get(n.toLowerCase()) || n;
  }

  // A product's vendors in the store: the most recent purchase first (then
  // MarginEdge's Order Guide flag, then the file's order), duplicates merged.
  // { primary, eligible, sku } or { primary: null } when every vendor is skipped.
  function resolve(state, known, p) {
    const usable = p.sources.map((s, i) => ({ s: s, i: i, to: targetOf(state, known, s.vendor) })).filter(x => x.to);
    if (!usable.length) return { primary: null, eligible: [], sku: '' };
    usable.sort((a, b) => (a.s.last === b.s.last ? 0 : a.s.last > b.s.last ? -1 : 1) ||
                          (Number(b.s.orderGuide) - Number(a.s.orderGuide)) || (a.i - b.i));
    const eligible = [];
    for (const x of usable) if (!eligible.some(e => e.toLowerCase() === x.to.toLowerCase())) eligible.push(x.to);
    return { primary: eligible[0], eligible: eligible, sku: usable[0].s.code };
  }

  // What the Import button would send, and why it can't yet.
  // { payload: { newVendors, items }, errors: [{ kind: 'vendor' | 'item', en, es }] }
  // Every new vendor ticked in step 1 is added, with items or not.
  function payloadOf(state, tables) {
    const known = storeVendors(tables);
    const errors = [], newVendors = [];
    for (const v of state.vendors) {
      if (!v.use || v.target) continue;
      const n = trim(v.newName);
      if (!n) errors.push({ kind: 'vendor', en: 'The vendor "' + v.me + '" needs a name.', es: 'El proveedor "' + v.me + '" necesita un nombre.' });
      else if (n.length > 100) errors.push({ kind: 'vendor', en: 'The vendor name "' + n + '" is longer than 100 characters.', es: 'El nombre de proveedor "' + n + '" tiene más de 100 caracteres.' });
      else if (!known.has(n.toLowerCase()) && !newVendors.some(x => x.toLowerCase() === n.toLowerCase())) newVendors.push(n);
    }
    const inStore = new Set(tables.items.map(it => trim(it.name).toLowerCase()).filter(Boolean));
    const seen = new Set(), items = [];
    for (const p of state.products) {
      if (!p.pick) continue;
      const r = resolve(state, known, p);
      if (!r.primary) continue;
      const name = trim(p.name);
      const low = name.toLowerCase();
      if (!name) errors.push({ kind: 'item', en: 'An item has no name (MarginEdge: "' + p.meName + '").', es: 'Un artículo no tiene nombre (MarginEdge: "' + p.meName + '").' });
      else if (name.length > 300) errors.push({ kind: 'item', en: 'The name "' + name.substring(0, 50) + '…" is longer than 300 characters.', es: 'El nombre "' + name.substring(0, 50) + '…" tiene más de 300 caracteres.' });
      else if (inStore.has(low)) errors.push({ kind: 'item', en: '"' + name + '" is already in the catalog. Rename it or untick it.', es: '"' + name + '" ya está en el catálogo. Cámbiale el nombre o desmárcalo.' });
      else if (seen.has(low)) errors.push({ kind: 'item', en: 'Two items are called "' + name + '". Rename one or untick it.', es: 'Dos artículos se llaman "' + name + '". Cambia uno o desmárcalo.' });
      seen.add(low);
      items.push({ name: name, primaryVendor: r.primary, eligible: r.eligible, sku: r.sku, category: p.category });
    }
    return { payload: { newVendors: newVendors, items: items }, errors: errors };
  }

  // ---- The screen ---------------------------------------------------------------

  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const CSS =
    '#mei-ov{position:fixed;inset:0;z-index:8000;background:rgba(20,22,28,.45);display:flex;align-items:center;justify-content:center;padding:20px;font:14px Inter,Arial,sans-serif;color:#222}' +
    '#mei-ov *{box-sizing:border-box}' +
    '.mei-card{background:#fff;border-radius:12px;width:min(1100px,100%);height:min(900px,100%);display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.28)}' +
    '.mei-head{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid #e8eaed}' +
    '.mei-head h2{margin:0;font-size:18px;flex:1}.mei-step{font-weight:500;color:#666;font-size:15px}.mei-x{border:0;background:none;font-size:18px;cursor:pointer;color:#555}' +
    '.mei-body{flex:1;overflow:auto;padding:16px 20px}' +
    '.mei-body p{margin:0 0 10px;line-height:1.45}.mei-hint{color:#666;font-size:13px}' +
    '.mei-file{display:inline-block;margin:6px 0 4px}.mei-err{color:#c0392b;margin-top:8px;font-weight:600}' +
    '.mei-sum{background:var(--web-accent-soft,#e9f4ef);border:1px solid var(--web-accent-line,#cfe6dc);border-radius:8px;padding:10px 14px;margin-bottom:14px}' +
    '.mei-h3{font-size:15px;font-weight:700;margin:18px 0 8px}' +
    '.mei-tbl{width:100%;border-collapse:collapse;font-size:13px}.mei-tbl td,.mei-tbl th{padding:6px 8px;border-bottom:1px solid #f0f0f0;text-align:left;vertical-align:middle}' +
    '.mei-tbl th{font-size:12px;color:#666;font-weight:600}' +
    '.mei-tbl input[type=text],.mei-tbl select{width:100%;padding:5px 7px;border:1px solid #c9ced6;border-radius:6px;font:13px Inter,Arial,sans-serif}' +
    '.mei-off td{color:#999}.mei-n{white-space:nowrap;color:#666}' +
    '.mei-tools{display:flex;gap:10px;align-items:center;margin:4px 0 10px;flex-wrap:wrap}' +
    '.mei-tools input,.mei-tools select{padding:6px 9px;border:1px solid #c9ced6;border-radius:6px;font:13px Inter,Arial,sans-serif}' +
    '.mei-tools input{flex:1;min-width:200px}' +
    '.mei-cat td{background:#f6f7f9;font-weight:700}.mei-cat button{border:0;background:none;cursor:pointer;font:inherit;padding:0;color:inherit}' +
    '.mei-vend{font-size:12px;color:#555}.mei-vend b{color:#222}.mei-tag{display:inline-block;font-size:11px;font-weight:700;border-radius:999px;padding:1px 8px;background:#fdf1d8;color:#7a5200;margin-left:6px}' +
    '.mei-foot{display:flex;gap:10px;align-items:center;padding:12px 20px;border-top:1px solid #e8eaed}' +
    '.mei-msg{flex:1;font-size:13px;color:#c0392b}.mei-msg.ok{color:#555}' +
    '.mei-btn{border:1px solid #c9ced6;background:#fff;border-radius:8px;padding:9px 16px;font:600 14px Inter,Arial,sans-serif;cursor:pointer}' +
    '.mei-go{background:var(--web-accent,#2d8c6b);border-color:var(--web-accent,#2d8c6b);color:var(--web-accent-text,#fff)}' +
    '.mei-go[disabled]{opacity:.45;cursor:default}';

  // host = { tables(), call(fn, args) -> Promise, tr(en, es), done(result) }
  // Three screens: choose the file, step 1 vendors, step 2 items. Nothing is
  // saved until Import, at the end of step 2.
  function open(host) {
    const tr = host.tr;
    if (document.getElementById('mei-ov')) return;
    if (!document.getElementById('mei-css')) {
      const css = document.createElement('style');
      css.id = 'mei-css';
      css.textContent = CSS;
      document.head.appendChild(css);
    }
    let state = null, busy = false, step = 0;   // 0 the file, 1 vendors, 2 items
    const collapsed = new Set();
    const filter = { q: '', show: 'all' };
    const catOf = p => p.category || tr('(no category)', '(sin categoría)');
    const ov = document.createElement('div');
    ov.id = 'mei-ov';
    ov.innerHTML =
      '<div class="mei-card" role="dialog" aria-modal="true">' +
        '<div class="mei-head"><h2>' + esc(tr('Import from MarginEdge', 'Importar de MarginEdge')) +
          ' <span class="mei-step" id="mei-stepname"></span></h2>' +
          '<button type="button" class="mei-x" data-act="close" aria-label="Close">✕</button></div>' +
        '<div class="mei-body">' +
          '<div id="mei-file-step">' +
            '<p>' + esc(tr('In MarginEdge, export the Vendor Items list for this restaurant (a CSV file named vendorItems.csv), then choose it here.',
                           'En MarginEdge, exporta la lista de Vendor Items de este restaurante (un archivo CSV llamado vendorItems.csv) y elígelo aquí.')) + '</p>' +
            '<p class="mei-hint">' + esc(tr('Two steps: first the vendors, then their items. Nothing is saved until you press Import.',
                                             'Dos pasos: primero los proveedores, luego sus artículos. No se guarda nada hasta que presiones Importar.')) + '</p>' +
            '<input class="mei-file" type="file" accept=".csv,text/csv" data-act="file">' +
            '<div class="mei-err" id="mei-err"></div>' +
          '</div>' +
          '<div id="mei-vendor-step" hidden>' +
            '<div class="mei-sum" id="mei-vsum"></div>' +
            '<p class="mei-hint">' + esc(tr('Tick the vendors this store orders from. Each new vendor ticked here is added, even with no items. It has no delivery days until someone sets them, so it orders nothing until then.',
                                             'Marca los proveedores a los que esta tienda les pide. Cada proveedor nuevo marcado aquí se agrega, aunque no tenga artículos. No tiene días de entrega hasta que alguien los ponga, así que no pide nada hasta entonces.')) + '</p>' +
            '<table class="mei-tbl"><thead><tr><th></th><th>MarginEdge</th><th>' + esc(tr('Items ticked', 'Marcados')) + '</th><th>' +
              esc(tr('In this store', 'En esta tienda')) + '</th><th></th></tr></thead><tbody id="mei-vendors"></tbody></table>' +
          '</div>' +
          '<div id="mei-item-step" hidden>' +
            '<div class="mei-sum" id="mei-isum"></div>' +
            '<p class="mei-hint">' + esc(tr('Items sold by the vendors you ticked. Ticked to start: bought since ', 'Artículos de los proveedores que marcaste. Marcados al inicio: comprados desde ')) +
              '<span id="mei-since"></span>' +
              esc(tr(', and not equipment, furniture, repairs, linen, office or services. Edit a name to shorten it.',
                     ', y que no son equipo, muebles, reparaciones, lencería, oficina ni servicios. Edita un nombre para acortarlo.')) + '</p>' +
            '<div class="mei-tools">' +
              '<input type="search" data-act="search" placeholder="' + esc(tr('Search items', 'Buscar artículos')) + '">' +
              '<select data-act="show">' +
                '<option value="all">' + esc(tr('Show all', 'Mostrar todos')) + '</option>' +
                '<option value="picked">' + esc(tr('Show ticked', 'Mostrar marcados')) + '</option>' +
                '<option value="instore">' + esc(tr('Show already in this store', 'Mostrar los que ya están')) + '</option>' +
              '</select>' +
            '</div>' +
            '<table class="mei-tbl"><thead><tr><th></th><th>' + esc(tr('Name', 'Nombre')) + '</th><th>' + esc(tr('Vendors', 'Proveedores')) +
              '</th><th>' + esc(tr('Last bought', 'Última compra')) + '</th></tr></thead><tbody id="mei-items"></tbody></table>' +
          '</div>' +
        '</div>' +
        '<div class="mei-foot"><div class="mei-msg" id="mei-msg"></div>' +
          '<button type="button" class="mei-btn" data-act="close">' + esc(tr('Cancel', 'Cancelar')) + '</button>' +
          '<button type="button" class="mei-btn" data-act="back" hidden>' + esc(tr('← Vendors', '← Proveedores')) + '</button>' +
          '<button type="button" class="mei-btn mei-go" data-act="go" disabled>' + esc(tr('Next: items →', 'Siguiente: artículos →')) + '</button></div>' +
      '</div>';
    document.body.appendChild(ov);
    const $ = id => document.getElementById(id);

    function close() {
      if (busy) return;
      const go = () => ov.remove();
      if (!state || typeof window.mgeConfirm_ !== 'function') { go(); return; }
      window.mgeConfirm_({ title: { en: 'Close without importing?', es: '¿Cerrar sin importar?' },
                           msg: { en: 'Nothing has been saved yet.', es: 'Todavía no se ha guardado nada.' },
                           confirmLabel: { en: 'Close', es: 'Cerrar' }, onConfirm: go });
    }

    function load(fileObj) {
      $('mei-err').textContent = '';
      const reader = new FileReader();
      reader.onload = function () {
        try {
          state = plan(readVendorItems(String(reader.result || '')), host.tables());
        } catch (e) {
          $('mei-err').textContent = tr(e.message, e.es || e.message);
          return;
        }
        $('mei-since').textContent = state.since || '—';
        show(1);
      };
      reader.onerror = function () { $('mei-err').textContent = tr('Could not read the file.', 'No se pudo leer el archivo.'); };
      reader.readAsText(fileObj);
    }

    function show(n) {
      step = n;
      $('mei-file-step').hidden = n !== 0;
      $('mei-vendor-step').hidden = n !== 1;
      $('mei-item-step').hidden = n !== 2;
      ov.querySelector('[data-act="back"]').hidden = n !== 2;
      $('mei-stepname').textContent = n === 1 ? tr('· Step 1 of 2: vendors', '· Paso 1 de 2: proveedores')
                                    : n === 2 ? tr('· Step 2 of 2: items', '· Paso 2 de 2: artículos') : '';
      ov.querySelector('.mei-body').scrollTop = 0;
      if (n === 1) renderVendors();
      if (n === 2) renderItems();
    }

    function known() { return storeVendors(host.tables()); }

    function renderVendors() {
      const names = [...known().values()].sort((a, b) => a.localeCompare(b));
      let html = '';
      state.vendors.forEach(function (v, i) {
        const total = state.products.filter(p => p.sources.some(s => s.vendor === v.me)).length;
        const opts = '<option value="">' + esc(tr('New vendor', 'Proveedor nuevo')) + '</option>' +
          names.map(n => '<option value="' + esc(n) + '"' + (v.target === n ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
        html += '<tr class="' + (v.use ? '' : 'mei-off') + '"><td><input type="checkbox" data-act="vuse" data-i="' + i + '"' + (v.use ? ' checked' : '') + '></td>' +
          '<td>' + esc(v.me) + '</td><td class="mei-n"><span data-vcount="' + i + '"></span> / ' + total + '</td>' +
          '<td><select data-act="vsel" data-i="' + i + '"' + (v.use ? '' : ' disabled') + '>' + opts + '</select></td>' +
          '<td>' + (v.target ? '' : '<input type="text" data-act="vname" data-i="' + i + '" value="' + esc(v.newName) + '"' + (v.use ? '' : ' disabled') +
            ' aria-label="' + esc(tr('New vendor name', 'Nombre del proveedor nuevo')) + '">') + '</td></tr>';
      });
      $('mei-vendors').innerHTML = html;
      update();
    }

    function visible(p) {
      if (filter.show === 'picked' && !p.pick) return false;
      if (filter.show === 'instore' && !p.inStore) return false;
      if (!filter.q) return true;
      const q = filter.q.toLowerCase();
      return p.name.toLowerCase().indexOf(q) >= 0 || p.meName.toLowerCase().indexOf(q) >= 0 ||
             p.sources.some(s => s.vendor.toLowerCase().indexOf(q) >= 0 || s.itemName.toLowerCase().indexOf(q) >= 0);
    }

    // Step 2 lists only products a ticked vendor sells.
    function renderItems() {
      const kn = known();
      const groups = new Map();
      state.products.forEach(function (p, i) {
        if (!visible(p) || !resolve(state, kn, p).primary) return;
        const cat = catOf(p);
        if (!groups.has(cat)) groups.set(cat, []);
        groups.get(cat).push(i);
      });
      let html = '';
      for (const cat of [...groups.keys()].sort((a, b) => a.localeCompare(b))) {
        const open_ = !collapsed.has(cat);
        html += '<tr class="mei-cat"><td><input type="checkbox" data-act="cat" data-cat="' + esc(cat) + '"></td>' +
          '<td colspan="3"><button type="button" data-act="fold" data-cat="' + esc(cat) + '">' + (open_ ? '▾ ' : '▸ ') + esc(cat) +
          ' <span class="mei-n" data-catcount="' + esc(cat) + '"></span></button></td></tr>';
        if (!open_) continue;
        for (const i of groups.get(cat)) {
          const p = state.products[i];
          const r = resolve(state, kn, p);
          const others = r.eligible.slice(1);
          const tag = p.inStore === 'name' ? tr('Already in this store', 'Ya está en esta tienda')
                    : p.inStore === 'sku' ? tr('Same item code in this store', 'Mismo código en esta tienda') : '';
          html += '<tr><td><input type="checkbox" data-act="pick" data-i="' + i + '"' + (p.pick ? ' checked' : '') + '></td>' +
            '<td><input type="text" data-act="name" data-i="' + i + '" value="' + esc(p.name) + '" maxlength="300"' +
              ' aria-label="' + esc(tr('Item name', 'Nombre del artículo')) + '">' + (tag ? '<span class="mei-tag">' + esc(tag) + '</span>' : '') + '</td>' +
            '<td class="mei-vend"><b>' + esc(r.primary) + '</b>' + (others.length ? ' · ' + esc(tr('also', 'también')) + ' ' + esc(others.join(', ')) : '') + '</td>' +
            '<td class="mei-n">' + esc(p.last || '—') + '</td></tr>';
        }
      }
      $('mei-items').innerHTML = html || '<tr><td colspan="4" class="mei-hint">' + esc(tr('No items match.', 'Ningún artículo coincide.')) + '</td></tr>';
      update();
    }

    // Everything that only counts: the summaries, each vendor's and category's
    // ticks, the category checkboxes, the message line and the main button.
    function update() {
      const kn = known();
      const res = state.products.map(p => resolve(state, kn, p));
      const out = payloadOf(state, host.tables());
      const n = out.payload.items.length, nv = out.payload.newVendors.length;
      const used = state.vendors.filter(v => v.use).length;
      const errs = out.errors.filter(e => step === 2 || e.kind === 'vendor');
      if (step === 1) {
        $('mei-vsum').textContent = tr(
          state.vendors.length + ' vendors and ' + state.products.length + ' products in the file. ' + used + ' vendors ticked' +
            (nv ? ', ' + nv + ' of them new' : '') + '.',
          state.vendors.length + ' proveedores y ' + state.products.length + ' productos en el archivo. ' + used + ' proveedores marcados' +
            (nv ? ', ' + nv + ' nuevos' : '') + '.');
        state.vendors.forEach(function (v, i) {
          const el = ov.querySelector('[data-vcount="' + i + '"]');
          if (el) el.textContent = String(state.products.filter((p, k) => p.pick && res[k].primary && p.sources.some(s => s.vendor === v.me)).length);
        });
      }
      if (step === 2) {
        const inStore = state.products.filter((p, k) => p.inStore && res[k].primary).length;
        $('mei-isum').textContent = tr(
          n + ' item' + (n === 1 ? '' : 's') + ' ticked' + (nv ? ', and ' + nv + ' new vendor' + (nv === 1 ? '' : 's') + ' from step 1' : '') +
            '. ' + inStore + ' of these products are already in this store.',
          n + ' artículo' + (n === 1 ? '' : 's') + ' marcado' + (n === 1 ? '' : 's') + (nv ? ', y ' + nv + ' proveedor' + (nv === 1 ? '' : 'es') + ' nuevo' + (nv === 1 ? '' : 's') + ' del paso 1' : '') +
            '. ' + inStore + ' de estos productos ya están en esta tienda.');
        ov.querySelectorAll('input[data-act="cat"]').forEach(function (box) {
          const cat = box.getAttribute('data-cat');
          const rows = state.products.filter((p, k) => catOf(p) === cat && visible(p) && res[k].primary);
          const on = rows.filter(p => p.pick).length;
          box.checked = rows.length > 0 && on === rows.length;
          box.indeterminate = on > 0 && on < rows.length;
          const c = ov.querySelector('[data-catcount="' + attrSel(cat) + '"]');
          if (c) c.textContent = '(' + on + ' / ' + rows.length + ')';
        });
      }
      const msg = $('mei-msg'), go = ov.querySelector('[data-act="go"]');
      msg.className = errs.length ? 'mei-msg' : 'mei-msg ok';
      msg.textContent = errs.length ? tr(errs[0].en, errs[0].es) +
        (errs.length > 1 ? tr(' (and ' + (errs.length - 1) + ' more)', ' (y ' + (errs.length - 1) + ' más)') : '') : '';
      if (step === 1) {
        go.disabled = busy || !!errs.length;
        go.textContent = tr('Next: items →', 'Siguiente: artículos →');
      } else {
        go.disabled = busy || !!errs.length || (!n && !nv);
        go.textContent = n ? tr('Import ' + n + ' item' + (n === 1 ? '' : 's'), 'Importar ' + n + ' artículo' + (n === 1 ? '' : 's'))
                           : tr('Add ' + nv + ' vendor' + (nv === 1 ? '' : 's'), 'Agregar ' + nv + ' proveedor' + (nv === 1 ? '' : 'es'));
      }
    }

    function doImport() {
      const out = payloadOf(state, host.tables());
      const n = out.payload.items.length, nv = out.payload.newVendors.length;
      if (out.errors.length || (!n && !nv)) return;
      const go = function () {
        busy = true;
        update();
        $('mei-msg').className = 'mei-msg ok';
        $('mei-msg').textContent = tr('Importing…', 'Importando…');
        Promise.resolve(host.call('commitImportItems', [out.payload])).then(function (res) {
          busy = false;
          ov.remove();
          host.done(res);
        }, function (e) {
          busy = false;
          update();
          $('mei-msg').className = 'mei-msg';
          $('mei-msg').textContent = (e && e.message) || String(e);
        });
      };
      const what = {
        en: (n ? n + ' item' + (n === 1 ? '' : 's') : '') + (n && nv ? ' and ' : '') + (nv ? nv + ' new vendor' + (nv === 1 ? '' : 's') : '') + '. You can undo it from Changes.',
        es: (n ? n + ' artículo' + (n === 1 ? '' : 's') : '') + (n && nv ? ' y ' : '') + (nv ? nv + ' proveedor' + (nv === 1 ? '' : 'es') + ' nuevo' + (nv === 1 ? '' : 's') : '') + '. Puedes deshacerlo desde Cambios.'
      };
      if (typeof window.mgeConfirm_ === 'function') {
        window.mgeConfirm_({ title: { en: 'Import from MarginEdge?', es: '¿Importar de MarginEdge?' }, msg: what,
                             confirmLabel: { en: 'Import', es: 'Importar' }, onConfirm: go });
      } else if (window.confirm(tr(what.en, what.es))) {
        go();
      }
    }

    ov.addEventListener('click', function (ev) {
      const t = ev.target.closest('[data-act]');
      if (!t) { if (ev.target === ov) close(); return; }
      const act = t.getAttribute('data-act');
      if (act === 'close') close();
      else if (act === 'back') show(1);
      else if (act === 'go') { if (step === 1) show(2); else doImport(); }
      else if (act === 'fold') {
        const cat = t.getAttribute('data-cat');
        if (collapsed.has(cat)) collapsed.delete(cat); else collapsed.add(cat);
        renderItems();
      }
    });
    ov.addEventListener('change', function (ev) {
      const t = ev.target, act = t.getAttribute('data-act'), i = Number(t.getAttribute('data-i'));
      if (act === 'file') { if (t.files && t.files[0]) load(t.files[0]); return; }
      if (!state) return;
      if (act === 'vuse') { state.vendors[i].use = t.checked; renderVendors(); }
      else if (act === 'vsel') { state.vendors[i].target = t.value; renderVendors(); }
      else if (act === 'pick') { state.products[i].pick = t.checked; update(); }
      else if (act === 'cat') {
        const cat = t.getAttribute('data-cat'), kn = known();
        state.products.forEach(function (p) {
          if (catOf(p) === cat && visible(p) && resolve(state, kn, p).primary) p.pick = t.checked;
        });
        renderItems();
      } else if (act === 'show') { filter.show = t.value; renderItems(); }
    });
    ov.addEventListener('input', function (ev) {
      const t = ev.target, act = t.getAttribute('data-act'), i = Number(t.getAttribute('data-i'));
      if (!state) return;
      if (act === 'vname') { state.vendors[i].newName = t.value; update(); }
      else if (act === 'name') { state.products[i].name = t.value; update(); }
      else if (act === 'search') { filter.q = t.value.trim(); renderItems(); }
    });
  }

  // A category name inside a [data-catcount="..."] selector.
  function attrSel(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  const api = { parseCsv: parseCsv, readVendorItems: readVendorItems, plan: plan, resolve: resolve,
                payloadOf: payloadOf, storeVendors: storeVendors, open: open, RECENT_DAYS: RECENT_DAYS };
  root.MeImport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
