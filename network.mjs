export function distance(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function prepareNetwork(network) {
  const lines = new Map(network.lines.map(line => [line.id, line]));
  const stations = new Map(network.stations.map(([id, name, lat, lng, line]) =>
    [id, { id, name, lat, lng, line: lines.get(line), transfer: false }]));
  const edges = new Map([...stations.keys()].map(id => [id, []]));
  const rails = [];
  function connect(from, to, minutes, transfer = false) {
    if (!edges.get(from).some(edge => edge.to === to)) edges.get(from).push({ to, minutes, transfer });
  }
  for (const line of lines.values()) {
    const seen = new Set();
    for (const path of line.paths) {
      for (let i = 1; i < path.length; i++) {
        const [from, to] = [path[i - 1], path[i]];
        const meters = distance(stations.get(from), stations.get(to));
        const minutes = 0.54 + meters / (line.id === 'st2' || line.id === '4' ? 580 : 740);
        const key = [from, to].sort().join('|');
        if (!seen.has(key)) rails.push({ from, to, color: line.color, line: line.id });
        seen.add(key);
        connect(from, to, minutes);
        if (!line.directed) connect(to, from, minutes);
      }
    }
  }
  for (const group of network.transfers) {
    for (const a of group) {
      stations.get(a).transfer = true;
      for (const b of group) {
        if (a === b) continue;
        const meters = distance(stations.get(a), stations.get(b));
        connect(a, b, 3 + Math.min(meters / 95, 8), true);
      }
    }
  }
  return { ...network, lines, stations, edges, rails };
}

function fastestPath(network, start, end) {
  const times = new Map([[start, 0]]);
  const previous = new Map();
  const open = new Set([start]);
  while (open.size) {
    let current;
    for (const id of open) {
      if (current === undefined || times.get(id) < times.get(current)) current = id;
    }
    if (current === end) break;
    open.delete(current);
    for (const edge of network.edges.get(current)) {
      const time = times.get(current) + edge.minutes;
      if (time >= (times.get(edge.to) ?? Infinity)) continue;
      times.set(edge.to, time);
      previous.set(edge.to, { from: current, ...edge });
      open.add(edge.to);
    }
  }
  if (!times.has(end)) return null;
  const segments = [];
  for (let id = end; id !== start;) {
    const edge = previous.get(id);
    segments.push(edge);
    id = edge.from;
  }
  return segments.reverse();
}

export function makeRoute(network, ids) {
  if (ids.length < 2 || ids.some(id => !network.stations.has(id))) return null;
  const segments = [];
  for (let i = 1; i < ids.length; i++) {
    const path = fastestPath(network, ids[i - 1], ids[i]);
    if (!path) return null;
    segments.push(...path);
  }
  if (!segments.length) return null;
  let elapsedMinutes = 0;
  const stops = [{ ids: [ids[0]], transfer: false, arrivalMinutes: 0, departureMinutes: 0 }];
  for (const [index, segment] of segments.entries()) {
    const stop = stops.at(-1);
    elapsedMinutes += segment.minutes;
    if (segment.transfer && index === segments.length - 1) {
      stop.transfer = true;
      stop.transferTo = segment.to;
      stops.push({ ids: [segment.to], transfer: false, terminalWalk: true, arrivalMinutes: elapsedMinutes, departureMinutes: elapsedMinutes });
    } else if (segment.transfer) {
      stop.ids.push(segment.to);
      stop.transfer = true;
      stop.departureMinutes = elapsedMinutes;
    } else {
      stops.push({ ids: [segment.to], transfer: false, arrivalMinutes: elapsedMinutes, departureMinutes: elapsedMinutes });
    }
  }
  return {
    segments, stops,
    minutes: Math.max(1, Math.round(elapsedMinutes)),
    transfers: segments.filter(s => s.transfer).length,
    via: new Set(ids.slice(1, -1)),
    first: ids[0], last: ids.at(-1),
  };
}

export function stationNear(network, point, accuracy) {
  if (!Number.isFinite(accuracy) || accuracy > 108) return null;
  const ranked = [...network.stations.values()].map(station => ({ station, meters: distance(point, station) }))
    .sort((a, b) => a.meters - b.meters);
  const nearest = ranked[0];
  const radius = Math.min(150, 83 + accuracy * 0.65);
  if (!nearest || nearest.meters > radius) return null;
  const group = network.transfers.find(ids => ids.includes(nearest.station.id)) ?? [nearest.station.id];
  const other = ranked.find(item => !group.includes(item.station.id));
  if (other && other.meters < radius && other.meters - nearest.meters < Math.max(24, accuracy * 0.6)) return null;
  return { station: nearest.station, ids: group, meters: nearest.meters };
}
