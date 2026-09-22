import type { MapNode } from '../types.js';
import { ageLabel, categoryLabel, colors, formatBytes, fileWord } from '../format.js';
import { ui } from '../i18n.js';
import { buildLayout, hitTest, zoomAt } from './layout.js';
import type { Camera, Circle, Layout } from './layout.js';

export interface MapCallbacks {
  select(ids: number[], additive: boolean): void;
  drill(node: MapNode): void;
  drag(active: boolean, x: number, y: number): void;
  drop(ids: number[], x: number, y: number): void;
  context(fileId: number, x: number, y: number): void;
  error(error: unknown): void;
}
interface Gesture { mode: 'pan' | 'select' | 'file'; startX: number; startY: number; x: number; y: number; circle: Circle | null; moved: boolean; additive: boolean }
export class FileMap {
  private ctx: CanvasRenderingContext2D;
  private layout: Layout = { circles: [], bands: [], radius: 300 };
  private camera: Camera = { x: 0, y: 0, scale: 1 };
  private selected = new Set<number>();
  private planned = new Set<number>();
  private hovered: Circle | null = null;
  private gesture: Gesture | null = null;
  private pointers = new Map<number, { x: number; y: number }>();
  private pinchDistance = 0;
  private request = 0;
  private width = 0;
  private height = 0;
  private observer: ResizeObserver;
  private events = new AbortController();
  private tooltip: HTMLDivElement;
  private fitted = false;
  private key = '';
  constructor(private canvas: HTMLCanvasElement, private callbacks: MapCallbacks) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error(ui('Карта недоступна: используйте список файлов.'));
    this.ctx = ctx;
    this.tooltip = document.createElement('div'); this.tooltip.className = 'map-tooltip'; this.tooltip.hidden = true;
    canvas.parentElement!.append(this.tooltip);
    const options = { signal: this.events.signal };
    canvas.addEventListener('pointerdown', (e) => this.down(e), options);
    canvas.addEventListener('pointermove', (e) => this.move(e), options);
    canvas.addEventListener('pointerup', (e) => this.up(e), options);
    canvas.addEventListener('pointercancel', () => this.cancelGesture(), options);
    canvas.addEventListener('lostpointercapture', () => { if (!this.pointers.size) this.cancelGesture(); }, options);
    canvas.addEventListener('pointerleave', () => { if (!this.gesture) { this.hovered = null; this.tooltip.hidden = true; this.invalidate(); } }, options);
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault(); const p = this.point(e); this.camera = zoomAt(this.camera, p.x, p.y, Math.exp(-Math.max(-150, Math.min(150, e.deltaY)) * 0.003)); this.tooltip.hidden = true; this.invalidate();
    }, { ...options, passive: false });
    canvas.addEventListener('dblclick', (e) => {
      const p = this.point(e), world = this.world(p.x, p.y), circle = hitTest(this.layout.circles, world.x, world.y, this.camera.scale);
      if (circle?.node.bucket) this.callbacks.drill(circle.node);
      else { this.camera = zoomAt(this.camera, p.x, p.y, 1.8); this.invalidate(); }
    }, options);
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const point = this.point(e), world = this.world(point.x, point.y);
      const circle = hitTest(this.layout.circles, world.x, world.y, this.camera.scale);
      if (circle?.node.fileId !== null && circle?.node.fileId !== undefined) this.callbacks.context(circle.node.fileId, e.clientX, e.clientY);
    }, options);
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(canvas.parentElement!);
    this.resize();
  }
  destroy(): void { this.events.abort(); this.observer.disconnect(); cancelAnimationFrame(this.request); this.tooltip.remove(); }
  setData(nodes: MapNode[], reset = false): void {
    const key = nodes.map((n) => `${n.key}:${n.bytes}:${n.duplicateGroup}:${n.ageBucket}:${n.category}:${n.screenshot}:${n.label}`).join('|');
    if (key !== this.key) {
      try { this.layout = buildLayout(nodes); this.key = key; }
      catch (error) { this.callbacks.error(error); return; }
    }
    if (reset || !this.fitted) this.fit();
    this.hovered = null; this.tooltip.hidden = true; this.invalidate();
  }
  setSelection(selected: Set<number>, planned: Set<number>): void { this.selected = selected; this.planned = planned; this.invalidate(); }
  fit(): void {
    this.camera = { x: this.width / 2, y: this.height / 2, scale: Math.min(this.width - 60, this.height - 35) / (this.layout.radius * 2) };
    this.camera.scale = Math.max(0.04, this.camera.scale); this.fitted = this.layout.circles.length > 0; this.invalidate();
  }
  zoom(factor: number): void { this.camera = zoomAt(this.camera, this.width / 2, this.height / 2, factor); this.invalidate(); }
  visibleIds(): number[] {
    return this.layout.circles.filter((c) => c.node.fileId !== null && c.x * this.camera.scale + this.camera.x >= 0 && c.x * this.camera.scale + this.camera.x <= this.width
      && c.y * this.camera.scale + this.camera.y >= 0 && c.y * this.camera.scale + this.camera.y <= this.height).map((c) => c.node.fileId!);
  }
  private resize(): void {
    const rect = this.canvas.parentElement!.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const oldWidth = this.width, oldHeight = this.height;
    this.width = rect.width; this.height = rect.height;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(this.width * ratio); this.canvas.height = Math.round(this.height * ratio);
    this.canvas.style.width = `${this.width}px`; this.canvas.style.height = `${this.height}px`;
    if (oldWidth === 0) this.fit();
    else { this.camera.x += (this.width - oldWidth) / 2; this.camera.y += (this.height - oldHeight) / 2; }
    this.invalidate();
  }
  private invalidate(): void {
    if (this.request) return;
    this.request = requestAnimationFrame(() => { this.request = 0; this.draw(); });
  }
  private point(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect(); return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  private world(x: number, y: number): { x: number; y: number } { return { x: (x - this.camera.x) / this.camera.scale, y: (y - this.camera.y) / this.camera.scale }; }
  private down(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    const p = this.point(e); this.pointers.set(e.pointerId, p); this.canvas.setPointerCapture(e.pointerId); this.tooltip.hidden = true;
    if (this.pointers.size > 1) {
      this.gesture = null; this.callbacks.drag(false, 0, 0);
      const [a, b] = [...this.pointers.values()]; this.pinchDistance = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; return;
    }
    const world = this.world(p.x, p.y), circle = hitTest(this.layout.circles, world.x, world.y, this.camera.scale);
    const mode = e.shiftKey && e.button === 0 ? 'select' : circle && e.button === 0 ? 'file' : 'pan';
    this.gesture = { mode, startX: p.x, startY: p.y, x: p.x, y: p.y, circle, moved: false, additive: e.ctrlKey || e.metaKey || e.shiftKey };
    this.canvas.style.cursor = mode === 'pan' ? 'grabbing' : mode === 'select' ? 'crosshair' : 'grab';
  }
  private move(e: PointerEvent): void {
    const p = this.point(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
    if (this.pointers.size > 1) {
      const [a, b] = [...this.pointers.values()];
      if (a && b) {
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (this.pinchDistance > 0) this.camera = zoomAt(this.camera, (a.x + b.x) / 2, (a.y + b.y) / 2, distance / this.pinchDistance);
        this.pinchDistance = distance; this.invalidate();
      }
      return;
    }
    const g = this.gesture;
    if (g) {
      const moved = Math.hypot(p.x - g.startX, p.y - g.startY) > 5;
      if (moved && !g.moved && g.mode === 'file' && g.circle?.node.fileId !== null && g.circle?.node.fileId !== undefined) {
        if (!this.selected.has(g.circle.node.fileId)) this.callbacks.select([g.circle.node.fileId], false);
      }
      g.moved ||= moved;
      if (g.mode === 'pan') { this.camera.x += p.x - g.x; this.camera.y += p.y - g.y; }
      if (g.mode === 'file' && g.moved && g.circle?.node.fileId !== null) this.callbacks.drag(true, e.clientX, e.clientY);
      g.x = p.x; g.y = p.y; this.invalidate(); return;
    }
    const world = this.world(p.x, p.y), circle = hitTest(this.layout.circles, world.x, world.y, this.camera.scale);
    if (circle !== this.hovered) { this.hovered = circle; this.invalidate(); }
    this.canvas.style.cursor = circle ? 'pointer' : 'grab';
    this.tooltip.hidden = !circle;
    if (circle) {
      this.tooltip.textContent = `${circle.node.bucket ? circle.node.count + ' ' + fileWord(circle.node.count) : circle.node.label}\n${formatBytes(circle.node.bytes)} · ${categoryLabel(circle.node.category)}\n${ageLabel(circle.node.ageBucket)}${circle.node.bucket ? ui(' · Нажмите, чтобы раскрыть') : ''}`;
      this.tooltip.style.left = `${Math.max(8, Math.min(p.x + 16, this.width - 260))}px`;
      this.tooltip.style.top = `${Math.max(8, Math.min(p.y + 16, this.height - 90))}px`;
    }
  }
  private up(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size) { this.gesture = null; return; }
    const g = this.gesture; this.gesture = null; this.canvas.style.cursor = 'grab';
    if (!g) return;
    if (g.mode === 'select' && g.moved) {
      const a = this.world(g.startX, g.startY), b = this.world(g.x, g.y);
      const ids = this.layout.circles.filter((c) => c.node.fileId !== null && c.x >= Math.min(a.x, b.x) && c.x <= Math.max(a.x, b.x) && c.y >= Math.min(a.y, b.y) && c.y <= Math.max(a.y, b.y)).map((c) => c.node.fileId!);
      this.callbacks.select(ids, g.additive);
    } else if (g.mode === 'file' && g.moved && g.circle?.node.fileId !== null && g.circle?.node.fileId !== undefined) {
      this.callbacks.drop([...this.selected], e.clientX, e.clientY);
    } else if (!g.moved) {
      if (g.circle?.node.bucket) this.callbacks.drill(g.circle.node);
      else if (g.circle?.node.fileId !== undefined && g.circle.node.fileId !== null) this.callbacks.select([g.circle.node.fileId], g.additive);
      else this.callbacks.select([], false);
    }
    this.callbacks.drag(false, 0, 0); this.invalidate();
  }
  private cancelGesture(): void { this.gesture = null; this.pointers.clear(); this.pinchDistance = 0; this.canvas.style.cursor = 'grab'; this.callbacks.drag(false, 0, 0); this.invalidate(); }
  private draw(): void {
    const ctx = this.ctx, { x, y, scale } = this.camera;
    const dpr = this.canvas.width / Math.max(1, this.width);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#fcfaf5'; ctx.fillRect(0, 0, this.width, this.height);
    ctx.save(); ctx.translate(x, y); ctx.scale(scale, scale);
    for (const band of this.layout.bands) {
      ctx.beginPath(); ctx.arc(0, 0, band.outer, 0, Math.PI * 2); ctx.strokeStyle = '#d5ded0'; ctx.lineWidth = 1 / scale; ctx.setLineDash([2 / scale, 7 / scale]); ctx.stroke();
    }
    ctx.setLineDash([]);
    // An explicit centre mark; unknown dates are labelled separately in the legend.
    ctx.beginPath(); ctx.arc(0, 0, 3 / scale, 0, Math.PI * 2); ctx.fillStyle = '#92a68a'; ctx.fill();
    const duplicateAnchors = new Map<number, Circle>();
    for (const circle of this.layout.circles) {
      if (circle.node.duplicateGroup === null) continue;
      const first = duplicateAnchors.get(circle.node.duplicateGroup);
      if (first) {
        ctx.beginPath(); ctx.moveTo(first.x, first.y); ctx.lineTo(circle.x, circle.y); ctx.strokeStyle = '#becf9380'; ctx.lineWidth = 1 / scale; ctx.setLineDash([4 / scale, 4 / scale]); ctx.stroke(); ctx.setLineDash([]);
      } else duplicateAnchors.set(circle.node.duplicateGroup, circle);
    }
    for (const c of this.layout.circles) {
      const sx = c.x * scale + x, sy = c.y * scale + y;
      if (sx + c.r * scale < -5 || sx - c.r * scale > this.width + 5 || sy + c.r * scale < -5 || sy - c.r * scale > this.height + 5) continue;
      const selected = c.node.fileId !== null && this.selected.has(c.node.fileId);
      const planned = c.node.fileId !== null && this.planned.has(c.node.fileId);
      const hovering = this.hovered === c;
      // Subpixel files are navigation dots, not a claim about occupied area.
      const radius = Math.max(c.r, 1 / scale);
      ctx.globalAlpha = planned ? 0.24 : 1;
      ctx.beginPath(); ctx.arc(c.x, c.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = c.node.bucket ? `${colors[c.node.category]}35` : colors[c.node.category];
      if (c.node.bytes > 0) ctx.fill();
      if (c.node.bucket || c.node.bytes === 0) { ctx.strokeStyle = colors[c.node.category]; ctx.lineWidth = 1.2 / scale; ctx.setLineDash(c.node.bucket ? [3 / scale, 3 / scale] : []); ctx.stroke(); ctx.setLineDash([]); }
      ctx.globalAlpha = 1;
      if (selected || hovering) {
        ctx.beginPath(); ctx.arc(c.x, c.y, radius + 4 / scale, 0, Math.PI * 2); ctx.strokeStyle = selected ? '#6d8e4d' : '#91a885'; ctx.lineWidth = (selected ? 2 : 1) / scale; ctx.stroke();
      }
      if (c.node.duplicateGroup !== null && radius * scale > 9) {
        ctx.beginPath(); ctx.arc(c.x, c.y, radius - 4 / scale, 0, Math.PI * 2); ctx.strokeStyle = '#ffffff90'; ctx.lineWidth = 1 / scale; ctx.stroke();
      }
      if (radius * scale > 26) {
        ctx.fillStyle = c.node.bucket ? '#51664a' : '#263a24';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `600 ${Math.min(13, radius * scale / 3) / scale}px system-ui, sans-serif`;
        const text = formatBytes(c.node.bytes); ctx.fillText(text, c.x, c.y - (radius * scale > 43 ? 8 / scale : 0), radius * 1.75);
        if (radius * scale > 43) {
          ctx.font = `${11 / scale}px system-ui, sans-serif`;
          const label = c.node.bucket ? `${c.node.count} ${fileWord(c.node.count)}` : c.node.label;
          const max = Math.floor(radius * scale * 1.65 / 6);
          ctx.fillText(label.length > max ? `${label.slice(0, Math.max(1, max - 1))}…` : label, c.x, c.y + 12 / scale, radius * 1.8);
        }
      }
    }
    ctx.restore();
    // Labels remain legible at any zoom, separate from the scaled map geometry.
    ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = '#70816b'; ctx.textAlign = 'center';
    if (scale < 0.9) {
      for (const b of this.layout.bands) {
        const py = y + b.outer * scale;
        if (py > 20 && py < this.height - 12) { ctx.fillStyle = '#fcfaf5'; ctx.fillRect(x - 63, py - 7, 126, 15); ctx.fillStyle = '#70816b'; ctx.fillText(ageLabel(b.age), x, py + 4); }
      }
    }
    // At the overview scale, identify dominant files without forcing text into
    // small circles. Labels are annotations, not extra area representing bytes.
    if (scale < 0.55 && this.width > 850) {
      const sides: [Circle[], Circle[]] = [[], []];
      const largest = [...this.layout.circles].filter((c) => c.node.fileId !== null && c.node.bytes > 0)
        .sort((a, b) => b.node.bytes - a.node.bytes).slice(0, 4);
      for (const c of largest) sides[c.x < 0 ? 0 : 1].push(c);
      for (let side = 0; side < sides.length; side++) {
        const rows = sides[side]!; rows.sort((a, b) => a.y - b.y);
        let lastY = 18;
        for (const c of rows) {
          const sx = c.x * scale + x, sy = c.y * scale + y;
          if (sx < 0 || sx > this.width || sy < 0 || sy > this.height) continue;
          const py = Math.max(lastY + 39, Math.min(this.height - 30, sy)); lastY = py;
          const edge = side === 0 ? 30 : this.width - 30;
          const lineEnd = side === 0 ? 195 : this.width - 195;
          ctx.strokeStyle = `${colors[c.node.category]}60`; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(sx + (side === 0 ? -1 : 1) * (c.r * scale + 4), sy);
          ctx.lineTo(lineEnd, py - 5); ctx.lineTo(edge, py - 5); ctx.stroke();
          ctx.textAlign = side === 0 ? 'left' : 'right';
          ctx.fillStyle = '#40543a'; ctx.font = '11px system-ui, sans-serif';
          const label = c.node.label.length > 31 ? `${c.node.label.slice(0, 30)}…` : c.node.label;
          ctx.fillText(label, edge, py - 13, 200);
          ctx.fillStyle = colors[c.node.category]; ctx.font = '600 12px system-ui, sans-serif';
          ctx.fillText(formatBytes(c.node.bytes), edge, py + 12);
        }
      }
    }
    if (this.gesture?.mode === 'select' && this.gesture.moved) {
      const g = this.gesture; ctx.fillStyle = '#b5c98b1a'; ctx.strokeStyle = '#b5c98b'; ctx.lineWidth = 1;
      ctx.fillRect(g.startX, g.startY, g.x - g.startX, g.y - g.startY); ctx.strokeRect(g.startX, g.startY, g.x - g.startX, g.y - g.startY);
    }
  }
}
