// Each 3D scene owns a separate window: upstream RPG Maker prototype patches never
// affect the multiplayer client. The server remains the only world simulator.
export class ThreeDLayer {
  constructor({onError = () => {}, onStatus = () => {}} = {}) {
    this.onError = onError; this.onStatus = onStatus;
    this.generation = 0; this.status = 'off'; this.queue = []; this.commandTail = Promise.resolve();
  }
  setStatus(status) { this.status = status; this.onStatus(status); }
  async load(payload) {
    this.dispose();
    const generation = this.generation;
    this.payload = payload; this.enabled = true; this.setStatus('loading');
    const frame = document.createElement('iframe');
    frame.title = '3D render runtime'; frame.setAttribute('aria-hidden', 'true'); frame.tabIndex = -1;
    // Keep a layout viewport for Babylon while preventing input and visibility.
    frame.style.cssText = 'position:fixed;left:-20000px;top:0;width:816px;height:624px;border:0;pointer-events:none';
    this.frame = frame;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('3D 渲染运行库加载超时')), 30000);
        this.cancelLoad = () => { clearTimeout(timer); resolve(); };
        frame.onload = () => {clearTimeout(timer); resolve();};
        frame.onerror = () => {clearTimeout(timer); reject(new Error('无法加载 3D 渲染运行库'));};
        frame.src = '/client/three-d-host.html'; document.body.append(frame);
      });
      if (generation !== this.generation) return;
      const host = frame.contentWindow.threeDHost;
      if (!host) throw new Error('3D 渲染宿主未初始化');
      this.host = host;
      await host.load(payload);
      if (generation !== this.generation) {host.dispose(); return;}
      this.setStatus('ready');
      for (const command of this.queue.splice(0)) this.command(command);
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    }
  }
  fail(error) {
    if (this.status === 'error') return;
    this.error = String(error?.message || error); this.setStatus('error'); this.onError(this.error);
  }
  draw({ctx, width, height, entities, snapshot, center, zoom, time, appearance}) {
    if (this.status !== 'ready') return false;
    try {
      this.host.resize(Math.round(width), Math.round(height));
      this.host.update({entities, snapshot, center, zoom, time, appearance});
      const canvas = this.host.canvas || this.frame.contentWindow.mv3d?.canvas;
      if (canvas?.width) ctx.drawImage(canvas, 0, 0, width / zoom, height / zoom);
      return !!canvas?.width;
    } catch (error) {this.fail(error); return false;}
  }
  command(message) {
    if (!this.enabled) return;
    if (this.status === 'ready') {
      const generation=this.generation,host=this.host;
      // Upstream commands may await a character/material. Preserve event order
      // when the next command changes that same light, camera or configuration.
      this.commandTail=this.commandTail.then(()=>{
        if(generation===this.generation&&this.status==='ready')return host.command(message);
      }).catch(error=>{if(generation===this.generation)this.fail(error);});
      return this.commandTail;
    } else if (this.status === 'loading' && this.queue.length < 100) this.queue.push(message);
  }
  project(x, y, z) {
    if (this.status !== 'ready') return null;
    try {return this.host.project(x, y, z);} catch {return null;}
  }
  projectEntity(id) {
    if (this.status!=='ready') return null;
    try {return this.host.projectEntity?.(id);} catch {return null;}
  }
  pick(x, y) {
    if (this.status !== 'ready') return null;
    try {return this.host.pick(x, y);} catch {return null;}
  }
  orbit(yaw = 0, pitch = 0) {
    if (yaw) this.command({command:`camera yaw +${yaw} 0.2`});
    if (pitch) this.command({command:`camera pitch +${pitch} 0.2`});
  }
  inputDirection(direction) {
    if(this.status!=='ready')return direction;
    const runtime=this.frame.contentWindow.mv3d;
    // Network movement remains four-directional; apply the original camera yaw
    // transform before sending the world-space intention to the server.
    return runtime.transformDirection(direction,runtime.blendCameraYaw.currentValue(),false);
  }
  dispose() {
    this.generation++; this.cancelLoad?.(); this.cancelLoad = null;
    try {this.host?.dispose();} catch { /* An already-removed frame may be unloaded. */ }
    this.frame?.remove(); this.frame = this.host = null; this.queue = []; this.commandTail = Promise.resolve();
    this.enabled = false; this.error = null; this.setStatus('off');
  }
}
