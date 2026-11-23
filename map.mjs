const RIVERS = {
  moscow: [
    [55.825,37.415],[55.802,37.438],[55.793,37.428],[55.777,37.405],[55.762,37.421],
    [55.758,37.448],[55.767,37.476],[55.757,37.502],[55.744,37.519],[55.736,37.547],
    [55.746,37.564],[55.753,37.583],[55.746,37.601],[55.743,37.616],[55.744,37.633],
    [55.736,37.651],[55.721,37.646],[55.714,37.628],[55.702,37.648],[55.686,37.679],
    [55.686,37.722],[55.663,37.726],[55.644,37.781],
  ],
  petersburg: [
    [59.969,30.205],[59.966,30.247],[59.940,30.262],[59.930,30.276],[59.938,30.298],
    [59.946,30.313],[59.951,30.343],[59.946,30.382],[59.933,30.405],[59.911,30.413],
    [59.900,30.443],[59.870,30.465],[59.863,30.501],
  ],
  novosibirsk: [[55.074,82.82],[55.051,82.87],[55.020,82.90],[54.997,82.963],[54.962,82.995]],
  nizhny: [[56.345,43.81],[56.340,43.89],[56.333,43.946],[56.335,43.987],[56.322,44.039]],
  samara: [[53.270,49.99],[53.235,50.09],[53.203,50.10],[53.177,50.05]],
  volgograd: [[48.826,44.629],[48.785,44.611],[48.750,44.590],[48.710,44.547],[48.673,44.502]],
};

export class MetroMap {
  constructor(canvas, onStation) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onStation = onStation;
    this.width = 0;
    this.height = 0;
    this.scale = 80;
    this.cx = 0;
    this.cy = 0;
    this.view = 'route';
    this.pointers = new Map();
    this.scheduleDraw = () => {
      if (this.frame) return;
      this.frame = requestAnimationFrame(() => { this.frame = null; this.draw(); });
    };
    new ResizeObserver(() => this.resize()).observe(canvas);
    document.fonts?.ready.then(this.scheduleDraw);
    canvas.addEventListener('pointerdown', event => this.pointerDown(event));
    canvas.addEventListener('pointermove', event => this.pointerMove(event));
    for (const type of ['pointerup','pointercancel','lostpointercapture']) {
      canvas.addEventListener(type, event => this.pointerEnd(event));
    }
    for (const type of ['touchstart', 'touchmove']) {
      canvas.addEventListener(type, event => this.handlePinch(event), { passive: false });
    }
    for (const type of ['touchend', 'touchcancel']) {
      canvas.addEventListener(type, event => {
        if (event.targetTouches.length < 2) this.pinch = null;
      });
    }
    canvas.addEventListener('pointerleave', event => {
      if (!this.interactive) this.pointers.delete(event.pointerId);
      this.hover = null;
      this.canvas.classList.remove('station-hover');
      this.scheduleDraw();
    });
    canvas.addEventListener('wheel', event => {
      if (!this.network || !this.interactive) return;
      event.preventDefault();
      const point = this.local(event);
      this.zoom(Math.exp(-Math.max(-300, Math.min(300, event.deltaY)) * 0.002), point.x, point.y);
    }, { passive: false });
  }

  setInteractive(enabled) {
    this.interactive = enabled;
    this.pointers.clear();
    this.pinch = null;
    this.canvas.classList.remove('dragging');
  }

  setNetwork(network, route) {
    this.network = network;
    this.route = route;
    this.position = null;
    this.current = null;
    this.hover = null;
    [this.lat, this.lng] = network.center;
    this.longitudeKm = 111.32 * Math.cos(this.lat * Math.PI / 180);
    this.points = new Map([...network.stations].map(([id, s]) => [id, this.project(s)]));
    this.river = (RIVERS[network.id] ?? []).map(([lat, lng]) => this.project({lat, lng}));
    this.setView(route ? 'route' : 'all');
  }

  setRoute(route) {
    this.route = route;
    this.setView(route ? 'route' : 'all');
  }

  setView(view) {
    this.view = view;
    this.manuallyPositioned = false;
    this.fit();
  }

  resize() {
    const { width, height } = this.canvas.getBoundingClientRect();
    if (width === this.width && height === this.height) return;
    const ratio = Math.min(2.5, window.devicePixelRatio || 1);
    const first = !this.width;
    this.width = width;
    this.height = height;
    this.canvas.width = Math.round(width * ratio);
    this.canvas.height = Math.round(height * ratio);
    this.ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (first || !this.manuallyPositioned) this.fit();
    else this.scheduleDraw();
  }

  project({lat, lng}) {
    return {x: (lng - this.lng) * this.longitudeKm, y: (this.lat - lat) * 110.8};
  }

  screen(point) {
    return {x: (point.x - this.cx) * this.scale + this.width / 2,
      y: (point.y - this.cy) * this.scale + this.height / 2};
  }

  fit() {
    if (!this.points || !this.width) return;
    const routeView = this.view === 'route' && this.route;
    const points = routeView ? this.route.stops.flatMap(stop => stop.ids.map(id => this.points.get(id))) : [...this.points.values()];
    const xs = points.map(p => p.x), ys = points.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    this.cx = (minX + maxX) / 2;
    this.cy = (minY + maxY) / 2;
    const wide = this.width > 580;
    const padX = wide ? 170 : 75, padY = wide ? 130 : 83;
    const minSpan = this.network.id === 'moscow' && routeView ? (wide ? 8.3 : 5.1) : 2.6;
    this.scale = Math.max(2, Math.min(200, (this.width - padX) / Math.max(minSpan, maxX-minX),
      (this.height - padY) / Math.max(minSpan * 0.65,maxY-minY)));
    this.scheduleDraw();
  }

  locate(point, center = false) {
    this.position = this.project(point);
    if (center) {
      this.cx = this.position.x;
      this.cy = this.position.y;
      this.scale = Math.max(this.scale, 100);
      this.manuallyPositioned = true;
    }
    this.scheduleDraw();
  }

  setCurrent(id) {
    this.current = id;
    this.scheduleDraw();
  }

  zoom(factor, x = this.width / 2, y = this.height / 2, targetX = x, targetY = y) {
    const next = Math.max(2, Math.min(450,this.scale * factor));
    this.cx += (x - this.width / 2) / this.scale - (targetX - this.width / 2) / next;
    this.cy += (y - this.height / 2) / this.scale - (targetY - this.height / 2) / next;
    this.scale = next;
    this.manuallyPositioned = true;
    this.scheduleDraw();
  }

  local(event) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  handlePinch(event) {
    const first = event.targetTouches[0];
    const second = event.targetTouches[1];
    if (!second || !this.network) return;
    // Reserve the two-finger gesture and leave one-finger scrolling to the browser.
    if (event.cancelable) event.preventDefault();
    this.moved = true;
    const rect = this.canvas.getBoundingClientRect();
    const a = first.identifier < second.identifier ? first : second;
    const b = a === first ? second : first;
    const previous = this.pinch;
    const current = this.pinch = {
      first: a.identifier,
      second: b.identifier,
      x: (a.clientX + b.clientX) / 2 - rect.left,
      y: (a.clientY + b.clientY) / 2 - rect.top,
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
    };
    if (!previous || previous.first !== current.first || previous.second !== current.second
      || previous.distance < 8 || current.distance < 8) return;
    this.zoom(current.distance / previous.distance, previous.x, previous.y, current.x, current.y);
  }

  pointerDown(event) {
    if (!this.network || event.button !== 0) return;
    const point = this.local(event);
    if (!this.pointers.size) this.moved = false;
    else this.moved = true;
    this.pointers.set(event.pointerId, { ...point, startX: point.x, startY: point.y });
    if (this.interactive) this.canvas.setPointerCapture(event.pointerId);
  }

  pointerMove(event) {
    const current = this.local(event);
    const old = this.pointers.get(event.pointerId);
    if (!old) {
      if (event.pointerType !== 'mouse') return;
      const hover = this.hit(current, 12);
      if (hover === this.hover) return;
      this.hover = hover;
      this.canvas.classList.toggle('station-hover', Boolean(hover));
      this.scheduleDraw();
      return;
    }
    if (Math.hypot(current.x - old.startX, current.y - old.startY) > 5) this.moved = true;
    this.pointers.set(event.pointerId, { ...old, ...current });
    if (!this.moved || !this.interactive) return;
    if (event.pointerType === 'touch' && (this.pinch || this.pointers.size > 1)) return;
    this.canvas.classList.add('dragging');
    this.cx -= (current.x - old.x) / this.scale;
    this.cy -= (current.y - old.y) / this.scale;
    this.manuallyPositioned = true;
    this.scheduleDraw();
  }

  pointerEnd(event) {
    if (!this.pointers.delete(event.pointerId)) return;
    if (!this.pointers.size) this.canvas.classList.remove('dragging');
    if (event.type === 'pointerup' && !this.moved) {
      const station = this.hit(this.local(event), event.pointerType === 'touch' ? 25 : 14);
      if (station) this.onStation(station);
    }
  }

  hit(point, radius) {
    if (!this.points) return null;
    let nearest = radius, result = null;
    for (const [id, p] of this.points) {
      const screen = this.screen(p);
      const d = Math.hypot(screen.x - point.x, screen.y - point.y);
      if (d >= nearest) continue;
      nearest = d;
      result = id;
    }
    return result;
  }

  path(points, color, width, smooth = false) {
    if (points.length < 2) return;
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      const p = points[i], next = points[i+1];
      if (smooth && next) ctx.quadraticCurveTo(p.x, p.y, (p.x+next.x)/2, (p.y+next.y)/2);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  }

  dot(point, radius, fill, stroke, width = 1) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI*2);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width;
      ctx.stroke();
    }
  }

  draw() {
    if (!this.width || !this.height) return;
    const ctx = this.ctx;
    const { width, height } = this;
    ctx.clearRect(0,0,width,height);
    const bg = ctx.createRadialGradient(width*.44,height*.43,8,width*.46,height*.41,Math.max(width,height)*.74);
    bg.addColorStop(0,'#1a2938');
    bg.addColorStop(1,'#101a28');
    ctx.fillStyle = bg;
    ctx.fillRect(0,0,width,height);
    const grid = 27;
    const ox = ((-(this.cx * this.scale) + width/2) % grid + grid) % grid;
    const oy = ((-(this.cy * this.scale) + height/2) % grid + grid) % grid;
    ctx.beginPath();
    for (let x = ox; x < width; x += grid) { ctx.moveTo(x,0); ctx.lineTo(x,height); }
    for (let y = oy; y < height; y += grid) { ctx.moveTo(0,y); ctx.lineTo(width,y); }
    ctx.strokeStyle = '#57718a24';
    ctx.lineWidth = 1;
    ctx.stroke();
    if (!this.network) return;

    ctx.lineJoin = ctx.lineCap = 'round';
    const river = this.river.map(p => this.screen(p));
    if (river.length) {
      const riverWidth = Math.max(5, Math.min(105, this.scale * (this.network.id === 'moscow' ? .235 : .39)));
      this.path(river,'#34577570',riverWidth + 2,true);
      this.path(river,'#213e5a',riverWidth,true);
      this.path(river,'#294b69',Math.max(2,riverWidth - 6),true);
    }
    const screens = new Map([...this.points].map(([id,p]) => [id,this.screen(p)]));
    const highlight = this.route && this.view !== 'all';
    const routeIds = new Set(highlight ? this.route.stops.flatMap(stop => stop.ids) : []);
    for (const rail of this.network.rails) {
      const points = [screens.get(rail.from), screens.get(rail.to)];
      this.path(points,'#091522',highlight ? 7 : 8);
      this.path(points,rail.color+(highlight ? '64' : 'dc'),highlight ? 3.1 : 4.3);
    }
    for (const group of this.network.transfers) {
      const start = screens.get(group[0]);
      for (const id of group.slice(1)) this.path([start,screens.get(id)],highlight ? '#a8bbd075' : '#afc3d5b0',1.55);
    }
    const routeSegments = highlight ? this.route.segments.map(edge => ({
      points: [screens.get(edge.from),screens.get(edge.to)],
      color: this.network.stations.get(edge.from).line.color,
      transfer: edge.transfer,
    })) : [];
    for (const { points, color, transfer } of routeSegments) {
      this.path(points,transfer ? '#d7e3f12e' : color+'3f',15);
      this.path(points,'#091522',10);
    }
    for (const { points, color, transfer } of routeSegments) {
      if (transfer) {
        ctx.setLineDash([4, 5]);
        this.path(points,'#d7e3f1',3);
        ctx.setLineDash([]);
      } else {
        this.path(points,color,6);
      }
    }

    const stationRadius = this.scale < 22 ? 2.35 : 3.3;
    const visible = (p, pad = 8) => p.x >= pad && p.x <= width-pad && p.y >= pad && p.y <= height-pad;
    for (const [id,p] of screens) {
      if (!visible(p, 0) || routeIds.has(id)) continue;
      const s = this.network.stations.get(id);
      if (id === this.current || id === this.hover) this.dot(p,9,s.line.color+'48');
      if (s.transfer) this.dot(p,stationRadius+0.8,'#203142',highlight ? '#a9bace' : '#d7e3ef',1.4);
      else this.dot(p,stationRadius,'#172637',s.line.color+(highlight ? 'ba' : 'ff'),1.5);
    }
    for (const id of routeIds) {
      const p = screens.get(id);
      if (!visible(p, 0)) continue;
      const station = this.network.stations.get(id);
      const color = station.line.color;
      const end = id === this.route.first || id === this.route.last;
      const key = this.route.via.has(id) || station.transfer;
      if (end || id === this.current || id === this.hover) this.dot(p,end ? 12 : 9,color+'56');
      this.dot(p,end ? 7 : key ? 5.3 : 4.2,end ? color : '#142030',end ? '#e3ebf5' : color,2);
    }

    const labels = [];
    const added = new Set();
    const addLabel = (id, type) => {
      if (!id || added.has(id)) return;
      added.add(id);
      labels.push({id, type});
    };
    addLabel(this.hover,'active');
    addLabel(this.current,'active');
    if (highlight) {
      addLabel(this.route.first,'end');
      addLabel(this.route.last,'end');
      for (const stop of this.route.stops) {
        const id = stop.ids.find(id => this.route.via.has(id)) ?? stop.ids[0];
        addLabel(id,stop.transfer || this.route.via.has(id) ? 'key' : 'route');
      }
    }
    if (this.scale >= 29) {
      const display = [...this.network.stations.values()].sort((a,b) => Number(b.transfer) - Number(a.transfer));
      for (const s of display) addLabel(s.id, 'network');
    }
    const blocked = [{x:0,y:0,w:52,h:63},{x:width-67,y:height-195,w:67,h:195}];
    const drawnNames = new Set();
    const overlaps = (a,b) => a.x < b.x+b.w+4 && a.x+a.w+4 > b.x && a.y < b.y+b.h+3 && a.y+a.h+3 > b.y;
    for (const {id,type} of labels) {
      const p = screens.get(id);
      if (!visible(p)) continue;
      const s = this.network.stations.get(id);
      if (drawnNames.has(s.name) && type !== 'end') continue;
      const chip = type === 'end' || type === 'active';
      const size = chip ? 12 : type === 'network' ? 10 : 11;
      ctx.font = `${chip || type === 'key' ? 800 : 700} ${size}px Manrope, sans-serif`;
      const maxLabelWidth = width < 430 ? 125 : 166;
      let name = s.name;
      while (ctx.measureText(name).width > maxLabelWidth && name.length > 5) {
        name = name.endsWith('…') ? name.slice(0,-2)+'…' : name.slice(0,-1)+'…';
      }
      const w = ctx.measureText(name).width + (chip ? 17 : 2);
      const h = chip ? 25 : 14;
      const candidates = [
        {x:p.x+10,y:p.y-h/2,w,h}, {x:p.x-w-10,y:p.y-h/2,w,h},
        {x:p.x-w/2,y:p.y-h-9,w,h}, {x:p.x-w/2,y:p.y+9,w,h},
      ];
      const inside = r => r.x >= 5 && r.x+r.w <= width-5 && r.y >= 5 && r.y+r.h <= height-5;
      const label = candidates.find(r => inside(r) && !blocked.some(b => overlaps(b,r))) ?? (chip ? candidates.find(inside) : null);
      if (!label) continue;
      blocked.push(label);
      drawnNames.add(s.name);
      if (chip) {
        ctx.fillStyle = '#172431';
        ctx.strokeStyle = s.line.color+'cb';
        ctx.lineWidth = 1;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(label.x,label.y,label.w,label.h,6);
        else ctx.rect(label.x,label.y,label.w,label.h);
        ctx.fill();
        ctx.stroke();
      }
      ctx.textBaseline = 'middle';
      const textX = label.x + (chip ? 8 : 1), textY = label.y+h/2+.2;
      if (!chip) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#142030dc';
        ctx.strokeText(name,textX,textY);
      }
      ctx.fillStyle = type === 'network' ? '#aab9cc' : '#f1f4f8';
      ctx.fillText(name,textX,textY);
    }

    if (this.position) {
      const p = this.screen(this.position);
      this.dot(p,15,'#56a9ff38');
      this.dot(p,6,'#51a8fa','#e4f4ff',2);
    }
    const scaleWidth = Math.max(26,Math.min(100,this.scale * (this.scale > 155 ? 0.25 : this.scale > 74 ? 0.5 : this.scale > 28 ? 1 : 5)));
    const km = this.scale > 155 ? '250 м' : this.scale > 74 ? '500 м' : this.scale > 28 ? '1 км' : '5 км';
    const barWidth = this.scale * (parseInt(km) / (km.endsWith('км') ? 1 : 1000));
    if (Math.abs(barWidth-scaleWidth) < 0.5) {
      const x = 16, y = height-17;
      this.path([{x,y:y-4},{x,y},{x:x+barWidth,y},{x:x+barWidth,y:y-4}], '#9aacbf',1);
      ctx.fillStyle = '#a5b8ca';
      ctx.font = '700 10px Manrope, sans-serif';
      ctx.fillText(km,x,y-10);
    }
  }
}
