const minute = 60_000;
const leadTime = minute;
const lateTolerance = 15_000;

export function stationTime(ride, index) {
  return ride.origin + ride.route.stops[index].arrivalMinutes * minute;
}

export function syncJourneyTime(ride, observedAt, elapsedMinutes) {
  ride.origin = observedAt - elapsedMinutes * minute;
}

export function nextEstimatedStop(ride, now) {
  const last = ride.route.stops.length - 1;
  for (let i = ride.index + 1; i < last; i++) {
    if (stationTime(ride, i) > now) return i;
  }
  return last;
}

export function imminentAlert(ride, now, alertType) {
  let upcoming;
  let recent;
  for (let index = ride.index + 1; index < ride.route.stops.length; index++) {
    const remaining = stationTime(ride, index) - now;
    if (remaining > leadTime) break;
    const type = alertType(index);
    if (!type || ride.warned.has(index) || remaining < -lateTolerance) continue;
    if (remaining > 0) {
      upcoming = { index, type, remaining };
      break;
    }
    recent = { index, type, remaining };
  }
  return recent ?? upcoming;
}

export function positionOnJourney(network, ride, point, accuracy, now) {
  if (!Number.isFinite(accuracy) || accuracy > 85) return null;
  const stops = ride.route.stops;
  const toEast = 111_320 * Math.cos(point.lat * Math.PI / 180);
  const offset = station => ({ x: (station.lng - point.lng) * toEast, y: (station.lat - point.lat) * 110_800 });
  const elapsed = (now - ride.origin) / minute;
  const range = Math.max(110, accuracy * 1.7);
  const candidates = [];
  for (let index = ride.index; index < stops.length - 1; index++) {
    const from = stops[index];
    const to = stops[index + 1];
    if (index !== ride.index && from.departureMinutes > elapsed + 1.5) break;
    if (to.terminalWalk) continue;
    const a = offset(network.stations.get(from.ids.at(-1)));
    const b = offset(network.stations.get(to.ids[0]));
    const dx = b.x - a.x, dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared < 10_000) continue;
    const fraction = -(a.x * dx + a.y * dy) / lengthSquared;
    if (fraction < .03 || fraction > .97) continue;
    const meters = Math.hypot(a.x + fraction * dx, a.y + fraction * dy);
    if (meters > range) continue;
    const minutes = from.departureMinutes + fraction * (to.arrivalMinutes - from.departureMinutes);
    candidates.push({ minutes, score: meters + Math.abs(minutes - elapsed) * 19 });
  }
  candidates.sort((a, b) => a.score - b.score);
  if (!candidates.length || candidates[1]?.score - candidates[0].score < Math.max(20, accuracy * .5)) return null;
  return candidates[0].minutes;
}
