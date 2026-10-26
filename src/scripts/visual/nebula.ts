import { Renderer, Program, Mesh, Triangle } from "ogl";

const vertex = `attribute vec2 uv; attribute vec2 position; varying vec2 vUv;
void main(){vUv=uv;gl_Position=vec4(position,0.,1.);}`;
const fragment = `precision highp float;
varying vec2 vUv;
uniform float uTime; uniform float uAspect; uniform float uScroll; uniform float uLight;
uniform vec2 uPointer;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+1.),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.55;for(int i=0;i<4;i++){v+=noise(p)*a;p=mat2(1.6,1.2,-1.2,1.6)*p+4.1;a*=.5;}return v;}
void main(){
 vec2 p=(vUv-.5)*vec2(uAspect,1.);p-=uPointer*.065;
 float t=uTime*.035;float radius=length(p);float angle=atan(p.y,p.x);
 vec2 flow=vec2(sin(angle+t*.12+radius*1.4)*1.6+radius*3.-t,cos(angle+t*.12+radius*1.4)*1.6+radius*4.-t*.7+uScroll*.3);
 float clouds=fbm(flow+fbm(p*3.+t));
 float ribbon=pow(max(0.,1.-abs(radius-.27-clouds*.14)*4.2),2.);
 float wisps=smoothstep(.32,.83,clouds)*ribbon;
 float center=exp(-radius*radius*12.);
 vec3 mint=vec3(.15,.88,.72), violet=vec3(.43,.28,.9), blue=vec3(.12,.4,.85);
 vec3 color=mix(blue,violet,smoothstep(-.5,.6,p.x+p.y));
 color=mix(color,mint,smoothstep(.25,.8,clouds));
 color*=wisps*1.45+center*.12;
 float dust=0.;
 for(int i=0;i<2;i++){
  float layer=float(i)+1.;vec2 sp=(p+uPointer*.015*layer+vec2(t*.025*layer,0.))*vec2(90.,80.)/layer;
  vec2 cell=floor(sp);vec2 local=fract(sp)-.5;float h=hash(cell+layer*10.);
  float star=(1.-smoothstep(0.,.07,length(local)))*step(.975,h);
  dust+=star*(.55+.45*sin(uTime*.45+h*50.))*layer*.55;
 }
 color+=vec3(.66,.85,.97)*dust;
 float vignette=1.-smoothstep(.25,.74,radius);
 float alpha=clamp((wisps*.88+center*.18+dust)*vignette,0.,.85);
 color=mix(color,color*.48,uLight);
 gl_FragColor=vec4(color,alpha);
}`;

/** OGL owns GPU resources; the page runtime alone owns the animation clock. */
export function mountNebula(host: HTMLElement, failed: () => void) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  const renderer = new Renderer({
    canvas,
    alpha: true,
    antialias: false,
    depth: false,
    dpr: Math.min(devicePixelRatio, 1.4),
    powerPreference: "low-power",
  });
  const gl = renderer.gl;
  if (!gl) throw new Error("WebGL unavailable");
  const geometry = new Triangle(gl);
  const uniforms = {
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uScroll: { value: 0 },
    uLight: { value: 0 },
    uPointer: { value: [0, 0] },
  };
  const program = new Program(gl, {
    vertex,
    fragment,
    uniforms,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  if (!gl.getProgramParameter(program.program, gl.LINK_STATUS)) {
    program.remove();
    geometry.remove();
    throw new Error("Shader unavailable");
  }
  const mesh = new Mesh(gl, { geometry, program });
  let disposed = false;
  let lastDraw = -1;
  let elapsed = 0;
  let previousTime = 0;
  const pointer = [0, 0];
  const resize = () => {
    if (disposed) return;
    const rect = host.getBoundingClientRect();
    renderer.setSize(
      Math.max(1, Math.min(rect.width, 900)),
      Math.max(1, Math.min(rect.height, 650)),
    );
    uniforms.uAspect.value = rect.width / Math.max(rect.height, 1);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();
  const lost = (event: Event) => {
    event.preventDefault();
    failed();
  };
  canvas.addEventListener("webglcontextlost", lost);
  host.append(canvas);
  return {
    pointer(x: number, y: number) {
      pointer[0] = x;
      pointer[1] = y;
    },
    pause() {
      previousTime = 0;
    },
    render(time: number) {
      if (disposed || gl.isContextLost() || time - lastDraw < 1 / 30) return;
      elapsed += previousTime ? Math.min(time - previousTime, 0.06) : 0;
      previousTime = time;
      lastDraw = time;
      uniforms.uTime.value = elapsed;
      uniforms.uScroll.value = Math.min(scrollY / Math.max(innerHeight, 1), 2);
      uniforms.uLight.value =
        document.documentElement.dataset.theme === "light" ? 1 : 0;
      uniforms.uPointer.value[0] +=
        (pointer[0] - uniforms.uPointer.value[0]) * 0.065;
      uniforms.uPointer.value[1] +=
        (pointer[1] - uniforms.uPointer.value[1]) * 0.065;
      renderer.render({ scene: mesh });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      canvas.removeEventListener("webglcontextlost", lost);
      geometry.remove();
      program.remove();
      canvas.remove();
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
