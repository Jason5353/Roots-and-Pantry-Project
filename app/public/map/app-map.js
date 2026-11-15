// Producer map. Libraries are self-hosted; map data comes from our own /tiles/uk.pmtiles.
// Pins are at postcode-district centres. The list page is the accessible alternative.
import * as maplibregl from '/map/vendor/maplibre-gl.mjs';

const el = document.getElementById('map');
const status = document.getElementById('map-status');
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const UK = [[-8.7, 49.8], [1.9, 60.9]];

function say(text) {
  status.textContent = text;
  status.hidden = !text;
}

function popupContent(g) {
  const box = document.createElement('div');
  const h = document.createElement('p');
  h.className = 'pop-title';
  h.textContent = g.town ? `${g.town}, ${g.district}` : g.district;
  box.append(h);
  const ul = document.createElement('ul');
  for (const p of g.producers) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `/p/${encodeURIComponent(p.slug)}`;
    a.textContent = p.name;
    li.append(a);
    const bits = [];
    if (p.deals) bits.push(`${p.deals} ${p.deals === 1 ? 'deal' : 'deals'}`);
    if (p.miles !== null) bits.push(p.miles < 1 ? 'under a mile away' : `about ${p.miles} miles away`);
    if (bits.length) li.append(` (${bits.join(', ')})`);
    ul.append(li);
  }
  box.append(ul);
  return box;
}

async function start() {
  const res = await fetch(el.dataset.src, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('data');
  const data = await res.json();

  const protocol = new window.pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  const origin = window.location.origin;
  const map = new maplibregl.Map({
    container: el,
    bounds: UK,
    maxBounds: [[-12, 48.5], [5, 62]],
    minZoom: 4,
    maxZoom: 16,
    fadeDuration: reduceMotion ? 0 : 300,
    cooperativeGestures: true,
    attributionControl: { compact: false },
    style: {
      version: 8,
      glyphs: `${origin}/map/fonts/{fontstack}/{range}.pbf`,
      sprite: `${origin}/map/sprites/light`,
      sources: {
        protomaps: {
          type: 'vector',
          url: `pmtiles://${origin}/tiles/uk.pmtiles`,
          attribution: '<a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>',
        },
      },
      layers: window.basemaps.layers('protomaps', window.basemaps.namedFlavor('light'), { lang: 'en' }),
    },
  });
  el.rpMap = map; // handy for checks in the browser console
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  let failed = false;
  map.on('error', (e) => {
    if (failed || !e || !e.sourceId) return;
    failed = true;
    say("The map isn't available right now. The pins still work, or use the list instead.");
  });

  const bounds = new maplibregl.LngLatBounds();
  for (const g of data.groups) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pin';
    const n = g.producers.length;
    if (n > 1) btn.textContent = String(n);
    const marker = new maplibregl.Marker({ element: btn, anchor: 'bottom' })
      .setLngLat([g.lng, g.lat])
      .setPopup(new maplibregl.Popup({ offset: 30, maxWidth: '300px', focusAfterOpen: true }).setDOMContent(popupContent(g)))
      .addTo(map);
    marker.getElement().setAttribute('aria-label', `${n} ${n === 1 ? 'producer' : 'producers'} in ${g.town ? `${g.town}, ` : ''}${g.district}: ${g.producers.map((p) => p.name).join(', ')}`);
    bounds.extend([g.lng, g.lat]);
  }

  if (data.centre) {
    const dLat = data.miles / 69;
    const dLng = data.miles / (69 * Math.cos((data.centre.lat * Math.PI) / 180));
    map.fitBounds([[data.centre.lng - dLng, data.centre.lat - dLat], [data.centre.lng + dLng, data.centre.lat + dLat]], { padding: 20, animate: false });
  } else if (!bounds.isEmpty()) {
    map.fitBounds(bounds, { padding: 60, maxZoom: 11, animate: false });
  }
  say(data.groups.length ? '' : 'No producers to show here yet.');
}

start().catch(() => say("Sorry, the map couldn't load. Use the list instead."));
